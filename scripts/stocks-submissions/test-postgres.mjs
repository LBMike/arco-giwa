import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '../..');
const extra = process.argv.slice(2).map(value => {
 const path = realpathSync(resolve(root,value));
 if (relative(root,path).startsWith('..') || !statSync(path).isFile() || !/\.(?:test\.js|mjs)$/.test(path)) throw new Error('INVALID_EXPLICIT_TEST_FILE');
 return path;
});
const bin = process.env.STOCKS_PG_BIN ?? '/opt/homebrew/Cellar/postgresql@18/18.6/bin';
const temp = mkdtempSync('/private/tmp/stocks-submissions-pg-'); const data=join(temp,'data'), socket=join(temp,'socket'); mkdirSync(socket);
const evidence = { temp, data, socket, tcp: false, started: false, stopped: false, restarts: 0, pids: [] };
function run(command,args,env) { const result=spawnSync(command,args,{cwd:root,stdio:'inherit',env:env??process.env}); if(result.error||result.status!==0)throw new Error(`HARNESS_COMMAND_FAILED:${command.split('/').pop()}:${result.status}`); }
function pg(command,args){run(join(bin,command),args)}
function start(){pg('pg_ctl',['-D',data,'-l',join(temp,'postgres.log'),'-o',`-k ${socket} -h '' -p 5432 -c fsync=on -c shared_memory_type=mmap -c dynamic_shared_memory_type=mmap -c shared_buffers=16MB -c max_connections=20`,'-w','start']);evidence.started=true;evidence.pids.push(Number(readFileSync(join(data,'postmaster.pid'),'utf8').split('\n')[0]));}
function stop(){if(existsSync(join(data,'postmaster.pid'))){pg('pg_ctl',['-D',data,'-m','fast','-w','stop']);} if(existsSync(join(data,'postmaster.pid')))throw new Error('OWNED_DATABASE_STILL_RUNNING');evidence.stopped=true;}
try {
 pg('initdb',['-D',data,'-A','trust','--no-locale','-E','UTF8','-U','submissions_harness','-c','shared_memory_type=mmap','-c','dynamic_shared_memory_type=mmap','-c','shared_buffers=16MB','-c','max_connections=20']);
 start(); pg('createdb',['-h',socket,'-U','submissions_harness','submissions_test']);
 const psql=['-h',socket,'-U','submissions_harness','-d','submissions_test','-v','ON_ERROR_STOP=1'];
 pg('psql',[...psql,'-c','CREATE SCHEMA arco_evm']);
 for(const migration of ['20260916000000_stocks_testnet','20260917000000_stocks_redemption','20260918000000_stocks_wallet_submissions'])pg('psql',[...psql,'-f',join(root,'prisma/migrations',migration,'migration.sql')]);
 const env={...process.env,STOCKS_SUBMISSIONS_TEST_ONLY:'1',STOCKS_SUBMISSIONS_RESTART_FILE:join(temp,'restart-fixture.json'),STOCKS_SUBMISSIONS_TEST_DATABASE_URL:`postgresql://submissions_harness@localhost/submissions_test?host=${encodeURIComponent(socket)}`};
 env.STOCKS_TEST_HARNESS_ONLY='1';env.STOCKS_TEST_DATABASE_URL=env.STOCKS_SUBMISSIONS_TEST_DATABASE_URL;
 run(process.execPath,['--test','--test-concurrency=1','server/dist/stocks-submissions/postgres.test.js',...extra],env);
 run(process.execPath,['scripts/stocks-submissions/restart-probe.mjs','seed'],env);
 stop(); start(); evidence.stopped=false; evidence.restarts++;
 run(process.execPath,['scripts/stocks-submissions/restart-probe.mjs','verify'],env);
} finally { stop(); writeFileSync(join(temp,'harness-evidence.json'),JSON.stringify(evidence,null,2)+'\n'); console.log(`OWNED_PG_EVIDENCE ${join(temp,'harness-evidence.json')}`); }
