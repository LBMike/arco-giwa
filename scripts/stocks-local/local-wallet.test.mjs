import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeFunctionData, parseAbi } from 'viem';
import { SiweMessage } from 'siwe';
import { createLocalWallet } from './local-wallet.mjs';

process.env.STOCKS_LOCAL_STACK_ONLY = '1';
const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const holder = address(1), otherHolder = address(2), operator = address(3), hash = `0x${'a'.repeat(64)}`;
const manifest = { networkInstance: `hardhat-${createHash('sha256').update('owned-node').digest('hex')}`, checkpointNumber: '5', checkpointHash: hash,
  cashToken: address(4), stockToken: address(5), fundingVault: address(6), redemptionEscrow: address(7) };
const abi = parseAbi(['function approve(address,uint256)']);
const tx = { from: holder, to: manifest.cashToken, value: '0x0', data: encodeFunctionData({ abi, functionName: 'approve', args: [manifest.fundingVault, 120000000n] }) };
async function fixture(override = {}) {
  const calls = [];
  const rpc = (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_chainId') return Promise.resolve('0x164ce');
    if (method === 'hardhat_metadata') return Promise.resolve({ instanceId: 'owned-node' });
    if (method === 'eth_getBlockByNumber') return Promise.resolve({ hash });
    if (method === 'eth_sendTransaction') return Promise.resolve(hash);
    if (method === 'personal_sign') return Promise.resolve(`0x${'b'.repeat(130)}`);
    throw new Error('UNEXPECTED_RPC');
  };
  const wallet = await createLocalWallet({ rpc, rpcUrl: 'http://127.0.0.1:12345', manifest, accounts: { holder, otherHolder, operator }, frontendOrigin: 'http://stocks-local.test', ...override });
  calls.length = 0;
  return { wallet, calls };
}
test('local wallet cannot dispatch arbitrary methods, operator accounts or extra transaction fields', async () => {
  const { wallet, calls } = await fixture();
  try {
    for (const method of ['wallet_sendTransaction', 'eth_sendRawTransaction', 'eth_estimateGas', 'hardhat_setCode', 'eth_requestAccounts'])
      assert.throws(() => wallet.provider.request({ method, params: [] }), /REFUSED/);
    for (const invalid of [{ ...tx, gas: '0x100000' }, { ...tx, from: operator }, { ...tx, to: address(9) }, { ...tx, value: '0x1' },
      { ...tx, data: `${tx.data}00` }, { ...tx, data: encodeFunctionData({ abi, functionName: 'approve', args: [operator, 120n] }) }])
      assert.throws(() => wallet.provider.request({ method: 'eth_sendTransaction', params: [invalid] }), /REFUSED/);
    assert.throws(() => wallet.setAccount(operator), /REFUSED/);
    assert.equal(calls.length, 0);
  } finally { wallet.close(); }
});
test('single RPC starts synchronously; held lost acknowledgement never resends and still records test evidence', async () => {
  const { wallet, calls } = await fixture();
  try {
    const hold = wallet.holdNextSend();
    const result = wallet.provider.request({ method: 'eth_sendTransaction', params: [tx] });
    assert.equal(calls.length, 1, 'No async preflight between final caller check and dispatch');
    assert.equal(calls[0].method, 'eth_sendTransaction');
    assert.deepEqual(calls[0].params, [tx], 'No gas/nonce rewrite');
    const rejected = assert.rejects(result, /RESPONSE_LOST/);
    assert.equal((await hold.arrived).hash, hash);
    wallet.setAccount(otherHolder);
    hold.drop(); await rejected;
    assert.equal(calls.length, 1); assert.equal(wallet.sends.length, 1);
    assert.equal(wallet.sends[0].hash, hash); assert.equal(wallet.sends[0].outcome, 'REJECTED');
  } finally { wallet.close(); }
});
test('SIWE personal_sign is restricted to this origin, chain and active test account', async () => {
  const { wallet, calls } = await fixture();
  const message = options => new SiweMessage({ domain: 'stocks-local.test', address: holder, uri: 'http://stocks-local.test', chainId: 91342,
    version: '1', nonce: 'abcdefghi', issuedAt: new Date().toISOString(), ...options }).prepareMessage();
  try {
    for (const invalid of [message({ domain: 'foreign.test' }), message({ chainId: 1 }), 'sign arbitrary bytes'])
      assert.throws(() => wallet.provider.request({ method: 'personal_sign', params: [invalid, holder] }), /REFUSED/);
    assert.equal(calls.length, 0);
    await wallet.provider.request({ method: 'personal_sign', params: [message({}), holder] });
    assert.equal(calls.length, 1); assert.match(calls[0].params[0], /^0x/); assert.equal(calls[0].params[1], holder);
  } finally { wallet.close(); }
});
test('startup refuses public/ambiguous RPC and a different checkpoint; close stops future calls', async () => {
  for (const rpcUrl of ['https://example.org', 'http://localhost:12345', 'http://127.0.0.1:12345?', 'http://127.0.0.1:12345#', 'http://u@127.0.0.1:12345'])
    await assert.rejects(fixture({ rpcUrl }));
  await assert.rejects(fixture({ manifest: { ...manifest, checkpointHash: `0x${'c'.repeat(64)}` } }));
  const { wallet, calls } = await fixture(); wallet.close(); wallet.close();
  assert.throws(() => wallet.provider.request({ method: 'eth_sendTransaction', params: [tx] }), /REFUSED/);
  assert.equal(calls.length, 0);
});
