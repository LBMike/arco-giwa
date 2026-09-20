import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ensure, StocksError } from '../stocks/contracts.js';

const limit = 65536;
const code = 'INVALID_STOCKS_PUBLIC_JSON';

export function stocksPublicConfigPath(value: string): string {
  ensure(typeof value === 'string' && value.length > 0 && !value.includes('\0') &&
    !value.split(/[\\/]/).some(part => part.toLowerCase().startsWith('.env') || part.toLowerCase() === '.secrets'), code);
  return value;
}

// Only the explicitly supplied public JSON file is opened. No dotenv loading,
// config discovery or fallback paths. The caller decides its schema policy.
export async function readStocksPublicJson(path: string): Promise<unknown> {
  try {
    const source = stocksPublicConfigPath(resolve(stocksPublicConfigPath(path)));
    const target = stocksPublicConfigPath(await realpath(source));
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      ensure(info.isFile() && info.size <= limit, code);
      // Read at most one byte beyond the limit, even if the file grows after
      // stat. Nonblocking open lets the regular-file check reject named pipes.
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      ensure(length <= limit, code);
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
    } finally { await file.close(); }
  } catch {
    // Filesystem and parsing errors may contain private paths or input text.
    throw new StocksError(code);
  }
}
