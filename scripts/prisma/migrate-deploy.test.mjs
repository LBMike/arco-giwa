import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const cli = fileURLToPath(new URL('./migrate-deploy.mjs', import.meta.url))
const bootstrap = 'CREATE SCHEMA IF NOT EXISTS arco_evm;'
function fixture(t, sql) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'giwa-migrate-cli-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin'), proof = path.join(root, 'prisma-called')
  fs.mkdirSync(bin)
  if (sql !== undefined) {
    const migration = path.join(root, 'prisma', 'migrations', '001_test')
    fs.mkdirSync(migration, { recursive: true })
    fs.writeFileSync(path.join(migration, 'migration.sql'), sql)
  }
  // Native CLI subprocess; the only Prisma executable on PATH is our stub.
  // No database client or dotenv loader runs, even if the guard regresses.
  fs.writeFileSync(path.join(bin, 'prisma'), `#!${process.execPath}\n` +
    `require('node:fs').writeFileSync(process.env.TEST_PRISMA_PROOF, 'called');\n` +
    `console.log(JSON.stringify({args:process.argv.slice(2),usingDirect:process.env.DATABASE_URL===process.env.DIRECT_URL}));\n`, { mode: 0o700 })
  return { proof, run(direct = true) {
    return spawnSync(process.execPath, [cli], { cwd: root, encoding: 'utf8', timeout: 10000,
      env: { PATH: bin, TEST_PRISMA_PROOF: proof, DATABASE_URL: 'postgresql://runtime.example.invalid/db',
        ...(direct ? { DIRECT_URL: 'postgresql://migration.example.invalid/db' } : {}) } })
  } }
}

test('deployment blocks foreign schema, malformed or missing history before invoking Prisma', async t => {
  for (const sql of [undefined, bootstrap + 'CREATE TABLE public.waitlist (id text);',
    bootstrap + 'CREATE TABLE other.private_data (id text);', bootstrap + 'DO $$ incomplete']) {
    const f = fixture(t, sql), result = f.run()
    assert.ifError(result.error); assert.equal(result.status, 1)
    assert.equal(fs.existsSync(f.proof), false)
    assert.doesNotMatch(result.stdout + result.stderr, /postgresql:\/\//)
  }
})

test('deployment accepts inspected aliases and still passes only DIRECT_URL to Prisma', t => {
  const f = fixture(t, bootstrap + 'SELECT 1 FROM arco_evm.proof p WHERE p.id=1;')
  const result = f.run()
  assert.ifError(result.error); assert.equal(result.status, 0); assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), { args: ['migrate', 'deploy'], usingDirect: true })
  assert.equal(fs.readFileSync(f.proof, 'utf8'), 'called')
})

test('valid history cannot fall back to runtime credentials when DIRECT_URL is missing', t => {
  const f = fixture(t, bootstrap), result = f.run(false)
  assert.ifError(result.error); assert.equal(result.status, 1)
  assert.match(result.stderr, /DIRECT_URL is required/)
  assert.equal(fs.existsSync(f.proof), false)
  assert.doesNotMatch(result.stdout + result.stderr, /postgresql:\/\//)
})
