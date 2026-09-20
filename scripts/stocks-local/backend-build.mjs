// Owner workspace only. A unique output tree refreshes transitive ESM imports,
// without overwriting the code serving the current session or running npm hooks.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const backendFailure = code => Object.assign(Error(code), { status: 503, code });

export async function compileBackend({ root, resourceDir, signal }) {
  const directory = await mkdtemp(join(resourceDir, 'backend-'));
  try {
    signal?.throwIfAborted();
    await writeFile(join(directory, 'package.json'), '{"type":"module"}\n');
    await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
        '-p', join(root, 'server/tsconfig.json'), '--outDir', directory, '--noEmitOnError'],
      { cwd: root, signal, stdio: ['ignore', 'inherit', 'inherit'], timeout: 60000, killSignal: 'SIGKILL' });
      let error;
      child.once('error', value => { error = value; });
      // Wait for close even on abort: cleanup must not race the compiler.
      child.once('close', code => error || code !== 0
        ? reject(backendFailure('LOCAL_BACKEND_BUILD_FAILED')) : resolve());
    });
    signal?.throwIfAborted();
    return { directory, import: file => import(pathToFileURL(join(directory, file)).href) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function loadBackend(build) {
  const modules = await Promise.all(['app.js', 'stocks-runtime/runtime.js', 'stocks-runtime/session.js',
    'stocks-runtime/transport.js', 'stocks-submissions/service.js', 'stocks-submission-diagnostics/service.js',
    'stocks-market-data/index.js', 'stocks/reconciliation.js'].map(file => build.import(file)));
  return Object.assign({}, ...modules);
}
