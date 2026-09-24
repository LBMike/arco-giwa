import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, mkdir, open, constants } from 'node:fs/promises';
import { join, dirname, isAbsolute, basename } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createServer } from 'node:net';
import { findPostgres } from '../stocks-local/owner.mjs';
import { inspectMigrationsDirectory } from '../prisma/inspect-migrations.mjs';
import { readLocalCustomerServerConfig, localCustomerEnvironment } from './local-environment.mjs';
import { checkPreflightDatabase } from '../../server/dist/stocks-preflight/database.js';
import { readStocksPublicJson } from '../../server/dist/stocks-runtime/public-config.js';
import { parseStocksRuntimeConfig } from '../../server/dist/stocks-runtime/runtime.js';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const pendingStocksMigrations = [
  '20260916000000_stocks_testnet', '20260917000000_stocks_redemption',
  '20260918000000_stocks_wallet_submissions', '20260919000000_stocks_wallet_receipts',
  '20260920000000_stocks_trading_control',
];
const fail = code => Error(code);
// Serializes process/cluster lifetime before PostgreSQL is available. No HTTP or data endpoint.
export async function acquireLocalDemoLock() {
  const server=createServer(socket=>socket.destroy());
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(4396,'127.0.0.1',resolve);});
  return ()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
export function quietChild(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: 'C' },
      stdio: 'ignore', ...options });
    const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
    const error = () => fail(`LOCAL_PREPARATION_COMMAND_FAILED:${basename(program)}`);
    child.once('error', () => { clearTimeout(timer); reject(error()); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(error()); });
  });
}
export async function ownedPrivateDirectory(path, create = false) {
  if (!isAbsolute(path)) throw fail('LOCAL_PRIVATE_DIRECTORY_INVALID');
  if (create) {
    await ownedPrivateDirectory(dirname(path));
    await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  }
  for (let current = path;; current = dirname(current)) {
    const s = await lstat(current);
    if (!s.isDirectory() || s.isSymbolicLink()) throw fail('LOCAL_PRIVATE_DIRECTORY_INVALID');
    if (current === path && (s.uid !== process.getuid?.() || s.mode & 0o077)) throw fail('LOCAL_PRIVATE_DIRECTORY_INVALID');
    if (current === dirname(current)) break;
  }
}
export async function exclusiveJson(path, value) {
  await ownedPrivateDirectory(dirname(path));
  const f = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await f.writeFile(JSON.stringify(value) + '\n'); await f.sync(); } finally { await f.close(); }
  const d = await open(dirname(path), constants.O_RDONLY);
  try { await d.sync(); } finally { await d.close(); }
}
export async function migrationFiles() {
  const directory = join(root, 'prisma/migrations');
  if (inspectMigrationsDirectory(directory).length) throw fail('LOCAL_MIGRATION_SQL_REJECTED');
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).filter(e => e.isDirectory()).sort((a,b) => a.name.localeCompare(b.name))) {
    result.push({ name: entry.name, checksum: createHash('sha256').update(await readFile(join(directory, entry.name, 'migration.sql'))).digest('hex') });
  }
  return result;
}
export function validateMigrationHistory(rows, migrations) {
  const expected = new Map(migrations.map(m => [m.name, m.checksum]));
  if (rows.some(r => !r.finished_at || r.rolled_back_at || expected.get(r.migration_name) !== r.checksum)
    || new Set(rows.map(r => r.migration_name)).size !== rows.length) throw fail('LOCAL_MIGRATION_HISTORY_REJECTED');
  const applied = new Set(rows.map(r => r.migration_name));
  const missing = migrations.filter(m => !applied.has(m.name)).map(m => m.name);
  if (missing.length && missing.join(',') !== pendingStocksMigrations.slice(pendingStocksMigrations.length - missing.length).join(','))
    throw fail('LOCAL_MIGRATION_HISTORY_REJECTED');
  return missing;
}
export async function prepareProductDatabase({ serverPath, runtimePath, apply = false, report = () => {} }) {
  const config = parseStocksRuntimeConfig(await readStocksPublicJson(runtimePath), true);
  const env = localCustomerEnvironment(await readLocalCustomerServerConfig(serverPath), runtimePath);
  const migrations = await migrationFiles();
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2, connectionTimeoutMillis: 8000,
    statement_timeout: 10000, query_timeout: 12000, application_name: 'arco_local_demo_setup' });
  pool.on('error', () => {});
  let client;
  try {
    client = await pool.connect();
    await client.query("SELECT pg_advisory_lock(hashtext('arco-local-stocks-migration-012'))");
    const history = await client.query('SELECT migration_name, checksum, finished_at, rolled_back_at FROM public._prisma_migrations ORDER BY started_at');
    const missing = validateMigrationHistory(history.rows, migrations);
    report({ stage: 'DATABASE_HISTORY_VERIFIED', pending: missing.length });
    if (missing.length && !apply) return { status: 'MIGRATIONS_REQUIRED', pending: missing.length };
    if (missing.length) {
      // Explicit reviewed migration step, never on API startup. Child output may contain a URL: suppress it.
      await quietChild(process.execPath, [join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
        env: { ...env, DATABASE_URL: env.DIRECT_URL, DOTENV_CONFIG_PATH: '/dev/null' },
      });
    }
    const result = await checkPreflightDatabase(pool, config.manifest, migrations, 'public', { operatorControls: true });
    if (!result.length || result.some(check => check.status !== 'PASS')) throw fail('LOCAL_DATABASE_PREFLIGHT_FAILED');
    report({ stage: 'DATABASE_PREFLIGHT_PASSED' });
    return { status: 'DATABASE_READY', result };
  } catch { throw fail('LOCAL_PRODUCT_DATABASE_PREPARATION_FAILED'); }
  finally {
    if (client) { await client.query("SELECT pg_advisory_unlock(hashtext('arco-local-stocks-migration-012'))").catch(() => {}); client.release(); }
    await pool.end();
  }
}

