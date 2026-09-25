import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, statSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSecretPassword, withPrivateKeystoreCopy } from './secret-files.mjs';

test('password file: one UTF-8 line, a single trailing newline dropped, bounded, never echoed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-files-'));
  try {
    const cases = [['plain', 'SYNTHETIC-pass word'], ['lf', 'SYNTHETIC\n'], ['crlf', 'SYNTHETIC\r\n']];
    for (const [name, content] of cases) {
      writeFileSync(join(dir, name), content, { mode: 0o444 });
      assert.equal(await readSecretPassword(join(dir, name)), content.replace(/\r?\n$/, ''));
    }
    for (const [name, content] of [['empty', ''], ['newline-only', '\n'], ['two-lines', 'a\nb'], ['nul', 'a\0b'],
      ['big', 'x'.repeat(4097)], ['bad-utf8', Buffer.from([0xff, 0xfe])]]) {
      writeFileSync(join(dir, name), content);
      await assert.rejects(() => readSecretPassword(join(dir, name)), error => error.message === 'SECRET_FILE_INVALID' && !/SYNTHETIC|x{8}/.test(String(error.stack)));
    }
    await assert.rejects(() => readSecretPassword('relative/path'), /SECRET_FILE_INVALID/);
    await assert.rejects(() => readSecretPassword(join(dir, '.env.password')), /SECRET_FILE_INVALID/);
    await assert.rejects(() => readSecretPassword(dir), /SECRET_FILE_INVALID/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('keystore copy: a read-only or linked secret mount becomes a private 0600 file that is removed after use', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-files-'));
  const scratch = mkdtempSync(join(tmpdir(), 'secret-files-scratch-'));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  try {
    const source = join(dir, 'mounted.json'), link = join(dir, 'linked.json');
    writeFileSync(source, '{"version":3}', { mode: 0o444 });
    symlinkSync(source, link);
    let seen;
    const result = await withPrivateKeystoreCopy(link, async copy => {
      seen = copy;
      const info = statSync(copy);
      assert.equal(info.mode & 0o777, 0o600); assert.equal(statSync(join(copy, '..')).mode & 0o777, 0o700);
      assert.equal(info.nlink, 1); assert.equal(info.uid, process.getuid());
      assert.equal(readFileSync(copy, 'utf8'), '{"version":3}');
      return 'UNLOCKED';
    });
    assert.equal(result, 'UNLOCKED'); assert.equal(existsSync(seen), false);
    await assert.rejects(() => withPrivateKeystoreCopy(source, async () => { throw new Error('LOADER_FAILED'); }), /LOADER_FAILED/);
    assert.deepEqual(readdirSync(scratch), []);
    writeFileSync(join(dir, 'big.json'), Buffer.alloc(1024 * 1024 + 1));
    await assert.rejects(() => withPrivateKeystoreCopy(join(dir, 'big.json'), async () => 'NEVER'), /SECRET_FILE_INVALID/);
    assert.deepEqual(readdirSync(scratch), []);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    rmSync(dir, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true });
  }
});
