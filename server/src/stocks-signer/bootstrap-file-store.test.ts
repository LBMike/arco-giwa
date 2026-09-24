import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBootstrapFileStore } from './bootstrap-file-store.js';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(realpathSync(tmpdir()), 'bootstrap-state-'));
  await chmod(dir, 0o700); t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, store: createBootstrapFileStore(dir) };
}
test('atomic exclusive records persist across adapters with restrictive ownership and no overwrite', async t => {
  const { dir, store } = await fixture(t);
  assert.equal(await store.read('plan'), null);
  await store.create('plan', { value: 'public-only' });
  assert.deepEqual(await createBootstrapFileStore(dir).read('plan'), { value: 'public-only' });
  assert.equal((await stat(join(dir, 'plan.json'))).mode & 0o777, 0o600);
  await assert.rejects(store.create('plan', { value: 'replacement' }), /BOOTSTRAP_STATE_UNAVAILABLE/);
  assert.match(await readFile(join(dir, 'plan.json'), 'utf8'), /public-only/);
  const concurrent = await Promise.allSettled([store.create('intent', { id: 1 }), store.create('intent', { id: 2 })]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
});
test('rejects symlink, hardlink, FIFO, oversized, torn, and open-permission records', async t => {
  for (const kind of ['symlink', 'hardlink', 'fifo', 'oversize', 'torn', 'mode']) {
    const { dir, store } = await fixture(t); const target = join(dir, 'plan.json');
    if (kind === 'fifo') execFileSync('mkfifo', ['-m', '600', target]);
    else if (kind === 'symlink' || kind === 'hardlink') {
      const other = join(dir, 'other'); await writeFile(other, '{}', { mode: 0o600 });
      if (kind === 'symlink') await symlink(other, target); else await link(other, target);
    } else await writeFile(target, kind === 'oversize' ? 'x'.repeat(16_385) : kind === 'torn' ? '{' : '{}', { mode: kind === 'mode' ? 0o644 : 0o600 });
    await assert.rejects(store.read('plan'), /BOOTSTRAP_STATE_UNAVAILABLE/);
  }
});
test('requires an owned restrictive real directory and rejects unrecognized filenames', async t => {
  const { dir, store } = await fixture(t);
  await assert.rejects(store.read('../escape' as 'plan'), /BOOTSTRAP_STATE_UNAVAILABLE/);
  await chmod(dir, 0o755); await assert.rejects(store.create('plan', {}), /BOOTSTRAP_STATE_UNAVAILABLE/);
  await chmod(dir, 0o700); const alias = `${dir}-alias`; await symlink(dir, alias); t.after(() => rm(alias));
  await assert.rejects(createBootstrapFileStore(alias).read('plan'), /BOOTSTRAP_STATE_UNAVAILABLE/);
});