/** Dedicated durable signer cluster. No TCP listener, key data or product records. Never deletes a cluster. */
export async function prepareSignerDatabase(privateDirectory) {
  await ownedPrivateDirectory(privateDirectory);
  const base = join(privateDirectory, 'signer-postgres');
  await ownedPrivateDirectory(base, true);
  const data = join(base, 'data'), socket = join(base, 's'), bootstrapDirectory = join(base, 'bootstrap');
  await ownedPrivateDirectory(socket, true);
  // pg_ctl's -o is interpreted by its shell. This fixed local path must have no shell syntax or spaces.
  if (!/^[A-Za-z0-9_./-]+$/.test(base) || Buffer.byteLength(socket) > 85) throw fail('LOCAL_SIGNER_STORAGE_PATH_INVALID');
  const bin = findPostgres({ PATH: process.env.PATH });
  if (!bin) throw fail('LOCAL_POSTGRES_NOT_INSTALLED');
  const versionOutput = await promisify(execFile)(join(bin, 'postgres'), ['--version'], { timeout: 5000, maxBuffer: 1024 });
  const major = versionOutput.stdout.match(/PostgreSQL\)?\s+(\d+)/)?.[1];
  if (!['16','17','18'].includes(major)) throw fail('LOCAL_POSTGRES_VERSION_MISMATCH');
  const migrationHashes = await Promise.all(['0001_journal.sql','0002_signed_intent.sql'].map(async name => ({ name,
    checksum: createHash('sha256').update(await readFile(join(root, 'server/src/stocks-signer/migrations', name))).digest('hex') })));
  const identityRecord = { version: 1, purpose: 'ARCO_GIWA_LOCAL_SIGNER_012', major, data, socket, migrationHashes };
  const identityPath = join(base, 'identity.json');
  const command = (name, args) => quietChild(join(bin, name), args);
  let dataExists = true;
  try { await lstat(data); } catch (e) { if (e.code !== 'ENOENT') throw e; dataExists = false; }
  if (!dataExists) {
    // This marker is exclusive. A prior interrupted initialization requires inspection, never reset.
    await exclusiveJson(identityPath, identityRecord);
    await ownedPrivateDirectory(bootstrapDirectory, true);
    await command('initdb', ['-D', data, '-A', 'trust', '--no-locale', '-E', 'UTF8', '-U', 'arco_signer',
      '-c', 'shared_memory_type=mmap', '-c', 'dynamic_shared_memory_type=mmap', '-c', 'shared_buffers=16MB', '-c', 'max_connections=20']);
  }
  await ownedPrivateDirectory(data);
  await ownedPrivateDirectory(bootstrapDirectory);
  const storedIdentity = await readLocalCustomerServerConfig(identityPath);
  if (JSON.stringify(storedIdentity) !== JSON.stringify(identityRecord)
    || (await readFile(join(data, 'PG_VERSION'), 'utf8')).trim() !== major) throw fail('LOCAL_POSTGRES_IDENTITY_MISMATCH');
  const proofPath = join(base, 'provisioned.json');
  let proof;
  try { await lstat(proofPath); proof = await readLocalCustomerServerConfig(proofPath); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  let running = true, started = false;
  try { await command('pg_ctl', ['-D', data, 'status']); } catch { running = false; }
  const stop = () => command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
  try {
  if (!running) {
    await command('pg_ctl', ['-D', data, '-l', join(base, 'postgres.log'), '-o',
      `-k ${socket} -h '' -p 5432 -c unix_socket_permissions=0700 -c shared_memory_type=mmap -c dynamic_shared_memory_type=mmap -c shared_buffers=16MB -c max_connections=20`, '-w', 'start']);
    started = true;
  }
  const connection = database => `postgresql://arco_signer@localhost/${database}?host=${encodeURIComponent(socket)}`;
  const poolOptions = { max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 6000, lock_timeout: 5000 };
  const pool = new pg.Pool({ ...poolOptions, connectionString: connection('postgres') });
  pool.on('error', () => {});
  let systemIdentifier, databaseOid;
  try {
    const identity = (await pool.query("SELECT current_user AS role, current_setting('data_directory') AS data, current_setting('listen_addresses') AS listen, current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS sync, current_setting('full_page_writes') AS full, system_identifier::text AS system FROM pg_control_system()")).rows[0];
    if (identity.role !== 'arco_signer' || identity.data !== data || identity.listen !== ''
      || identity.fsync !== 'on' || identity.sync !== 'on' || identity.full !== 'on') throw fail('LOCAL_SIGNER_DATABASE_IDENTITY_INVALID');
    systemIdentifier = identity.system;
    const exists = await pool.query("SELECT oid::text AS oid FROM pg_database WHERE datname='arco_signer_journal'");
    if (proof && (!exists.rowCount || proof.systemIdentifier !== systemIdentifier || proof.databaseOid !== exists.rows[0].oid)
      || !proof && exists.rowCount) throw fail('LOCAL_SIGNER_STORAGE_REVIEW_REQUIRED');
    if (!exists.rowCount) await pool.query('CREATE DATABASE arco_signer_journal');
    databaseOid = (await pool.query("SELECT oid::text AS oid FROM pg_database WHERE datname='arco_signer_journal'")).rows[0].oid;
  } finally { await pool.end(); }
  const journal = new pg.Pool({ ...poolOptions, connectionString: connection('arco_signer_journal') });
  journal.on('error', () => {});
  let client;
  try {
    client = await journal.connect();
    await client.query("SELECT pg_advisory_lock(hashtext('arco-signer-schema-012'))");
    if (!proof) {
      await client.query('BEGIN');
      try { await client.query(await readFile(join(root, 'server/src/stocks-signer/migrations/0001_journal.sql'), 'utf8')); await client.query('COMMIT'); }
      catch { await client.query('ROLLBACK'); throw fail('LOCAL_SIGNER_SCHEMA_FAILED'); }
      await client.query(await readFile(join(root, 'server/src/stocks-signer/migrations/0002_signed_intent.sql'), 'utf8'));
    }
    // Capture deterministic physical schema and guard definitions; existing storage must match its first provisioning.
    const catalog = await client.query(`SELECT 'column' AS kind, c.table_name || '.' || c.column_name AS name, row_to_json(c)::text AS definition
      FROM information_schema.columns c WHERE c.table_schema='stocks_signer'
      UNION ALL SELECT 'constraint', c.relname || '.' || k.conname, pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='stocks_signer'
      UNION ALL SELECT 'trigger', c.relname || '.' || t.tgname, t.tgenabled::text || pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='stocks_signer' AND NOT t.tgisinternal
      UNION ALL SELECT 'function', p.proname, pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='stocks_signer' ORDER BY kind,name`);
    const schemaDigest = createHash('sha256').update(JSON.stringify(catalog.rows)).digest('hex');
    const bootstrapIdentity = String((await lstat(bootstrapDirectory)).ino);
    const readyProof = { version: 1, systemIdentifier, databaseOid, schemaDigest, migrationHashes, bootstrapDirectory, bootstrapIdentity };
    if (proof && JSON.stringify(proof) !== JSON.stringify(readyProof)) throw fail('LOCAL_SIGNER_SCHEMA_CHANGED');
    if (!proof) await exclusiveJson(proofPath, readyProof);
    await client.query('SELECT "initialNonce", "nextNonce" FROM stocks_signer.account_nonce LIMIT 1');
    return { connectionString: connection('arco_signer_journal'), data, socket, bootstrapDirectory, started, stop };
  } finally {
    if (client) { await client.query("SELECT pg_advisory_unlock(hashtext('arco-signer-schema-012'))").catch(() => {}); client.release(); }
    await journal.end();
  }
  } catch (error) { if (started) await stop(); throw error; }
}
