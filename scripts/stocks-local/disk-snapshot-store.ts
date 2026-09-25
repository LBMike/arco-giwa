import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { open, unlink } from "node:fs/promises"
import { dirname, isAbsolute } from "node:path"
import { randomUUID } from "node:crypto"
import type { MarketSnapshotStore } from "../../server/src/stocks-market-data/snapshot-store"

type Snapshot = NonNullable<Awaited<ReturnType<MarketSnapshotStore["read"]>>>
type File = { version: 1; scope: string; records: Record<string, Snapshot> }
const MAX_BYTES = 32 * 1024 * 1024
const MAX_RECORDS = 321
const STALE_LOCK_MS = 60000
const SCOPE = /^[a-f0-9]{64}$/
const KEY = /^(?:quotes|(?:profile|aum|issuer):[A-Z][A-Z0-9.-]{0,13}|chart:[A-Z][A-Z0-9.-]{0,13}:(?:1D|1W|1M|3M|1Y))$/

function load(path: string): File | null {
  try {
    if (existsSync(path)) {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("INVALID_MARKET_SNAPSHOT_FILE")
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<File>
      if (parsed.version === 1 && typeof parsed.scope === "string" && SCOPE.test(parsed.scope) && parsed.records && typeof parsed.records === "object" && !Array.isArray(parsed.records) && Object.keys(parsed.records).length <= MAX_RECORDS) return parsed as File
    }
  } catch { /* Corrupt or absent local snapshots never reach the market service. */ }
  return null
}

/** Private local-demo cache. A short file lock keeps two preview processes from losing each other's writes. */
export function createDiskMarketSnapshotStore(path: string): MarketSnapshotStore {
  if (!isAbsolute(path) || !path.endsWith(".json") || path.length > 2048) throw new Error("INVALID_MARKET_SNAPSHOT_PATH")
  return {
    async read(scope, key) {
      if (!SCOPE.test(scope) || !KEY.test(key)) return null
      const file = load(path)
      const snapshot = file?.scope === scope ? file.records[key] : null
      return snapshot ? structuredClone(snapshot) : null
    },
    async write(scope, key, snapshot) {
      if (!SCOPE.test(scope) || !KEY.test(key) || !Number.isSafeInteger(snapshot.fetchedAt) || snapshot.fetchedAt < 0 || (snapshot.sourceTimestamp !== null && (!Number.isSafeInteger(snapshot.sourceTimestamp) || snapshot.sourceTimestamp < 0))) throw new Error("INVALID_MARKET_SNAPSHOT")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const lockPath = `${path}.lock`
      let lock: Awaited<ReturnType<typeof open>> | null = null
      for (let attempt = 0; attempt < 80; attempt++) {
        try { lock = await open(lockPath, "wx", 0o600); break }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
          // A crashed preview can leave a lock file behind. Only reclaim locks
          // older than any expected atomic JSON write, and never follow a link.
          try {
            const existing = lstatSync(lockPath)
            if (existing.isFile() && Date.now() - existing.mtimeMs > STALE_LOCK_MS) {
              unlinkSync(lockPath)
              continue
            }
          } catch (inspectError) {
            if ((inspectError as NodeJS.ErrnoException).code !== "ENOENT") throw inspectError
          }
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      }
      if (!lock) throw new Error("MARKET_SNAPSHOT_LOCKED")
      try {
        const file = load(path)
        const records = file?.scope === scope ? { ...file.records } : {}
        const previous = records[key]
        if (previous && (previous.fetchedAt > snapshot.fetchedAt || (previous.sourceTimestamp !== null && (snapshot.sourceTimestamp === null || previous.sourceTimestamp > snapshot.sourceTimestamp)))) return
        if (!Object.prototype.hasOwnProperty.call(records, key) && Object.keys(records).length >= MAX_RECORDS) throw new Error("MARKET_SNAPSHOT_CAPACITY")
        records[key] = structuredClone(snapshot)
        const contents = JSON.stringify({ version: 1, scope, records } satisfies File)
        if (Buffer.byteLength(contents) > MAX_BYTES) throw new Error("MARKET_SNAPSHOT_CAPACITY")
        const temporary = `${path}.${randomUUID()}.tmp`
        try {
          writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" })
          renameSync(temporary, path)
        } catch (error) {
          try { unlinkSync(temporary) } catch { /* already renamed or never created */ }
          throw error
        }
      } finally {
        const owned = await lock.stat()
        await lock.close()
        try {
          const current = lstatSync(lockPath)
          if (current.dev === owned.dev && current.ino === owned.ino) await unlink(lockPath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }
    },
  }
}
