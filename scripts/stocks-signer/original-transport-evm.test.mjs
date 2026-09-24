import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeFunctionData, parseAbi } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import pg from 'pg';
import { authorizedCall } from '../../server/dist/stocks/chain.js';
import { ABI_DIGEST, callDigest, manifestDigest } from '../../server/dist/stocks/contracts.js';
import { createStocksSignerCore } from '../../server/dist/stocks-signer/core.js';
import { createOriginalNonceLookup } from '../../server/dist/stocks-signer/nonce-lookup.js';
import { createOriginalSignerTransport } from '../../server/dist/stocks-signer/original-transport.js';
import { PostgresSignerJournal } from '../../server/dist/stocks-signer/postgres-journal.js';

// Standalone, disposable EVM test. Run after `npm run build:server` with
// `node --test scripts/stocks-signer/original-transport-evm.test.mjs`.
// The fixed mnemonic is Hardhat's publicly documented test fixture, never a
// product key. No external RPC, deployment registry, .env or custody is used.
const root = resolve(import.meta.dirname, '../..');
const contractsRoot = join(root, 'packages/contracts');
const hardhat = join(contractsRoot, 'node_modules/.bin/hardhat');
const fixtureAccount = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 1 });
const limits = { maxGas: 2_000_000n, maxFeePerGas: 3_000_000_000n, maxTotalFeeWei: 6_000_000_000_000_000n };
const postgresUrl = process.env.STOCKS_SIGNER_TEST_DATABASE_URL;
const withPostgres = process.env.STOCKS_SIGNER_TEST_ONLY === '1' && !!postgresUrl;
if (postgresUrl && !withPostgres) throw Error('Owned signer test database requires STOCKS_SIGNER_TEST_ONLY=1');

async function freePort() {
  const socket = createServer();
  await new Promise((done, fail) => { socket.once('error', fail); socket.listen(0, '127.0.0.1', done); });
  const port = socket.address().port;
  await new Promise(done => socket.close(done));
  return port;
}

