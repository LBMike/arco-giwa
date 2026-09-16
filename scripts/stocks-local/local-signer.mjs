import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { callDigest, canonicalJson } from '../../server/dist/stocks/contracts.js';

// This module is a disposable local test harness, never a production signer.
// Its only signing mechanism is eth_sendTransaction on an unforked loopback node.
export async function localSigner({ pool, rpc, manifest, deploymentDigest, token }) {
  assert.equal(process.env.STOCKS_LOCAL_STACK_ONLY, '1');
  assert.equal(await rpc('eth_chainId', []), '0x164ce');
  const metadata = await rpc('hardhat_metadata', []);
  assert.ok(metadata.instanceId && !metadata.forkedNetwork);
  const nodeInstance = metadata.instanceId;
  await pool.query(`CREATE SCHEMA IF NOT EXISTS stocks_local_harness;
    CREATE TABLE IF NOT EXISTS stocks_local_harness.canonical_node (
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), node_instance text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stocks_local_harness.signer_operations (
      id text PRIMARY KEY, deployment_digest text NOT NULL, call_digest text NOT NULL,
      payload jsonb NOT NULL, node_instance text NOT NULL, account text NOT NULL, nonce numeric NOT NULL,
      prepared_block numeric NOT NULL, tx_hash text,
      state text NOT NULL CHECK (state IN ('PREPARED','BROADCASTED')),
      CHECK (nonce>=0 AND nonce=trunc(nonce)),
      CHECK ((state='PREPARED' AND tx_hash IS NULL) OR (state='BROADCASTED' AND tx_hash IS NOT NULL)),
      UNIQUE(node_instance,account,nonce)
    )`);
  await pool.query('INSERT INTO stocks_local_harness.canonical_node(node_instance) VALUES($1) ON CONFLICT(singleton) DO NOTHING', [nodeInstance]);
  assert.equal((await pool.query('SELECT node_instance FROM stocks_local_harness.canonical_node WHERE singleton')).rows[0].node_instance, nodeInstance,
    'Disposable signer database belongs to another physical local node');
  const scope = `stocks-local-signer:${nodeInstance}:${manifest.signerAddress}`;
  const controls = { loseNextBroadcastAcknowledgement: false, submissions: 0, recoveries: 0 };
  const targets = new Set([manifest.mintController, manifest.fundingVault, manifest.redemptionEscrow]);
  function response(row) {
    return row?.tx_hash ? { operationId: row.id, callDigest: row.call_digest, txHash: row.tx_hash } : null;
  }
  async function exclusive(fn) {
    const db = await pool.connect();
    try {
      // Session lock spans RPC, but no DB transaction is held over external calls.
      await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [scope]);
      return await fn(db);
    } finally {
      try { await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [scope]); }
      finally { db.release(); }
    }
  }
  function matchTransaction(tx, row) {
    return tx && tx.from?.toLowerCase() === row.account && BigInt(tx.nonce) === BigInt(row.nonce)
      && tx.to?.toLowerCase() === row.payload.to && tx.input === row.payload.data
      && BigInt(tx.value) === 0n;
  }
  async function recover(db, row) {
    if (!row || row.deployment_digest !== deploymentDigest || row.node_instance !== nodeInstance) return null;
    if (row.tx_hash) return response(row);
    const last = BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).number);
    const first = BigInt(row.prepared_block);
    assert.ok(last >= first && last - first <= 10000n, 'Local recovery scan exceeds bounded history');
    for (let n = first; n <= last; n++) {
      const block = await rpc('eth_getBlockByNumber', [`0x${n.toString(16)}`, true]);
      for (const tx of block.transactions) {
        if (tx.from?.toLowerCase() !== row.account || BigInt(tx.nonce) !== BigInt(row.nonce)) continue;
        assert.ok(matchTransaction(tx, row), 'Original nonce was used for another payload');
        const saved = (await db.query(`UPDATE stocks_local_harness.signer_operations
          SET tx_hash=$2,state='BROADCASTED' WHERE id=$1 AND tx_hash IS NULL RETURNING *`, [row.id, tx.hash])).rows[0];
        controls.recoveries++;
        return response(saved);
      }
    }
    return null; // Unknown is never permission to submit a new transaction.
  }
  async function lookup(id) {
    return exclusive(async db => recover(db, (await db.query(
      'SELECT * FROM stocks_local_harness.signer_operations WHERE id=$1 AND deployment_digest=$2', [id, deploymentDigest],
    )).rows[0]));
  }
  async function submit(id, request) {
    const call = structuredClone(request.call);
    assert.equal(request.protocol, 'ARCO_STOCKS_SIGNER_V1');
    assert.equal(request.deploymentDigest, deploymentDigest);
    assert.equal(call.operationId, id);
    assert.equal(call.chainId, 91342);
    assert.equal(call.networkInstance, manifest.networkInstance);
    assert.equal(call.deploymentId, manifest.deploymentId);
    assert.equal(call.from, manifest.signerAddress);
    assert.equal(call.value, '0');
    assert.ok(targets.has(call.to));
    assert.match(call.data, /^0x[0-9a-f]+$/);
    assert.equal(request.callDigest, callDigest(call));
    return exclusive(async db => {
      const existing = (await db.query('SELECT * FROM stocks_local_harness.signer_operations WHERE id=$1', [id])).rows[0];
      if (existing) {
        assert.equal(existing.deployment_digest, deploymentDigest);
        assert.equal(existing.call_digest, request.callDigest);
        assert.equal(canonicalJson(existing.payload), canonicalJson(call));
        return recover(db, existing);
      }
      for (const row of (await db.query(`SELECT * FROM stocks_local_harness.signer_operations
        WHERE node_instance=$1 AND account=$2 AND state='PREPARED' ORDER BY nonce`, [nodeInstance, call.from])).rows) {
        // A changed manifest cannot erase another deployment's unresolved nonce.
        // Only its original deployment client may recover that operation.
        if (!await recover(db, row)) throw new Error('Unresolved original submission blocks later nonces');
      }
      const pending = BigInt(await rpc('eth_getTransactionCount', [call.from, 'pending']));
      const stored = BigInt((await db.query(`SELECT COALESCE(MAX(nonce)+1,0)::text AS next
        FROM stocks_local_harness.signer_operations WHERE node_instance=$1 AND account=$2`, [nodeInstance, call.from])).rows[0].next);
      const nonce = pending > stored ? pending : stored;
      const block = BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).number);
      // Durable original nonce and payload exist before the first broadcast.
      await db.query(`INSERT INTO stocks_local_harness.signer_operations
        (id,deployment_digest,call_digest,payload,node_instance,account,nonce,prepared_block,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PREPARED')`,
      [id, deploymentDigest, request.callDigest, JSON.stringify(call), nodeInstance, call.from, nonce.toString(), block.toString()]);
      controls.submissions++;
      const txHash = await rpc('eth_sendTransaction', [{ from: call.from, to: call.to, data: call.data,
        value: '0x0', nonce: `0x${nonce.toString(16)}`, gas: '0x1e8480' }]);
      if (controls.loseNextBroadcastAcknowledgement) {
        controls.loseNextBroadcastAcknowledgement = false;
        throw new Error('TEST_ONLY_LOST_BROADCAST_ACK');
      }
      return response((await db.query(`UPDATE stocks_local_harness.signer_operations
        SET tx_hash=$2,state='BROADCASTED' WHERE id=$1 AND state='PREPARED' RETURNING *`, [id, txHash])).rows[0]);
    });
  }
  const server = createServer(async (req, res) => {
    const expected = Buffer.from(`Bearer ${token}`);
    const received = Buffer.from(req.headers.authorization ?? '');
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return send(401, { error: 'UNAUTHORIZED' });
    try {
      if (req.method === 'GET' && req.url === '/v1/capabilities') return send(200, {
        protocol: 'ARCO_STOCKS_SIGNER_V1', profile: 'DEMO_TESTNET', chainId: 91342,
        signerAddress: manifest.signerAddress, noncePolicy: 'DURABLE_SERIALIZED',
        operationPolicy: 'IMMUTABLE_IDEMPOTENT', replacementPolicy: 'DISABLED',
      });
      const match = /^\/v1\/operations\/([^/?]+)$/.exec(req.url ?? '');
      if (!match) return send(404, { error: 'NOT_FOUND' });
      const id = decodeURIComponent(match[1]);
      if (req.method === 'GET') { const value = await lookup(id); return send(value ? 200 : 404, value ?? { error: 'UNKNOWN' }); }
      if (req.method !== 'PUT') return send(405, { error: 'METHOD_NOT_ALLOWED' });
      let input = ''; for await (const chunk of req) { input += chunk; if (input.length > 16384) throw new Error('BODY_LIMIT'); }
      const result = await submit(id, JSON.parse(input));
      return send(result ? 200 : 503, result ?? { error: 'UNKNOWN' });
    } catch {
      return send(503, { error: 'LOCAL_SIGNER_UNKNOWN_OR_INVALID' });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { controls, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
