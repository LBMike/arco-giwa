import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bytesToHex, encodeFunctionData, hexToBytes, parseAbi, parseSignature } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import pg from 'pg';
import { authorizedCall, escrowIdentity, redemptionCall } from '../../server/dist/stocks/chain.js';
import { ABI, ABI_DIGEST, callDigest, manifestDigest, operationKey } from '../../server/dist/stocks/contracts.js';
import { createKmsCustody } from '../../server/dist/stocks-signer/custody-kms.js';
import { createLocalKeystoreCustody } from '../../server/dist/stocks-signer/custody-local.js';
import { startStocksSignerHost } from '../../server/dist/stocks-signer/host.js';
import { parseSignerHostConfig } from '../../server/dist/stocks-signer/host-config.js';
import { httpStocksSignerRpc } from '../../server/dist/stocks-signer/http-rpc.js';
import { createOriginalNonceLookup } from '../../server/dist/stocks-signer/nonce-lookup.js';
import { createOriginalSignerTransport } from '../../server/dist/stocks-signer/original-transport.js';
import { PostgresSignerJournal } from '../../server/dist/stocks-signer/postgres-journal.js';
import { externalStocksSigner } from '../../server/dist/stocks-runtime/transport.js';

// Standalone, disposable EVM test. Run after `npm run build:server` with
// `node --test scripts/stocks-signer/original-transport-evm.test.mjs`.
// The fixed mnemonic is Hardhat's publicly documented test fixture, never a
// product key. No external RPC, deployment registry, .env or custody is used.
const root = resolve(import.meta.dirname, '../..');
const contractsRoot = join(root, 'packages/contracts');
const hardhat = join(contractsRoot, 'node_modules/.bin/hardhat');
const publicTestMnemonic = 'test test test test test test test test test test test junk';
const fixtureAccount = mnemonicToAccount(publicTestMnemonic, { addressIndex: 1 });
const limits = { maxGas: 2_000_000n, maxFeePerGas: 3_000_000_000n, maxTotalFeeWei: 6_000_000_000_000_000n };
const postgresUrl = process.env.STOCKS_SIGNER_TEST_DATABASE_URL;
const withPostgres = process.env.STOCKS_SIGNER_TEST_ONLY === '1' && !!postgresUrl;
const localKeystore = process.env.STOCKS_SIGNER_CUSTODY_TEST === 'LOCAL_KEYSTORE';
if (postgresUrl && !withPostgres) throw Error('Owned signer test database requires STOCKS_SIGNER_TEST_ONLY=1');
if (localKeystore && !withPostgres) throw Error('Local keystore mode requires the owned PostgreSQL test runner');

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