function stopped(pid) {
  try { process.kill(-pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
}

test('one-shot external-custody transport signs, broadcasts and recovers exact original transactions on an isolated EVM',
  { timeout: 120_000 }, async t => {
    assert.ok(existsSync(hardhat), 'Install the existing contracts lockfile before this test');
    assert.ok(existsSync(join(root, 'server/dist/stocks-signer/original-transport.js')),
      'Run npm run build:server before this test');
    const temp = mkdtempSync(join(tmpdir(), 'stocks-original-transport-'));
    const log = join(temp, 'hardhat.log');
    const logFd = openSync(log, 'a', 0o600);
    let node;
    let activePool;
    let passed = false;
    t.after(async () => {
      let cleanupError;
      try {
        try { await activePool?.end(); }
        catch (error) { cleanupError = error; }
        if (node?.pid && !stopped(node.pid)) {
          process.kill(-node.pid, 'SIGTERM');
          for (let n = 0; n < 40 && !stopped(node.pid); n++) await delay(50);
          if (!stopped(node.pid)) process.kill(-node.pid, 'SIGKILL');
          for (let n = 0; n < 40 && !stopped(node.pid); n++) await delay(50);
          assert.ok(stopped(node.pid), 'Owned local EVM process group did not stop');
        }
      } finally {
        closeSync(logFd);
        if (passed) rmSync(temp, { recursive: true, force: true });
        else process.stderr.write(`Isolated EVM diagnostics retained at ${temp}\n`);
      }
      if (cleanupError) throw cleanupError;
    });

    const run = (args, env = {}) => {
      const result = spawnSync(hardhat, args, { cwd: contractsRoot, env: { ...process.env, ...env },
        stdio: ['ignore', logFd, logFd], timeout: 60_000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, `Local Hardhat command failed; diagnostics: ${log}`);
    };
    run(['--config', 'hardhat.stocks.config.ts', 'compile']);
    const port = await freePort();
    const rpcUrl = `http://127.0.0.1:${port}`;
    node = spawn(hardhat, ['--config', 'hardhat.stocks.config.ts', 'node', '--hostname', '127.0.0.1', '--port', String(port)],
      { cwd: contractsRoot, detached: true, stdio: ['ignore', logFd, logFd] });

    async function rpc(method, params) {
      const id = randomUUID();
      const response = await fetch(rpcUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      assert.equal(response.status, 200);
      const row = await response.json();
      assert.equal(row.id, id);
      assert.equal(row.error, undefined, `Local RPC rejected ${method}`);
      return row.result;
    }
    let ready = false;
    for (let n = 0; n < 80; n++) {
      if (node.exitCode !== null) break;
      try { if (await rpc('eth_chainId', []) === '0x164ce') { ready = true; break; } }
      catch { /* bounded startup polling against the owned loopback child */ }
      await delay(100);
    }
    assert.ok(ready, `Isolated EVM did not start; diagnostics: ${log}`);
    const metadata = await rpc('hardhat_metadata', []);
    assert.equal(metadata.chainId, 91342);
    assert.ok(metadata.instanceId && !metadata.forkedNetwork);

    const bundlePath = join(temp, 'local-deployment.json');
    run(['--config', 'hardhat.stocks.config.ts', 'run', '--no-compile', 'scripts/stocks/deploy-local.ts', '--network', 'stocksLocal'],
      { STOCKS_LOCAL_RPC_PORT: String(port), STOCKS_ABI_DIGEST: ABI_DIGEST, STOCKS_MANIFEST_OUTPUT: bundlePath });
    const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
    assert.equal(bundle.execution, 'LOCAL_EVM_TEST_HARNESS_ONLY');
    assert.equal(bundle.publicAccounts.operator, fixtureAccount.address.toLowerCase());
    const manifest = bundle.manifest;
    const digest = manifestDigest(manifest);
    const lookup = createOriginalNonceLookup({ manifest, rpc });
    // Standalone mode keeps an in-memory intent; the owned-PostgreSQL mode
    // below proves the same real EVM path with durable journal and core.
    const signedHashes = new Map();
    let intent = {
      async recordSignedHash(operation, txHash) {
        const existing = signedHashes.get(operation.operationId);
        assert.ok(existing === undefined || existing === txHash);
        signedHashes.set(operation.operationId, txHash);
        return txHash;
      },
      async readSignedHash(operation) { return signedHashes.get(operation.operationId) ?? null; },
    };
    let journal;
    let initialNonce;
    if (withPostgres) {
      const target = new URL(postgresUrl);
      assert.equal(target.hostname, 'localhost');
      assert.equal(target.pathname, '/signer_test');
      assert.match(decodeURIComponent(target.searchParams.get('host') ?? ''), /\/stocks-signer-pg-[^/]+\/socket$/);
      initialNonce = BigInt(await rpc('eth_getTransactionCount', [manifest.signerAddress, 'pending'])).toString();
      activePool = new pg.Pool({ connectionString: postgresUrl, max: 4 });
      await activePool.query(`INSERT INTO stocks_signer.account_nonce
        ("chainId","signerAddress","networkInstance","checkpointNumber","checkpointHash","initialNonce","nextNonce")
        VALUES (91342,$1,$2,$3,$4,$5::numeric,$5::numeric)`,
      [manifest.signerAddress, manifest.networkInstance, manifest.checkpointNumber, manifest.checkpointHash, initialNonce]);
      journal = new PostgresSignerJournal(activePool, manifest, initialNonce);
      intent = journal;
    }
    let signatures = 0;
    const custody = { signOriginal: async request => {
      signatures++;
      assert.equal(request.chainId, 91342);
      assert.equal(request.value, 0n);
      // Only this test fixture holds a Hardhat account. Production custody is
      // external and must independently enforce its own one-shot policy.
      return fixtureAccount.signTransaction({ type: 'eip1559', chainId: request.chainId,
        nonce: Number(request.nonce), to: request.to, data: request.data, value: request.value,
        gas: 1_000_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    } };
    const transport = createOriginalSignerTransport({ manifest, rpc, custody, intent, lookup, limits });
    const operation = async (id, recipient) => {
      const call = authorizedCall(manifest, id, 'MINT', recipient, '1000000000');
      return { operationId: id, deploymentDigest: digest, callDigest: callDigest(call), call,
        originalNonce: BigInt(await rpc('eth_getTransactionCount', [manifest.signerAddress, 'pending'])).toString(), txHash: null };
    };
    const receipt = async hash => {
      for (let n = 0; n < 30; n++) {
        const found = await rpc('eth_getTransactionReceipt', [hash]);
        if (found) return found;
        await delay(100);
      }
      throw Error('Local EVM receipt unavailable');
    };
    const balance = async wallet => BigInt(await rpc('eth_call', [{ to: manifest.stockToken,
      data: encodeFunctionData({ abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
        functionName: 'balanceOf', args: [wallet] }) }, 'latest']));

    const firstCall = authorizedCall(manifest, 'mint:transport-evm-first', 'MINT', bundle.publicAccounts.holder, '1000000000');
    const secondCall = authorizedCall(manifest, 'mint:transport-evm-lost-ack', 'MINT', bundle.publicAccounts.otherHolder, '1000000000');
    const request = call => ({ protocol: 'ARCO_STOCKS_SIGNER_V1', deploymentDigest: digest,
      callDigest: callDigest(call), call });
    let sentHash;
    let sends = 0;
    const lostAckRpc = async (method, params) => {
      if (method === 'eth_sendRawTransaction') {
        sends++;
        sentHash = await rpc(method, params);
        throw Error('TEST_ONLY_LOST_BROADCAST_ACK');
      }
      return rpc(method, params);
    };

    if (withPostgres) {
      const core = createStocksSignerCore({ manifest, journal, transport });
      const first = await core.submit(firstCall.operationId, request(firstCall));
      assert.equal((await receipt(first.txHash)).status, '0x1');
      assert.equal(await balance(bundle.publicAccounts.holder), 1_000_000_000n);
      const firstRow = await journal.read(firstCall.operationId);
      assert.equal(await journal.readSignedHash(firstRow), first.txHash);
      assert.equal(firstRow.txHash, first.txHash);
      assert.deepEqual(await core.lookup(firstCall.operationId), first);
      assert.equal(signatures, 1);

      const nonceBefore = BigInt(await rpc('eth_getTransactionCount', [manifest.signerAddress, 'pending']));
      const uncertain = createOriginalSignerTransport({ manifest, rpc: lostAckRpc, custody, intent, lookup, limits });
      const uncertainCore = createStocksSignerCore({ manifest, journal, transport: uncertain });
      await assert.rejects(uncertainCore.submit(secondCall.operationId, request(secondCall)), /SIGNER_ORIGINAL_OUTCOME_UNKNOWN/);
      assert.equal(sends, 1);
      assert.equal((await receipt(sentHash)).status, '0x1');
      const unresolved = await journal.read(secondCall.operationId);
      assert.equal(unresolved.txHash, null);
      assert.equal(await journal.readSignedHash(unresolved), sentHash);
      assert.equal(await uncertainCore.submit(secondCall.operationId, request(secondCall)), null);
      assert.equal(sends, 1, 'Repeated submit cannot broadcast the reserved original again');
      await activePool.end();

      // A new pool, journal, transport and core read only durable state after
      // the ambiguous response. The PostgreSQL runner also restarts its owned
      // server before invoking this EVM scenario.
      activePool = new pg.Pool({ connectionString: postgresUrl, max: 4 });
      const reopened = new PostgresSignerJournal(activePool, manifest, initialNonce);
      const restarted = createOriginalSignerTransport({ manifest, rpc, custody, intent: reopened, lookup, limits });
      const recoveredCore = createStocksSignerCore({ manifest, journal: reopened, transport: restarted });
      assert.equal(await reopened.readSignedHash(unresolved), sentHash);
      assert.deepEqual(await recoveredCore.lookup(secondCall.operationId), {
        operationId: secondCall.operationId, callDigest: callDigest(secondCall), txHash: sentHash,
      });
      assert.equal((await reopened.read(secondCall.operationId)).txHash, sentHash);
      assert.equal(await balance(bundle.publicAccounts.otherHolder), 1_000_000_000n);
      assert.equal(BigInt(await rpc('eth_getTransactionCount', [manifest.signerAddress, 'pending'])), nonceBefore + 1n);
      assert.equal(signatures, 2);
      assert.equal(sends, 1);

      const candidate = await lookup.findAtOriginalNonce(unresolved);
      const tampered = createOriginalSignerTransport({ manifest, rpc, custody, intent: reopened,
        lookup: { findAtOriginalNonce: async () => ({ ...candidate, input: '0x1234' }) }, limits });
      await assert.rejects(tampered.findOriginal(unresolved), /SIGNER_ORIGINAL_TRANSACTION_MISMATCH/);
    } else {
      const first = await operation(firstCall.operationId, bundle.publicAccounts.holder);
      assert.equal(await transport.findOriginal(first), null, 'Absence is an unknown original outcome');
      const firstHash = await transport.sendOnce(first);
      assert.equal((await receipt(firstHash)).status, '0x1');
      assert.equal(await balance(bundle.publicAccounts.holder), 1_000_000_000n);
      assert.equal(await transport.findOriginal(first), firstHash);
      assert.equal(signatures, 1);

      const second = await operation(secondCall.operationId, bundle.publicAccounts.otherHolder);
      const nonceBefore = BigInt(await rpc('eth_getTransactionCount', [manifest.signerAddress, 'pending']));
      const uncertain = createOriginalSignerTransport({ manifest, rpc: lostAckRpc, custody, intent, lookup, limits });
      await assert.rejects(uncertain.sendOnce(second), /SIGNER_ORIGINAL_OUTCOME_UNKNOWN/);
      assert.equal(sends, 1);
      assert.equal((await receipt(sentHash)).status, '0x1');
      const restarted = createOriginalSignerTransport({ manifest, rpc, custody, intent, lookup, limits });
      assert.equal(await restarted.findOriginal(second), sentHash);
      assert.equal(await balance(bundle.publicAccounts.otherHolder), 1_000_000_000n);
      assert.equal(BigInt(await rpc('eth_getTransactionCount', [manifest.signerAddress, 'pending'])), nonceBefore + 1n);
      assert.equal(signatures, 2);
      const candidate = await lookup.findAtOriginalNonce(second);
      const tampered = createOriginalSignerTransport({ manifest, rpc, custody, intent,
        lookup: { findAtOriginalNonce: async () => ({ ...candidate, input: '0x1234' }) }, limits });
      await assert.rejects(tampered.findOriginal(second), /SIGNER_ORIGINAL_TRANSACTION_MISMATCH/);
    }
    assert.equal(signatures, 2, 'Read-only recovery must not ask custody to sign');
    assert.doesNotMatch(readFileSync(log, 'utf8'), /Private Key:|Account #\d+:/,
      'The isolated node must not print test account key material');
    passed = true;
  });
