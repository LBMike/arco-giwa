import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { ABI_DIGEST, callDigest, manifestDigest } from '../../server/dist/stocks/contracts.js';
import { authorizedCall, escrowIdentity, redemptionCall } from '../../server/dist/stocks/chain.js';
import { createStocksRpcPort } from '../../server/dist/stocks/rpc.js';
import { runStocksBootstrap } from '../../server/dist/stocks-signer/bootstrap-faucet.js';
import { createBootstrapFileStore } from '../../server/dist/stocks-signer/bootstrap-file-store.js';
import { createLocalKeystoreCustody } from '../../server/dist/stocks-signer/custody-local.js';
import { PostgresSignerJournal } from '../../server/dist/stocks-signer/postgres-journal.js';
import { createOriginalSignerTransport } from '../../server/dist/stocks-signer/original-transport.js';
import { createOriginalNonceLookup } from '../../server/dist/stocks-signer/nonce-lookup.js';
import { createStocksSignerCore } from '../../server/dist/stocks-signer/core.js';
import { httpStocksSignerRpc } from '../../server/dist/stocks-signer/http-rpc.js';

const root = resolve(import.meta.dirname, '../..');
const contractsRoot = join(root, 'packages/contracts');
const requireContracts = createRequire(join(contractsRoot, 'package.json'));
const { Wallet, ContractFactory, providers, utils } = requireContracts('ethers');
const postgresUrl = process.env.STOCKS_SIGNER_TEST_DATABASE_URL;
const allowed = process.env.STOCKS_SIGNER_TEST_ONLY === '1' && !!postgresUrl;
if (postgresUrl && !allowed) throw Error('BOOTSTRAP_TEST_OWNED_DATABASE_REQUIRED');
const limits = { maxGas: 2_000_000n, maxFeePerGas: 3_000_000_000n, maxTotalFeeWei: 6_000_000_000_000_000n };
const fees = { gas: 1_000_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
async function freePort() {
  const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port; await new Promise(done => server.close(done)); return port;
}
function stopped(pid) { try { process.kill(-pid, 0); return false; } catch (e) { if (e.code === 'ESRCH') return true; throw e; } }

test('shared-admin faucet bootstraps real PostgreSQL once, child restart recovers lost response, encrypted settlement continues',
  { skip: !allowed, timeout: 120_000 }, async t => {
    const target = new URL(postgresUrl);
    assert.equal(target.hostname, 'localhost'); assert.equal(target.pathname, '/signer_bootstrap_test');
    assert.match(target.searchParams.get('host'), /\/stocks-signer-pg-[^/]+\/socket$/);
    const temp = mkdtempSync(join(realpathSync(tmpdir()), 'stocks-bootstrap-evm-')); chmodSync(temp, 0o700);
    const state = join(temp, 'state'); mkdirSync(state, { mode: 0o700 });
    const logFd = openSync(join(temp, 'hardhat.log'), 'a', 0o600);
    let node, pool, custody, passed = false;
    t.after(async () => {
      custody?.close(); await pool?.end();
      if (node?.pid && !stopped(node.pid)) {
        process.kill(-node.pid, 'SIGTERM');
        for (let n = 0; n < 50 && !stopped(node.pid); n++) await delay(40);
        if (!stopped(node.pid)) process.kill(-node.pid, 'SIGKILL');
        for (let n = 0; n < 50 && !stopped(node.pid); n++) await delay(40);
        assert.ok(stopped(node.pid));
      }
      closeSync(logFd);
      if (passed) rmSync(temp, { recursive: true, force: true });
      else process.stderr.write(`Owned bootstrap test diagnostics: ${temp}\n`);
    });
    const port = await freePort(), rpcUrl = `http://127.0.0.1:${port}`;
    node = spawn(join(contractsRoot, 'node_modules/.bin/hardhat'),
      ['--config', 'hardhat.stocks.config.ts', 'node', '--hostname', '127.0.0.1', '--port', String(port)],
      { cwd: contractsRoot, detached: true, stdio: ['ignore', logFd, logFd] });
    const rpc = async (method, params) => {
      const id = randomUUID(); const response = await fetch(rpcUrl, { method: 'POST',
        headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      const row = await response.json(); assert.equal(row.id, id); assert.equal(row.error, undefined); return row.result;
    };
    let ready = false;
    for (let n = 0; n < 100; n++) {
      if (node.exitCode !== null) break;
      try { if (await rpc('eth_chainId', []) === '0x164ce') { ready = true; break; } } catch {}
      await delay(100);
    }
    assert.ok(ready); const metadata = await rpc('hardhat_metadata', []); assert.ok(!metadata.forkedNetwork);
    const provider = new providers.JsonRpcProvider(rpcUrl, 91342);
    const admin = provider.getSigner(0), customer = provider.getSigner(1);
    const signerAddress = (await admin.getAddress()).toLowerCase(), recipient = (await customer.getAddress()).toLowerCase();
    const nonce = await admin.getTransactionCount('pending');
    const predicted = Array.from({ length: 5 }, (_, offset) => utils.getContractAddress({ from: signerAddress, nonce: nonce + offset }));
    async function deploy(name, args, offset) {
      const artifact = JSON.parse(readFileSync(join(contractsRoot, 'artifacts/stocks/contracts/stocks', `${name}.sol`, `${name}.json`), 'utf8'));
      const contract = await new ContractFactory(artifact.abi, artifact.bytecode, admin).deploy(...args);
      await contract.deployed(); assert.equal(contract.address, predicted[offset]); return contract;
    }
    // All three administrative roles deliberately share the same account.
    const cash = await deploy('StocksTestCash', [signerAddress], 0);
    const vault = await deploy('StocksFundingVault', [predicted[0], signerAddress, predicted[4]], 1);
    const controller = await deploy('StocksMintController', [signerAddress, predicted[3]], 2);
    const stock = await deploy('StocksToken', [predicted[2], predicted[4]], 3);
    const escrow = await deploy('StocksRedemptionEscrow', [signerAddress, predicted[3], predicted[1]], 4);
    const checkpoint = await provider.getBlock('latest'); const codeHashes = {};
    for (const contract of [cash, vault, controller, stock, escrow])
      codeHashes[contract.address.toLowerCase()] = utils.keccak256(await provider.getCode(contract.address));
    const manifest = { schemaVersion: 2, deploymentId: `bootstrap-${randomUUID()}`, profile: 'DEMO_TESTNET', chainId: 91342,
      networkInstance: `hardhat-${metadata.instanceId.replace(/^0x/, '')}`, checkpointNumber: String(checkpoint.number),
      checkpointHash: checkpoint.hash, abiDigest: ABI_DIGEST, finalityPolicy: 'FINALIZED', cashToken: cash.address.toLowerCase(),
      cashSymbol: 'ARCO_TEST_USDC', cashScale: 6, stockToken: stock.address.toLowerCase(), quantityScale: 9,
      fundingVault: vault.address.toLowerCase(), mintController: controller.address.toLowerCase(), redemptionEscrow: escrow.address.toLowerCase(),
      signerAddress, codeHashes, restrictedTransfers: true, nonUpgradeable: true };
    pool = new pg.Pool({ connectionString: postgresUrl, max: 4 });
    requireContracts('ts-node').register({ project: join(contractsRoot, 'tsconfig.json') });
    const { unlockLocalDeploymentWallet } = requireContracts('./scripts/stocks/local-keystore.ts');
    const syntheticWallet = Wallet.fromMnemonic('test test test test test test test test test test test junk');
    const password = randomBytes(32).toString('base64url'), keyFile = join(temp, 'generated-encrypted-wallet.json');
    writeFileSync(keyFile, await syntheticWallet.encrypt(password, { scrypt: { N: 16384 } }), { flag: 'wx', mode: 0o600 });
    const unlocked = await unlockLocalDeploymentWallet(keyFile, signerAddress, async () => password);
    let signatures = 0, broadcasts = 0, releaseSignature, reachedSignature;
    const reached = new Promise(resolve => { reachedSignature = resolve; });
    const held = new Promise(resolve => { releaseSignature = resolve; });
    custody = createLocalKeystoreCustody({ signerAddress, fees, limits, signTransaction: async tx => {
      signatures++; reachedSignature(); await held; return unlocked.signTransaction(tx);
    } });
    const hiddenRpc = async (method, params) => {
      if (method === 'eth_getTransactionReceipt') return null;
      const result = await rpc(method, params);
      if (method === 'eth_sendRawTransaction') { broadcasts++; throw Error('TEST_ONLY_LOST_ACK'); }
      return result;
    };
    const options = { manifest, reviewedManifestDigest: manifestDigest(manifest), recipient, amount: '10000000000', pool,
      chain: createStocksRpcPort(hiddenRpc, manifest), rpc: hiddenRpc, custody, limits, store: createBootstrapFileStore(state) };
    const first = runStocksBootstrap(options); await reached;
    const competing = runStocksBootstrap(options);
    const seedProbe = await pool.connect();
    try {
      await seedProbe.query('BEGIN'); await seedProbe.query("SET LOCAL lock_timeout='100ms'");
      await assert.rejects(seedProbe.query(`INSERT INTO stocks_signer.account_nonce
        ("chainId","signerAddress","networkInstance","checkpointNumber","checkpointHash","initialNonce","nextNonce")
        VALUES (91342,$1,$2,$3,$4,$5,$5)`,
      [signerAddress, manifest.networkInstance, manifest.checkpointNumber, manifest.checkpointHash, String(nonce + 5)]),
      error => error.code === '55P03');
      await seedProbe.query('ROLLBACK');
    } finally { seedProbe.release(); releaseSignature(); }
    const [a, b] = await Promise.all([first, competing]); assert.equal(a.status, 'PENDING'); assert.deepEqual(a, b);
    assert.equal(signatures, 1); assert.equal(broadcasts, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM stocks_signer.account_nonce')).rows[0].count, 0);
    assert.equal(String(await cash.balanceOf(recipient)), '10000000000');
    // Separate process, fresh pool/store, and NO signing capability proves the
    // original hash is sufficient after the response and process are lost.
    const recovery = join(temp, 'public-recovery.json');
    writeFileSync(recovery, JSON.stringify({ manifest, recipient, state, rpcUrl }), { mode: 0o600 });
    const recovered = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs'; import pg from 'pg';
      import { runStocksBootstrap } from './server/dist/stocks-signer/bootstrap-faucet.js';
      import { createBootstrapFileStore } from './server/dist/stocks-signer/bootstrap-file-store.js';
      import { createStocksRpcPort } from './server/dist/stocks/rpc.js';
      import { manifestDigest } from './server/dist/stocks/contracts.js';
      const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
      const pool=new pg.Pool({connectionString:process.env.STOCKS_SIGNER_TEST_DATABASE_URL});
      const rpc=async(method,params)=>{ if(method==='eth_sendRawTransaction') throw Error('RESTART_MUST_NOT_SEND');
        const r=await fetch(c.rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
        const v=await r.json(); if(v.error) throw Error('TEST_RPC'); return v.result; };
      try { console.log(JSON.stringify(await runStocksBootstrap({manifest:c.manifest,reviewedManifestDigest:manifestDigest(c.manifest),
        recipient:c.recipient,amount:'10000000000',pool,rpc,chain:createStocksRpcPort(rpc,c.manifest),
        custody:{signOriginal:async()=>{throw Error('RESTART_MUST_NOT_SIGN')}},
        limits:{maxGas:2000000n,maxFeePerGas:3000000000n,maxTotalFeeWei:6000000000000000n},store:createBootstrapFileStore(c.state)}))); }
      finally { await pool.end(); }
    `, recovery], { cwd: root, env: { PATH: process.env.PATH, STOCKS_SIGNER_TEST_DATABASE_URL: postgresUrl }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(recovered.status, 0, recovered.stderr);
    const completion = JSON.parse(recovered.stdout.trim()); assert.equal(completion.status, 'COMPLETE');
    assert.equal(completion.originalTransactionHash, a.originalTransactionHash); assert.equal(completion.initialNonce, String(nonce + 6));
    const freshState = join(temp, 'empty-state'); mkdirSync(freshState, { mode: 0o700 });
    await assert.rejects(runStocksBootstrap({ ...options, store: createBootstrapFileStore(freshState) }), /BOOTSTRAP_ACCOUNT_ALREADY_INITIALIZED/);
    // Continue through the unchanged normal settlement journal and encrypted
    // custody using the exact nonce seeded by bootstrap.
    const journal = new PostgresSignerJournal(pool, manifest, completion.initialNonce);
    const signerRpc = httpStocksSignerRpc(rpcUrl, true);
    const transport = createOriginalSignerTransport({ manifest, rpc: signerRpc, custody, intent: journal,
      lookup: createOriginalNonceLookup({ manifest, rpc: signerRpc }), limits });
    const core = createStocksSignerCore({ manifest, journal, transport });
    async function submit(call) {
      const request = { protocol: 'ARCO_STOCKS_SIGNER_V1', deploymentDigest: manifestDigest(manifest), call, callDigest: callDigest(call) };
      const result = await core.submit(call.operationId, request); await provider.waitForTransaction(result.txHash);
      assert.deepEqual(await core.submit(call.operationId, request), result); return result;
    }
    const buyKey = utils.id('bootstrap-customer-buy');
    await (await cash.connect(customer).approve(vault.address, '100000000')).wait();
    await (await vault.connect(customer).depositForOrder(buyKey, '100000000')).wait();
    await submit(authorizedCall(manifest, 'mint:bootstrap-buy', 'MINT', recipient, '1000000000'));
    assert.equal(String(await stock.balanceOf(recipient)), '1000000000');
    const sellKey = utils.id('bootstrap-customer-sell');
    await (await stock.connect(customer).approve(escrow.address, '400000000')).wait();
    await (await escrow.connect(customer).escrowForOrder(sellKey, stock.address, '400000000')).wait();
    const identity = escrowIdentity(sellKey, recipient, stock.address);
    await submit(redemptionCall(manifest, 'redeem:bootstrap-sell', 'REDEEM', identity, '40000000'));
    assert.equal(String(await stock.balanceOf(recipient)), '600000000');
    assert.equal(String(await cash.balanceOf(recipient)), '9940000000');
    const after = await runStocksBootstrap({ ...options, rpc, chain: createStocksRpcPort(rpc, manifest) });
    assert.deepEqual(after, completion); assert.equal(signatures, 3); assert.equal(broadcasts, 1);
    const account = (await pool.query('SELECT "initialNonce"::text,"nextNonce"::text FROM stocks_signer.account_nonce')).rows[0];
    assert.equal(account.initialNonce, completion.initialNonce); assert.equal(account.nextNonce, String(BigInt(completion.initialNonce) + 2n));
    passed = true;
  });
