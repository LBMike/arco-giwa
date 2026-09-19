// Local UI verification only. No HTTP endpoint, external wallet, keys, retries or fallback.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decodeFunctionData, encodeFunctionData, parseAbi, stringToHex } from 'viem';
import { SiweMessage } from 'siwe';

const abi = parseAbi([
  'function approve(address spender,uint256 amount) returns (bool)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function depositForOrder(bytes32 orderKey,uint256 amount)',
  'function escrowForOrder(bytes32 orderKey,address token,uint256 quantity)',
]);
const fail = () => { throw Object.assign(new Error('LOCAL_WALLET_REQUEST_REFUSED'), { code: -32602 }); };
const same = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

export async function createLocalWallet({ rpc, rpcUrl, manifest, accounts, frontendOrigin, operatorLogin = false }) {
  assert.equal(process.env.STOCKS_LOCAL_STACK_ONLY, '1');
  const url = new URL(rpcUrl);
  assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.pathname === '/'
    && !url.username && !url.password && !url.search && !url.hash && !/[?#]/.test(rpcUrl));
  const origin = new URL(frontendOrigin);
  assert.equal(origin.origin, frontendOrigin);
  const m = Object.freeze(structuredClone(manifest));
  assert.equal(typeof operatorLogin, 'boolean');
  const allowedAccounts = [accounts.holder, accounts.otherHolder, ...(operatorLogin ? [accounts.operator] : [])].map(value => value.toLowerCase());
  assert.equal(await rpc('eth_chainId', []), '0x164ce');
  const metadata = await rpc('hardhat_metadata', []);
  assert.ok(metadata.instanceId && !metadata.forkedNetwork);
  assert.equal(m.networkInstance, `hardhat-${createHash('sha256').update(metadata.instanceId).digest('hex')}`);
  const checkpoint = await rpc('eth_getBlockByNumber', [`0x${BigInt(m.checkpointNumber).toString(16)}`, false]);
  assert.equal(checkpoint.hash.toLowerCase(), m.checkpointHash.toLowerCase());

  let account = allowedAccounts[0], closed = false, nextHold;
  const calls = [], sends = [], listeners = new Map(), holds = new Set();
  function checkAccount(value) { if (!account || !same(value, account)) fail(); }
  function decoded(to, data, read = false) {
    if (typeof to !== 'string' || typeof data !== 'string') fail();
    let parsed;
    try { parsed = decodeFunctionData({ abi, data }); } catch { fail(); }
    if (encodeFunctionData({ abi, ...parsed }).toLowerCase() !== data.toLowerCase()) fail();
    const args = parsed.args;
    const cashPair = same(to, m.cashToken), stockPair = same(to, m.stockToken);
    if (read) {
      if (parsed.functionName !== 'allowance') fail();
      checkAccount(args[0]);
      if (!(cashPair && same(args[1], m.fundingVault)) && !(stockPair && same(args[1], m.redemptionEscrow))) fail();
    } else if (parsed.functionName === 'approve') {
      if (args[1] <= 0n || (!(cashPair && same(args[0], m.fundingVault)) && !(stockPair && same(args[0], m.redemptionEscrow)))) fail();
    } else if (parsed.functionName === 'depositForOrder') {
      if (!same(to, m.fundingVault) || /^0x0+$/.test(args[0]) || args[1] <= 0n) fail();
    } else if (parsed.functionName === 'escrowForOrder') {
      if (!same(to, m.redemptionEscrow) || /^0x0+$/.test(args[0]) || !same(args[1], m.stockToken) || args[2] <= 0n) fail();
    } else fail();
  }
  function request({ method, params = [] }) {
    if (closed || !Array.isArray(params)) fail();
    // The optional operator is for real SIWE login and read-only UI verification.
    // Never grant it transaction or contract-call capability through this bridge.
    if (operatorLogin && same(account, accounts.operator) && !['eth_accounts', 'eth_chainId', 'personal_sign'].includes(method)) fail();
    const at = Date.now();
    if (method === 'eth_accounts') {
      if (params.length) fail();
      calls.push({ method, at });
      return Promise.resolve(account ? [account] : []);
    }
    if (method === 'eth_chainId') {
      if (params.length) fail();
    } else if (method === 'eth_getBlockByNumber') {
      if (params.length !== 2 || params[0] !== `0x${BigInt(m.checkpointNumber).toString(16)}` || params[1] !== false) fail();
    } else if (method === 'eth_call') {
      if (params.length !== 2 || params[1] !== 'latest' || !params[0] || Object.keys(params[0]).sort().join() !== 'data,to') fail();
      decoded(params[0].to, params[0].data, true);
    } else if (method === 'personal_sign') {
      if (params.length !== 2 || typeof params[0] !== 'string') fail();
      checkAccount(params[1]);
      let message;
      try { message = new SiweMessage(params[0]); } catch { fail(); }
      if (message.chainId !== 91342 || message.domain !== origin.host || message.uri !== frontendOrigin || !same(message.address, account)) fail();
      params = [stringToHex(params[0]), account];
    } else if (method === 'eth_sendTransaction') {
      const tx = params[0];
      if (params.length !== 1 || !tx || Object.keys(tx).sort().join() !== 'data,from,to,value' || tx.value !== '0x0') fail();
      checkAccount(tx.from);
      decoded(tx.to, tx.data);
      const transaction = Object.freeze({ ...tx });
      const row = { transaction, startedAt: at, hash: null, outcome: 'PENDING' };
      const hold = nextHold; nextHold = undefined;
      sends.push(row); calls.push({ method, at, sendIndex: sends.length - 1 });
      // Deliberately synchronous up to the single RPC invocation. Provider response
      // loss happens AFTER node acceptance; never repeat this invocation.
      const pending = rpc(method, [transaction]);
      return pending.then(async hash => {
        row.hash = hash; row.acceptedAt = Date.now();
        if (hold) {
          hold.arrive({ hash, transaction });
          await hold.wait;
          holds.delete(hold);
        }
        if (closed) throw Object.assign(new Error('LOCAL_WALLET_CLOSED'), { code: -32603 });
        row.outcome = 'RETURNED';
        return hash;
      }).catch(error => {
        row.outcome = 'REJECTED';
        if (hold) { hold.arrive({ error: 'LOCAL_WALLET_SEND_FAILED' }); holds.delete(hold); }
        throw error;
      });
    } else fail();
    calls.push({ method, at });
    return rpc(method, structuredClone(params));
  }
  const provider = Object.freeze({ request,
    on(event, fn) { let set = listeners.get(event); if (!set) listeners.set(event, set = new Set()); set.add(fn); return provider; },
    removeListener(event, fn) { listeners.get(event)?.delete(fn); return provider; },
  });
  return {
    provider,
    get account() { return account; },
    get calls() { return structuredClone(calls); },
    get sends() { return structuredClone(sends); },
    setAccount(value) {
      if (closed || (value !== null && (typeof value !== 'string' || !allowedAccounts.includes(value.toLowerCase())))) fail();
      account = value === null ? null : value.toLowerCase();
      for (const fn of [...(listeners.get('accountsChanged') ?? [])]) fn(account ? [account] : []);
    },
    holdNextSend() {
      if (closed || nextHold) fail();
      let arrive, release, reject;
      const arrived = new Promise(resolve => { arrive = resolve; });
      const wait = new Promise((resolve, no) => { release = resolve; reject = no; });
      void wait.catch(() => {});
      const hold = { arrive, wait, release, drop: () => reject(Object.assign(new Error('LOCAL_WALLET_RESPONSE_LOST'), { code: -32603 })) };
      nextHold = hold; holds.add(hold);
      return { arrived, release, drop: hold.drop };
    },
    close() {
      if (closed) return;
      closed = true; listeners.clear();
      for (const hold of holds) hold.drop();
      holds.clear(); nextHold = undefined;
    },
  };
}
