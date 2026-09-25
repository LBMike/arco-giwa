import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

// Hosted signer inputs arrive as platform secret files (e.g. Render mounts them
// under /etc/secrets, possibly as root-owned links into a managed directory).
// These helpers read them with fixed bounds and never echo their contents.
const MAX_KEYSTORE_BYTES = 1024 * 1024;
const MAX_PASSWORD_BYTES = 4096;
const invalid = () => new Error('SECRET_FILE_INVALID');

async function readBounded(path, maxBytes) {
  if (typeof path !== 'string' || !isAbsolute(path)
    || path.split(/[\\/]/).some(part => part.toLowerCase().startsWith('.env'))) throw invalid();
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > maxBytes) throw invalid();
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size) { buffer.fill(0); throw invalid(); }
    return buffer.subarray(0, bytesRead);
  } finally { await file.close(); }
}

/** One line of UTF-8; a single trailing LF or CRLF (as a dashboard editor may add) is dropped. */
export async function readSecretPassword(path) {
  const bytes = await readBounded(path, MAX_PASSWORD_BYTES);
  try {
    let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.endsWith('\r\n')) text = text.slice(0, -2);
    else if (text.endsWith('\n')) text = text.slice(0, -1);
    if (!text || /[\r\n\0]/.test(text)) throw invalid();
    return text;
  } catch { throw invalid(); }
  finally { bytes.fill(0); }
}

/**
 * The reviewed keystore loader (packages/contracts/scripts/stocks/local-keystore.ts)
 * only opens a regular, owner-only (0600) file owned by this process with no links.
 * A platform secret mount does not meet that, so pass it a private copy in a fresh
 * 0700 directory and remove the copy as soon as the loader has finished.
 */
export async function withPrivateKeystoreCopy(path, use) {
  const bytes = await readBounded(path, MAX_KEYSTORE_BYTES);
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'arco-signer-'));
    const copy = join(directory, 'keystore.json');
    await writeFile(copy, bytes, { mode: 0o600, flag: 'wx' });
    return await use(copy);
  } finally {
    bytes.fill(0);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
