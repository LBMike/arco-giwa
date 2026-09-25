import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { open, lstat, constants } from 'node:fs/promises';
import { dirname, isAbsolute, join, basename, resolve } from 'node:path';
import { createLocalCustomerServerConfig } from './local-environment.mjs';
import { databaseInputIssue, setupDiagnostic } from './setup-diagnostics.mjs';

let cancel, cancelled = false;
let stage='STARTUP', diagnostic;
const stop = () => { cancelled = true; cancel?.(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output' || !isAbsolute(args[1])
    || !process.stdin.isTTY || !process.stdout.isTTY) { diagnostic='TTY_REQUIRED'; throw Error('LOCAL_TTY_REQUIRED'); }
  stage='STORAGE';
  const output = resolve(args[1]), parent = dirname(output);
  // Walk every ancestor before accepting input; no symlink path to a secret file.
  for (let current = parent;; current = dirname(current)) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('UNSAFE_DIRECTORY');
    if (current === dirname(current)) break;
  }
  const directory = await lstat(parent);
  if (directory.uid !== process.getuid?.() || directory.mode & 0o077) throw Error('UNSAFE_DIRECTORY');
  try { await lstat(output); diagnostic='CONFIGURATION_EXISTS'; throw Error('CONFIGURATION_ALREADY_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  stage='STARTUP';
  const requireContracts = createRequire(new URL('../../packages/contracts/package.json', import.meta.url));
  requireContracts('ts-node').register({ project: fileURLToPath(new URL('../../packages/contracts/tsconfig.json', import.meta.url)) });
  const { promptHidden } = requireContracts('./scripts/hidden-prompt.ts');
  console.log('Supabase 서버 연결 설정 — 지갑 서명·DB 변경 없음');
  console.log('Render의 DATABASE_URL 값을 붙여넣으세요. 입력은 표시되지 않으며 채팅으로 보내지 않습니다.');
  let connection;
  stage='URL_POLICY';
  try {
    if (cancelled) throw Error('CANCELLED');
    const pending = promptHidden('Supabase 연결 URL (postgresql://...): ');
    cancel = () => process.stdin.emit('data', Buffer.from([3]));
    connection = await pending;
  } catch(error) {
    if(error instanceof Error&&error.message==='Cancelled')diagnostic='CANCELLED';
    throw error;
  } finally { cancel = undefined; process.stdin.pause(); }
  if (cancelled) throw Error('CANCELLED');
  diagnostic=databaseInputIssue(connection);
  if(diagnostic)throw Error('INVALID_INPUT');
  const config = createLocalCustomerServerConfig(connection);
  connection = undefined;
  stage='STORAGE';
  // wx never replaces existing credentials. Close/sync before announcing success.
  const file = await open(join(parent, basename(output)), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(config) + '\n'); await file.sync(); }
  finally { await file.close(); }
  const dir = await open(parent, constants.O_RDONLY);
  try { await dir.sync(); } finally { await dir.close(); }
  console.log('로컬 서버 설정 저장 완료. 연결값을 채팅에 보내지 마세요.');
} catch {
  console.error(setupDiagnostic(cancelled?'CANCELLED':diagnostic??stage));
  process.exitCode = 1;
} finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
