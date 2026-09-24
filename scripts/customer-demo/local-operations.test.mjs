import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm, rename } from 'node:fs/promises';
import pg from 'pg';
import { validateMigrationHistory, pendingStocksMigrations, migrationFiles, prepareSignerDatabase, acquireLocalDemoLock } from './local-operations.mjs';

test('one local launcher owns cluster lifetime until release',async()=>{
  const release=await acquireLocalDemoLock();
  try{await assert.rejects(acquireLocalDemoLock(),/EADDRINUSE/);}finally{await release();}
  const again=await acquireLocalDemoLock();await again();
});

test('only the reviewed remaining Stocks suffix can migrate; drift and unfinished history fail closed', async () => {
  const migrations = await migrationFiles();
  const row = m => ({ migration_name:m.name, checksum:m.checksum, finished_at:new Date(), rolled_back_at:null });
  const legacy = migrations.filter(m => !pendingStocksMigrations.includes(m.name)).map(row);
  assert.equal(legacy.length, 10);
  assert.deepEqual(validateMigrationHistory(legacy, migrations), pendingStocksMigrations);
  assert.deepEqual(validateMigrationHistory(migrations.map(row), migrations), []);
  for (const rows of [legacy.slice(1), [...legacy,legacy[0]], [...legacy,{...row(migrations[10]),finished_at:null}],
    [...legacy,{...row(migrations[10]),checksum:'0'.repeat(64)}], [...legacy,row(migrations[11])]]) {
    assert.throws(() => validateMigrationHistory(rows,migrations), /HISTORY_REJECTED/);
  }
});

test('real durable signer PostgreSQL retains seed on restart and rejects lost database or altered guards', { timeout: 90000 }, async () => {
  const base = await mkdtemp('/private/tmp/arco-persist-test-');
  await chmod(base,0o700);
  let state, pool;
  try {
    state = await prepareSignerDatabase(base);
    pool = new pg.Pool({ connectionString:state.connectionString });
    await pool.query(`INSERT INTO stocks_signer.account_nonce ("chainId","signerAddress","networkInstance","checkpointNumber","checkpointHash","initialNonce","nextNonce") VALUES (91342,$1,'LOCAL_TEST_NETWORK_012','1',$2,42,42)`,['0x'+'1'.repeat(40),'0x'+'2'.repeat(64)]);
    await pool.end(); pool=undefined;
    await state.stop();
    state = await prepareSignerDatabase(base);
    pool = new pg.Pool({ connectionString:state.connectionString });
    assert.equal((await pool.query('SELECT "initialNonce"::text AS nonce FROM stocks_signer.account_nonce')).rows[0].nonce,'42');
    await pool.query('ALTER TABLE stocks_signer.account_nonce DISABLE TRIGGER account_nonce_guard');
    await assert.rejects(prepareSignerDatabase(base), /SCHEMA_CHANGED/);
    await pool.query('ALTER TABLE stocks_signer.account_nonce ENABLE TRIGGER account_nonce_guard');
    await pool.end(); pool=undefined;
    const admin = new pg.Pool({ connectionString:state.connectionString.replace('/arco_signer_journal?','/postgres?') });
    await admin.query('ALTER DATABASE arco_signer_journal RENAME TO preserved_journal');
    await admin.end();
    await assert.rejects(prepareSignerDatabase(base), /STORAGE_REVIEW_REQUIRED/);
    await state.stop(); state=undefined;
    // Retaining marker but losing data cannot create a new physical cluster.
    await rename(base+'/signer-postgres/data',base+'/signer-postgres/preserved-data');
    await assert.rejects(prepareSignerDatabase(base), /EEXIST/);
  } finally {
    await pool?.end();
    await state?.stop().catch(()=>{});
    await rm(base,{recursive:true,force:true});
  }
});
