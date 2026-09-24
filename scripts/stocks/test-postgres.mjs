import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = resolve(import.meta.dirname, '../..')
const temp = mkdtempSync(join(tmpdir(), 'giwa-stocks-pg-'))
const socket = join(temp, 'sock'); mkdirSync(socket)
const data = join(temp, 'data'); let started = false
const pgBin = process.env.STOCKS_PG_BIN
const pgCommand = command => pgBin && ['initdb', 'pg_ctl', 'createdb', 'psql'].includes(command) ? join(pgBin, command) : command
function run(command, args, extra = {}) {
  command = pgCommand(command)
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...extra })
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} failed (${result.status})`)
}
try {
  run('initdb', ['-D', data, '-A', 'trust', '--no-locale', '-E', 'UTF8', '-U', 'stocks_harness', '-c', 'shared_memory_type=mmap', '-c', 'dynamic_shared_memory_type=mmap', '-c', 'shared_buffers=16MB', '-c', 'max_connections=20'])
  run('pg_ctl', ['-D', data, '-l', join(temp, 'postgres.log'), '-o', `-k ${socket} -h '' -p 5432 -c shared_buffers=16MB -c max_connections=20 -c shared_memory_type=mmap -c dynamic_shared_memory_type=mmap`, '-w', 'start']); started = true
  run('createdb', ['-h', socket, '-U', 'stocks_harness', 'stocks_test'])
  for (const migration of readdirSync(join(root, 'prisma/migrations')).sort().filter(name => /^\d/.test(name))) run('psql', ['-h', socket, '-U', 'stocks_harness', '-d', 'stocks_test', '-v', 'ON_ERROR_STOP=1', '-f', join(root, 'prisma/migrations', migration, 'migration.sql')])
  run('npm', ['run', 'build:server'])
  const connection = `postgresql://stocks_harness@localhost/stocks_test?host=${encodeURIComponent(socket)}`
  run(process.execPath, ['--test', '--test-concurrency=1', 'server/dist/stocks/stocks.postgres.test.js'], { env: { ...process.env, STOCKS_TEST_DATABASE_URL: connection, STOCKS_TEST_HARNESS_ONLY: '1' } })
} finally {
  if (started || existsSync(join(data, 'postmaster.pid'))) {
    const stopped = spawnSync(pgCommand('pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'inherit' })
    if (stopped.error || stopped.status !== 0 || existsSync(join(data, 'postmaster.pid'))) {
      throw new Error(`Owned PostgreSQL cleanup could not confirm shutdown; retained ${temp} for explicit recovery`)
    }
  }
  rmSync(temp, { recursive: true, force: true })
}
