// Owner-facing entry point for the disposable local Stocks workspace.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const pgCommands = ['postgres', 'initdb', 'pg_ctl', 'createdb', 'psql'];

export function ownerEnvironment(source = process.env) {
  const env = {};
  // No inherited database, live chain, signer, wallet, Vite, or scenario flags.
  for (const key of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE'])
    if (source[key]) env[key] = source[key];
  return { ...env, PATH: `${dirname(process.execPath)}${delimiter}${source.PATH ?? ''}`,
    TMPDIR: '/tmp', NODE_OPTIONS: '', DOTENV_CONFIG_PATH: '/dev/null',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', STOCKS_LOCAL_STACK_ONLY: '1', STOCKS_LOCAL_OWNER: '1' };
}

export function findPostgres(source = process.env, present = existsSync) {
  const complete = directory => isAbsolute(directory) && pgCommands.every(name => present(join(directory, name)));
  if (source.STOCKS_PG_BIN !== undefined)
    return complete(source.STOCKS_PG_BIN) ? source.STOCKS_PG_BIN : null;
  const candidates = [
    ...(source.PATH ?? '').split(delimiter).filter(Boolean),
    ...['/opt/homebrew/opt', '/usr/local/opt'].flatMap(base => ['18', '17', '16'].map(v => `${base}/postgresql@${v}/bin`)),
    ...['18', '17', '16'].map(v => `/usr/lib/postgresql/${v}/bin`),
  ];
  return candidates.find(complete) ?? null;
}

export function checkWorkspace({ directory = root, source = process.env, node = process.versions.node,
  present = existsSync, run = spawnSync } = {}) {
  const [major, minor] = node.split('.').map(Number);
  const env = ownerEnvironment(source);
  const checks = [{ id: 'node', ok: major > 22 || major === 22 && minor >= 15,
    fix: 'Node 22.15 이상을 설치하세요.' }];
  for (const [id, file] of [['app-dependencies', 'node_modules/vite/package.json'],
    ['contract-dependencies', 'packages/contracts/node_modules/hardhat/package.json'],
    ['verification-dependencies', 'scripts/stocks-ci/node_modules/playwright/package.json']])
    checks.push({ id, ok: present(join(directory, file)), fix: 'npm run stocks:setup' });
  const corepack = run('corepack', ['--version'], { env, encoding: 'utf8', timeout: 10000 });
  checks.push({ id: 'corepack', ok: corepack.status === 0 && !corepack.error, fix: 'Node 환경에 Corepack을 설치하세요.' });
  const postgresBin = findPostgres(source, present);
  const pg = postgresBin ? run(join(postgresBin, 'initdb'), ['--version'], { env, encoding: 'utf8', timeout: 10000 }) : null;
  const pgMajor = Number(pg?.stdout?.match(/PostgreSQL\)?\s+(\d+)/)?.[1]);
  checks.push({ id: 'postgresql', ok: !!pg && pg.status === 0 && !pg.error && pgMajor >= 16,
    fix: 'PostgreSQL 16 이상을 설치하세요. 필요하면 STOCKS_PG_BIN에 bin 절대 경로를 지정하세요.' });
  return { ready: checks.every(check => check.ok), checks, postgresBin };
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...extra] = args;
  if (extra.length || !['check', 'setup', 'start'].includes(command)) {
    console.error('사용법: npm run stocks:setup | npm run stocks:doctor | npm run stocks:dev');
    return 2;
  }
  const env = ownerEnvironment();
  let active, interrupted;
  const stop = signal => { interrupted ??= signal; active?.kill('SIGTERM'); };
  const onInt = () => stop('SIGINT'), onTerm = () => stop('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  const run = async (program, values, cwd = root) => {
    if (interrupted) return false;
    active = spawn(program, values, { cwd, env, stdio: 'inherit' });
    const status = await new Promise((done, fail) => {
      active.once('error', fail);
      active.once('close', (code, signal) => done({ code, signal }));
    });
    active = undefined;
    return status.code === 0 && !status.signal && !interrupted;
  };
  try {
    if (command === 'setup') {
      const steps = [
        ['npm', ['ci']], ['npm', ['ci', '--prefix', 'scripts/stocks-ci', '--ignore-scripts']],
        ['npm', ['run', 'prisma:generate']],
        ['corepack', ['yarn', 'install', '--immutable'], join(root, 'packages/contracts')],
        ['corepack', ['yarn', 'compile'], join(root, 'packages/contracts')],
        ['npm', ['run', 'build:server']],
      ];
      for (const step of steps) if (!await run(...step)) return interrupted === 'SIGINT' ? 130 : interrupted ? 143 : 1;
      console.log('설치 완료. npm run stocks:doctor 로 실행 준비를 확인하세요.');
      return 0;
    }
    const report = checkWorkspace();
    console.log(JSON.stringify(report, null, 2));
    if (!report.ready || command === 'check') return report.ready ? 0 : 1;
    env.STOCKS_PG_BIN = report.postgresBin;
    if (!await run('npm', ['run', 'build:server'])) return interrupted === 'SIGINT' ? 130 : interrupted ? 143 : 1;
    console.log('로컬 테스트 제품을 준비합니다. 종료는 Ctrl+C. 매 실행마다 새 테스트 자산으로 시작합니다.');
    const ok = await run(process.execPath, ['scripts/stocks-local/run.mjs']);
    return interrupted === 'SIGINT' ? 130 : interrupted ? 143 : ok ? 0 : 1;
  } finally {
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, () => {
    console.error('로컬 실행 실패. stocks:doctor 결과와 직전 단계의 로그를 확인하세요.');
    process.exitCode = 1;
  });
}