test(withPostgres
  ? `runnable ${localKeystore ? 'encrypted keystore' : 'KMS'} signer host uses TCP, PostgreSQL and an isolated EVM to recover the exact original`
  : 'one-shot external-custody transport signs and recovers the exact original on an isolated EVM',
  { timeout: 120_000 }, async t => {
    assert.ok(existsSync(hardhat), 'Install the existing contracts lockfile before this test');
    assert.ok(existsSync(join(root, 'server/dist/stocks-signer/original-transport.js')),
      'Run npm run build:server before this test');
    const temp = mkdtempSync(join(tmpdir(), 'stocks-original-transport-'));
    const log = join(temp, 'hardhat.log');
    const logFd = openSync(log, 'a', 0o600);
    let node;
    let activePool;
    const apps = new Set();
    let passed = false;
    t.after(async () => {
      let cleanupError;
      try {
        for (const app of apps) {
          try { await app.close(); }
          catch (error) { cleanupError ??= error; }
        }
        try { await activePool?.end(); }
        catch (error) { cleanupError ??= error; }
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
    const signerRpc = httpStocksSignerRpc(rpcUrl, true);
    const lookup = createOriginalNonceLookup({ manifest, rpc: signerRpc });
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
      assert.equal(target.pathname, localKeystore ? '/signer_keystore_test' : '/signer_test');
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
    let heldSignature;
    let signatureStarted;
    let kmsAvailable = true;
    let custodyCloses = 0;
    const keyArn = 'arn:aws:kms:ap-northeast-2:123456789012:key/12345678-1234-1234-1234-123456789012';
    const publicKey = hexToBytes(fixtureAccount.publicKey);
    const spki = createPublicKey({ key: { kty: 'EC', crv: 'secp256k1',
      x: Buffer.from(publicKey.slice(1, 33)).toString('base64url'),
      y: Buffer.from(publicKey.slice(33)).toString('base64url') }, format: 'jwk' }).export({ format: 'der', type: 'spki' });
    const fees = { gas: 1_000_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
    let localWallet;
    if (localKeystore) {
      const requireContracts = createRequire(join(contractsRoot, 'package.json'));
      requireContracts('ts-node').register({ project: join(contractsRoot, 'tsconfig.json') });
      const { Wallet } = requireContracts('ethers');
      const { unlockLocalDeploymentWallet } = requireContracts('./scripts/stocks/local-keystore.ts');
      const file = join(temp, 'test-wallet.json');
      const password = randomBytes(32).toString('base64url');
      const wallet = Wallet.fromMnemonic(publicTestMnemonic, "m/44'/60'/0'/0/1");
      writeFileSync(file, await wallet.encrypt(password, { scrypt: { N: 16384 } }), { flag: 'wx', mode: 0o600 });
      localWallet = await unlockLocalDeploymentWallet(file, manifest.signerAddress, async () => password);
    }
    const makeKmsCustody = () => createKmsCustody({ identity: { region: 'ap-northeast-2', keyArn,
      signerAddress: manifest.signerAddress }, fees, limits, port: {
      async getPublicKey() {
        if (!kmsAvailable) throw Error('TEST_ONLY_KMS_UNAVAILABLE');
        return { KeyId: keyArn, KeySpec: 'ECC_SECG_P256K1', KeyUsage: 'SIGN_VERIFY',
          SigningAlgorithms: ['ECDSA_SHA_256'], PublicKey: spki };
      },
      async sign(digest) {
        signatures++;
        signatureStarted?.();
        if (heldSignature) await heldSignature;
        const signature = parseSignature(await fixtureAccount.sign({ hash: bytesToHex(digest) }));
        const integer = hex => {
          let b = Buffer.from(hex.slice(2).replace(/^(00)+/, ''), 'hex');
          if (b[0] >= 128) b = Buffer.concat([Buffer.from([0]), b]);
          return Buffer.concat([Buffer.from([2, b.length]), b]);
        };
        const body = Buffer.concat([integer(signature.r), integer(signature.s)]);
        return { KeyId: keyArn, SigningAlgorithm: 'ECDSA_SHA_256',
          Signature: Buffer.concat([Buffer.from([0x30, body.length]), body]) };
      },
      destroy() { custodyCloses++; },
    } });
    const makeCustody = () => {
      if (!localKeystore) return makeKmsCustody();
      const local = createLocalKeystoreCustody({ signerAddress: manifest.signerAddress, fees, limits,
        signTransaction: async tx => {
          signatures++; signatureStarted?.();
          if (heldSignature) await heldSignature;
          return localWallet.signTransaction(tx);
        } });
      let closed = false;
      return { ...local, ready: async () => kmsAvailable && await local.ready(),
        close: () => { if (!closed) { closed = true; custodyCloses++; local.close(); } } };
    };
    const custody = makeCustody();
    t.after(() => custody.close());
    const transport = createOriginalSignerTransport({ manifest, rpc: signerRpc, custody, intent, lookup, limits });
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
    const balance = async (wallet, token = manifest.stockToken) => BigInt(await rpc('eth_call', [{ to: token,
      data: encodeFunctionData({ abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
        functionName: 'balanceOf', args: [wallet] }) }, 'latest']));

    const firstCall = authorizedCall(manifest, 'mint:transport-evm-first', 'MINT', bundle.publicAccounts.holder, '1000000000');
    const secondCall = authorizedCall(manifest, 'mint:transport-evm-lost-ack', 'MINT', bundle.publicAccounts.otherHolder, '1000000000');
    let sentHash;
    let sends = 0;
    const lostAckRpc = async (method, params) => {
      if (method === 'eth_sendRawTransaction') {
        sends++;
        sentHash = await signerRpc(method, params);
        throw Error('TEST_ONLY_LOST_BROADCAST_ACK');
      }
      return signerRpc(method, params);
    };

    if (withPostgres) {
      // Real TCP uses the production host composition with either a KMS wire
      // fixture or the real encrypted-wallet loader and local custody adapter.
      const hostConfig = parseSignerHostConfig({ schemaVersion: 1, profile: 'DEMO_TESTNET', manifest,
        reviewedManifestDigest: digest, reviewedInitialNonce: initialNonce, rpcUrl: 'https://sepolia-rpc.giwa.io',
        listen: { host: '127.0.0.1', port: 8081 },
        custody: localKeystore ? { type: 'LOCAL_KEYSTORE', exclusiveAccountControlConfirmed: true }
          : { type: 'AWS_KMS', region: 'ap-northeast-2', keyArn, exclusiveAccountControlConfirmed: true },
        transaction: Object.fromEntries(Object.entries(fees).map(([k, v]) => [k, String(v)])),
        limits: Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, String(v)])),
      });
      const token = randomBytes(32).toString('base64url');
      const startHost = async (rpc = signerRpc, mode = 'serve', overrides = {}) => {
        const pool = new pg.Pool({ connectionString: postgresUrl, max: 2 });
        const host = await startStocksSignerHost({ config: { ...hostConfig, listen: { host: '127.0.0.1', port: 0 } },
          pool, custody: makeCustody(), rpc, bearerToken: token, mode, ...overrides });
        apps.add(host);
        return host;
      };
      const checked = await startHost(signerRpc, 'check');
      assert.equal(checked.address, null); assert.equal(signatures, 0);
      const throughHttp = async (rpc = signerRpc) => {
        const app = await startHost(rpc);
        const unauthorized = await fetch(`${app.address}/v1/capabilities`);
        assert.equal(unauthorized.status, 401);
        const client = externalStocksSigner({ url: app.address, localHarness: true, authorization: token,
          deploymentDigest: digest, manifest });
        return { app, client };
      };
      const firstHttp = await throughHttp();
      const occupiedPort = Number(new URL(firstHttp.app.address).port);
      await assert.rejects(startHost(signerRpc, 'serve', {
        config: { ...hostConfig, listen: { host: '127.0.0.1', port: occupiedPort } },
      }), /SIGNER_HOST_NOT_READY/);
      await assert.rejects(startHost(signerRpc, 'serve', { signal: AbortSignal.abort() }), /SIGNER_HOST_NOT_READY/);
      await assert.rejects(startHost(signerRpc, 'serve', { bearerToken: 'invalid' }), /SIGNER_HOST_NOT_READY/);
      kmsAvailable = false;
      await assert.rejects(firstHttp.client.probe());
      assert.equal(signatures, 0);
      await assert.rejects(startHost(), /SIGNER_HOST_NOT_READY/);
      kmsAvailable = true;
      await firstHttp.client.probe();
      assert.equal(await firstHttp.client.lookup(firstCall.operationId), null);
      const first = await firstHttp.client.submit(firstCall);
      assert.equal((await receipt(first.txHash)).status, '0x1');
      assert.equal(await balance(bundle.publicAccounts.holder), 1_000_000_000n);
      const firstRow = await journal.read(firstCall.operationId);
      assert.equal(await journal.readSignedHash(firstRow), first.txHash);
      assert.equal(firstRow.txHash, first.txHash);
      assert.deepEqual(await firstHttp.client.lookup(firstCall.operationId), first);
      assert.deepEqual(await firstHttp.client.submit(firstCall), first);
      assert.equal(signatures, 1);
      const concurrent = await Promise.all(Array.from({ length: 8 }, () => firstHttp.client.submit(firstCall)));
      assert.ok(concurrent.every(row => row.txHash === first.txHash));
      assert.equal(signatures, 1);

      const nonceBefore = BigInt(await rpc('eth_getTransactionCount', [manifest.signerAddress, 'pending']));
      const uncertainHttp = await throughHttp(lostAckRpc);
      await uncertainHttp.client.probe();
      let releaseSignature;
      heldSignature = new Promise(resolve => { releaseSignature = resolve; });
      const admitted = new Promise(resolve => { signatureStarted = resolve; });
      const uncertainSubmission = assert.rejects(uncertainHttp.client.submit(secondCall), /SIGNER_RESPONSE_UNAVAILABLE/);
      await admitted;
      const closesBeforeDrain = custodyCloses;
      let drained = false;
      const draining = uncertainHttp.app.close().then(() => { drained = true; });
      await delay(25);
      assert.equal(drained, false, 'Shutdown must wait for admitted signing work');
      assert.equal(custodyCloses, closesBeforeDrain, 'Custody stays available until signed hash and broadcast settle');
      releaseSignature();
      heldSignature = undefined; signatureStarted = undefined;
      await uncertainSubmission;
      await draining;
      apps.delete(uncertainHttp.app);
      assert.equal(sends, 1);
      assert.equal((await receipt(sentHash)).status, '0x1');
      const unresolved = await journal.read(secondCall.operationId);
      assert.equal(unresolved.txHash, null);
      assert.equal(await journal.readSignedHash(unresolved), sentHash);
      await assert.rejects(firstHttp.client.submit(secondCall), /SIGNER_RESPONSE_UNAVAILABLE/);
      assert.equal(sends, 1, 'Repeated submit cannot broadcast the reserved original again');
      await firstHttp.app.close();
      apps.delete(firstHttp.app);
      await uncertainHttp.app.close();
      apps.delete(uncertainHttp.app);
      await activePool.end();

      // A new pool, journal, transport and core read only durable state after
      // the ambiguous response. The PostgreSQL runner also restarts its owned
      // server before invoking this EVM scenario.
      activePool = new pg.Pool({ connectionString: postgresUrl, max: 4 });
      const reopened = new PostgresSignerJournal(activePool, manifest, initialNonce);
      const recoveredHttp = await throughHttp();
      await recoveredHttp.client.probe();
      assert.equal(await reopened.readSignedHash(unresolved), sentHash);
      assert.deepEqual(await recoveredHttp.client.lookup(secondCall.operationId), {
        operationId: secondCall.operationId, callDigest: callDigest(secondCall), txHash: sentHash,
      });
      assert.deepEqual(await recoveredHttp.client.submit(secondCall), {
        operationId: secondCall.operationId, callDigest: callDigest(secondCall), txHash: sentHash,
      });
      assert.equal((await reopened.read(secondCall.operationId)).txHash, sentHash);
      assert.equal(await balance(bundle.publicAccounts.otherHolder), 1_000_000_000n);
      assert.equal(BigInt(await rpc('eth_getTransactionCount', [manifest.signerAddress, 'pending'])), nonceBefore + 1n);
      assert.equal(signatures, 2);
      assert.equal(sends, 1);

      // Settle a real partial sale through the same KMS/host/journal path.
      // Funding and wallet approvals use only the isolated node's unlocked accounts.
      const localWrite = async (from, to, data) => {
        const txHash = await rpc('eth_sendTransaction', [{ from, to, data, gas: '0x1e8480' }]);
        assert.equal((await receipt(txHash)).status, '0x1');
      };
      await localWrite(bundle.publicAccounts.faucetOperator, manifest.cashToken,
        encodeFunctionData({ abi: parseAbi(['function faucet(address,uint256)']), functionName: 'faucet',
          args: [manifest.fundingVault, 120_000_000n] }));
      await localWrite(bundle.publicAccounts.holder, manifest.stockToken,
        encodeFunctionData({ abi: parseAbi(['function approve(address,uint256) returns (bool)']), functionName: 'approve',
          args: [manifest.redemptionEscrow, 500_000_000n] }));
      const sellKey = operationKey('sell:kms-host-partial');
      await localWrite(bundle.publicAccounts.holder, manifest.redemptionEscrow,
        encodeFunctionData({ abi: ABI, functionName: 'escrowForOrder', args: [sellKey, manifest.stockToken, 500_000_000n] }));
      const sellCall = redemptionCall(manifest, 'redeem:kms-host-partial', 'REDEEM',
        escrowIdentity(sellKey, bundle.publicAccounts.holder, manifest.stockToken), '60000000');
      const sold = await recoveredHttp.client.submit(sellCall);
      assert.equal((await receipt(sold.txHash)).status, '0x1');
      assert.deepEqual(await recoveredHttp.client.submit(sellCall), sold);
      assert.equal(await balance(bundle.publicAccounts.holder), 500_000_000n);
      assert.equal(await balance(manifest.redemptionEscrow), 0n);
      assert.equal(await balance(bundle.publicAccounts.holder, manifest.cashToken), 60_000_000n);
      assert.equal(await balance(manifest.fundingVault, manifest.cashToken), 60_000_000n);
      assert.equal(signatures, 3);
      console.log(localKeystore ? 'SIGNER_HOST_TCP_KEYSTORE_MINT_REDEEM_RECOVERY_PASSED' : 'SIGNER_HOST_TCP_KMS_MINT_REDEEM_RECOVERY_PASSED');
      const closePromise = recoveredHttp.app.close();
      assert.equal(closePromise, recoveredHttp.app.close(), 'Repeated shutdown shares one drain');
      await closePromise;
      apps.delete(recoveredHttp.app);
      await assert.rejects(fetch(`${recoveredHttp.app.address}/v1/capabilities`));
      assert.ok(custodyCloses >= 5, 'Check, failed startup and every closed host release custody');
      const candidate = await lookup.findAtOriginalNonce(unresolved);
      const tampered = createOriginalSignerTransport({ manifest, rpc: signerRpc, custody, intent: reopened,
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
      const restarted = createOriginalSignerTransport({ manifest, rpc: signerRpc, custody, intent, lookup, limits });
      assert.equal(await restarted.findOriginal(second), sentHash);
      assert.equal(await balance(bundle.publicAccounts.otherHolder), 1_000_000_000n);
      assert.equal(BigInt(await rpc('eth_getTransactionCount', [manifest.signerAddress, 'pending'])), nonceBefore + 1n);
      assert.equal(signatures, 2);
      const candidate = await lookup.findAtOriginalNonce(second);
      const tampered = createOriginalSignerTransport({ manifest, rpc: signerRpc, custody, intent,
        lookup: { findAtOriginalNonce: async () => ({ ...candidate, input: '0x1234' }) }, limits });
      await assert.rejects(tampered.findOriginal(second), /SIGNER_ORIGINAL_TRANSACTION_MISMATCH/);
    }
    assert.equal(signatures, withPostgres ? 3 : 2, 'Read-only recovery must not ask custody to sign');
    assert.doesNotMatch(readFileSync(log, 'utf8'), /Private Key:|Account #\d+:/,
      'The isolated node must not print test account key material');
    passed = true;
  });
