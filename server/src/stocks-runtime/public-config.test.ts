import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readStocksPublicJson, stocksPublicConfigPath } from './public-config.js';
import { configuredStocksRuntime } from './runtime.js';

const expected = { message: 'INVALID_STOCKS_PUBLIC_JSON', code: 'INVALID_STOCKS_PUBLIC_JSON' };

test('public configuration rejects protected path components without opening secrets files', () => {
  for (const path of ['', '/public/.env', '/public/.EnV.config', '/public/.ENV.example',
    '/public/.SeCrEtS/config.json', '.env-backup/../public.json', 'public\\.secrets\\config.json', 'public\0.json']) {
    assert.throws(() => stocksPublicConfigPath(path), expected);
  }
  for (const path of ['public.json', '/public/settings.json', '/public/secrets-free.json']) assert.equal(stocksPublicConfigPath(path), path);
});

test('public JSON supports relative paths and public symlinks, decodes UTF-8, and accepts exactly 64 KiB', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stocks-public-json-'));
  try {
    const path = join(dir, 'public.json'), alias = join(dir, 'alias.json');
    const json = JSON.stringify({ label: '운영자😀' });
    await writeFile(path, json + ' '.repeat(65536 - Buffer.byteLength(json)));
    await symlink(path, alias);
    for (const input of [path, alias, relative(process.cwd(), path)]) assert.deepEqual(await readStocksPublicJson(input), { label: '운영자😀' });
    await writeFile(path, json + ' '.repeat(65537 - Buffer.byteLength(json)));
    await assert.rejects(readStocksPublicJson(path), expected);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('public JSON fails closed on malformed bytes, JSON, missing files and non-regular files with no input in errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stocks-public-json-'));
  try {
    const path = join(dir, 'public.json');
    for (const data of [Buffer.from([0x22, 0xff, 0x22]), Buffer.from([0x22, 0xed, 0xa0, 0x80, 0x22]),
      Buffer.from('{ INVALID_INPUT_MUST_NOT_APPEAR_IN_ERROR }'), Buffer.alloc(0)]) {
      await writeFile(path, data);
      await assert.rejects(readStocksPublicJson(path), expected);
    }
    await assert.rejects(readStocksPublicJson(join(dir, 'missing.json')), expected);
    await assert.rejects(readStocksPublicJson(dir), expected);
    await symlink(join(dir, 'loop.json'), join(dir, 'loop.json'));
    await assert.rejects(readStocksPublicJson(join(dir, 'loop.json')), expected);
    // No protected file is created or read: this alias resolves to an existing
    // permitted directory followed by a protected, deliberately absent path.
    await symlink(dir, join(dir, 'directory-alias'));
    await assert.rejects(readStocksPublicJson(join(dir, 'directory-alias/.EnV-absent')), expected);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('named pipe input is rejected without waiting for a writer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stocks-public-json-pipe-'));
  try {
    const pipe = join(dir, 'config.pipe');
    assert.equal(spawnSync('mkfifo', [pipe], { timeout: 2000 }).status, 0);
    const script = `import {readStocksPublicJson} from './server/dist/stocks-runtime/public-config.js';
      try { await readStocksPublicJson(process.argv[1]); process.exitCode=2; }
      catch (error) { console.log(error.message); }`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, pipe], { encoding: 'utf8', timeout: 3000 });
    assert.equal(child.status, 0, String(child.error));
    assert.equal(child.stdout.trim(), expected.message); assert.equal(child.stderr, '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('configured server rejects invalid public JSON before constructing external runtime dependencies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stocks-public-runtime-'));
  try {
    const path = join(dir, 'public.json');
    const env = { STOCKS_MODE: 'DEMO_TESTNET', STOCKS_CONFIG_PATH: path, STOCKS_SIGNER_TOKEN: 'TEST_ONLY' };
    for (const bytes of [Buffer.from([0x22, 0xff, 0x22]), Buffer.from('{}' + ' '.repeat(65535))]) {
      await writeFile(path, bytes);
      await assert.rejects(configuredStocksRuntime(env, 'never-connect'), expected);
    }
    assert.equal(await configuredStocksRuntime({ STOCKS_MODE: 'DISABLED', STOCKS_CONFIG_PATH: path }, 'never-connect'), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
