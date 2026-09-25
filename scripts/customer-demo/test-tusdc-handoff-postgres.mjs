import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { findPostgres } from '../stocks-local/owner.mjs';
const root = resolve(import.meta.dirname, '../..'), bin = findPostgres();
if (!bin) throw Error('HANDOFF_TEST_POSTGRES_UNAVAILABLE');
const temp = mkdtempSync(join(tmpdir(), 'tusdc-handoff-pg-')), data = join(temp, 'data'), socket = join(temp, 's');
mkdirSync(socket); let started = false;
const run = (name, args, env = process.env) => {
  const program = ['initdb','pg_ctl','createdb','psql'].includes(name) ? join(bin, name) : name;
  const r = spawnSync(program, args, { cwd: root, env, stdio: 'inherit' });
  if (r.error || r.status !== 0) throw Error(`HANDOFF_TEST_FAILED:${name}`);
};
try {
  run('initdb', ['-D',data,'-A','trust','--no-locale','-E','UTF8','-U','handoff_test','-c','shared_memory_type=mmap','-c','dynamic_shared_memory_type=mmap','-c','shared_buffers=16MB']);
  run('pg_ctl', ['-D',data,'-l',join(temp,'postgres.log'),'-o',`-k ${socket} -h '' -p 5432 -c shared_memory_type=mmap -c dynamic_shared_memory_type=mmap -c shared_buffers=16MB`,'-w','start']); started = true;
  for (const database of ['arco_signer_journal','arco_signer_tusdc_025']) {
    run('createdb', ['-h',socket,'-U','handoff_test',database]);
    for (const migration of ['0001_journal.sql','0002_signed_intent.sql']) run('psql', ['-h',socket,'-U','handoff_test','-d',database,'-v','ON_ERROR_STOP=1','-f',join(root,'server/src/stocks-signer/migrations',migration)]);
  }
  for (const migration of readdirSync(join(root,'prisma/migrations')).sort().filter(n => /^\d/.test(n)))
    run('psql', ['-h',socket,'-U','handoff_test','-d','arco_signer_journal','-v','ON_ERROR_STOP=1','-f',join(root,'prisma/migrations',migration,'migration.sql')]);
  run('npm',['run','build:server']);
  const connection = database => `postgresql://handoff_test@localhost/${database}?host=${encodeURIComponent(socket)}`;
  run(process.execPath,['--test','--test-concurrency=1','server/dist/stocks-signer/external-cash-handoff.postgres.test.js'], { ...process.env, STOCKS_HANDOFF_TEST_ONLY:'1',
    STOCKS_HANDOFF_PRIOR_DATABASE_URL:connection('arco_signer_journal'), STOCKS_HANDOFF_NEXT_DATABASE_URL:connection('arco_signer_tusdc_025') });
} finally {
  if (started || existsSync(join(data,'postmaster.pid'))) {
    const result = spawnSync(join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],{stdio:'inherit'});
    if (result.status !== 0 || existsSync(join(data,'postmaster.pid'))) throw Error('HANDOFF_TEST_POSTGRES_CLEANUP_REQUIRED');
  }
  rmSync(temp,{recursive:true,force:true});
}
