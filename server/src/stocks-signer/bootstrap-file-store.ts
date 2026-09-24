import { constants } from 'node:fs';
import { lstat, open, link, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson, StocksError } from '../stocks/contracts.js';
import type { BootstrapRecordName, BootstrapStore } from './bootstrap-faucet.js';

const fail = () => new StocksError('BOOTSTRAP_STATE_UNAVAILABLE', 503);
const maxBytes = 16_384;
/** Caller creates the owned 0700 directory; no directory creation or discovery. */
export function createBootstrapFileStore(directory: string): BootstrapStore {
  if (!isAbsolute(directory) || resolve(directory) !== directory) throw fail();
  async function checkedDirectory() {
    let current = directory;
    while (true) {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail();
      if (current === directory && (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)) throw fail();
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  }
  function target(name: BootstrapRecordName) {
    if (!['plan', 'intent', 'handoff'].includes(name)) throw fail();
    return join(directory, `${name}.json`);
  }
  return {
    async read(name) {
      let dir, file;
      try {
        dir = await checkedDirectory();
        try { file = await open(target(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
        const stat = await file.stat();
        if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600
          || stat.nlink !== 1 || stat.size < 2 || stat.size > maxBytes) throw fail();
        const bytes = Buffer.alloc(maxBytes + 1);
        const result = await file.read(bytes, 0, bytes.length, 0);
        if (result.bytesRead !== stat.size || result.bytesRead > maxBytes) throw fail();
        return JSON.parse(bytes.subarray(0, result.bytesRead).toString('utf8')) as unknown;
      } catch { throw fail(); }
      finally { await file?.close(); await dir?.close(); }
    },
    async create(name, value) {
      let dir, file, temporary: string | undefined;
      try {
        const destination = target(name);
        const bytes = Buffer.from(`${canonicalJson(value)}\n`);
        if (bytes.length < 3 || bytes.length > maxBytes) throw fail();
        dir = await checkedDirectory();
        temporary = join(directory, `.pending-${randomUUID()}`);
        file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await file.writeFile(bytes); await file.sync(); await file.close(); file = undefined;
        // link is an atomic, exclusive publication. A crash with both links
        // present is rejected by read's nlink check rather than guessed valid.
        await link(temporary, destination);
        await unlink(temporary); temporary = undefined;
        await dir.sync();
      } catch { throw fail(); }
      finally {
        await file?.close();
        if (temporary) { try { await unlink(temporary); } catch { /* preserve original failure */ } }
        await dir?.close();
      }
    },
  };
}
