import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { compileBackend } from './backend-build.mjs';

const root = resolve(import.meta.dirname, '../..');
async function fixture(t) {
  const directory = await mkdtemp('/tmp/stocks-backend-build-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'server/src'), { recursive: true });
  await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(directory, 'server/tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', rootDir: 'src',
    outDir: 'dist', skipLibCheck: true, types: [] }, include: ['src/**/*.ts'] }));
  await writeFile(join(directory, 'server/src/app.ts'), "export { value } from './dependency.js';");
  return { directory, build: () => compileBackend({ root: directory, resourceDir: directory }),
    write: value => writeFile(join(directory, 'server/src/dependency.ts'), value) };
}

test('fresh output reloads transitive code and retains the previously loaded generation', async t => {
  const f = await fixture(t);
  await f.write('export const value = 1;');
  const first = await f.build(); const old = await first.import('app.js');
  await f.write('export const value = 2;');
  const second = await f.build(); const next = await second.import('app.js');
  assert.equal(old.value, 1); assert.equal(next.value, 2);
  assert.notEqual(first.directory, second.directory);
  assert.equal((await first.import('app.js')).value, 1);
});

test('a type error cannot emit over the serving generation; a subsequent corrected build succeeds', async t => {
  const f = await fixture(t);
  await f.write('export const value = 1;');
  const first = await f.build(); const original = await readFile(join(first.directory, 'dependency.js'), 'utf8');
  await f.write('export const value: number = "broken";');
  await assert.rejects(f.build(), { code: 'LOCAL_BACKEND_BUILD_FAILED' });
  assert.equal(await readFile(join(first.directory, 'dependency.js'), 'utf8'), original);
  assert.equal((await first.import('app.js')).value, 1);
  await f.write('export const value = 3;');
  assert.equal((await (await f.build()).import('app.js')).value, 3);
});

test('shutdown cancels a compiler before cleaning its output directory', async t => {
  const f = await fixture(t);
  await f.write('export const value = 1;');
  const abort = new AbortController();
  const building = compileBackend({ root: f.directory, resourceDir: f.directory, signal: abort.signal });
  setTimeout(() => abort.abort(), 50);
  await assert.rejects(building);
});
