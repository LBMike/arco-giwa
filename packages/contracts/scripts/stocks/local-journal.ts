import { constants } from "fs"
import { open, readdir, realpath, stat } from "fs/promises"
import path from "path"

export type LocalCreateIntent = {
  version: 1
  planDigest: string
  genesisHash: string
  deployer: string
  index: number
  nonce: string
  transactionHash: string
}
const fail = () => Error("LOCAL_DEPLOYMENT_JOURNAL_INVALID")
const allowedPath = (value: string) => {
  if (
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    value
      .split(/[\\/]/)
      .some((p) => p.toLowerCase().startsWith(".env") || p.toLowerCase() === ".secrets")
  )
    throw fail()
  return value
}
async function directory(value: string) {
  const target = allowedPath(await realpath(allowedPath(value)))
  const info = await stat(target)
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
    throw fail()
  if ((await readdir(target)).some((name) => !/^step-[0-4]\.json$/.test(name))) throw fail()
  return target
}
function intent(value: unknown): LocalCreateIntent {
  const v = value as LocalCreateIntent
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).sort().join(",") !==
      "deployer,genesisHash,index,nonce,planDigest,transactionHash,version" ||
    v.version !== 1 ||
    !Number.isInteger(v.index) ||
    v.index < 0 ||
    v.index > 4 ||
    !/^[0-9a-f]{64}$/.test(v.planDigest) ||
    !/^0x[0-9a-f]{40}$/.test(v.deployer) ||
    !/^(0|[1-9][0-9]{0,19})$/.test(v.nonce) ||
    !/^0x[0-9a-f]{64}$/.test(v.genesisHash) ||
    !/^0x[0-9a-f]{64}$/.test(v.transactionHash)
  )
    throw fail()
  return v
}

/** Exclusive immutable per-step claim; no raw transaction or secret is persisted. */
export async function persistLocalCreateIntent(root: string, value: LocalCreateIntent) {
  try {
    const entry = intent(value)
    const target = await directory(root)
    const file = await open(
      path.join(target, `step-${entry.index}.json`),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await file.writeFile(JSON.stringify(entry) + "\n", "utf8")
      await file.sync()
    } finally {
      await file.close()
    }
    const parent = await open(target, constants.O_RDONLY | constants.O_DIRECTORY)
    try {
      await parent.sync()
    } finally {
      await parent.close()
    }
  } catch {
    throw fail()
  }
}

export async function readLocalCreateIntents(root: string): Promise<LocalCreateIntent[]> {
  try {
    const target = await directory(root)
    const entries: LocalCreateIntent[] = []
    let gap = false
    for (let index = 0; index < 5; index++) {
      let file
      try {
        file = await open(
          path.join(target, `step-${index}.json`),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        )
      } catch (error: any) {
        if (error?.code === "ENOENT") {
          gap = true
          continue
        }
        throw fail()
      }
      try {
        const info = await file.stat()
        if (
          gap ||
          !info.isFile() ||
          info.size > 4096 ||
          info.nlink !== 1 ||
          (info.mode & 0o077) !== 0 ||
          info.uid !== process.getuid?.()
        )
          throw fail()
        const buffer = Buffer.alloc(4097)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        if (bytesRead > 4096 || bytesRead !== info.size) throw fail()
        const entry = intent(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)),
          ),
        )
        if (entry.index !== index) throw fail()
        entries.push(entry)
      } finally {
        await file.close()
      }
    }
    return entries
  } catch {
    throw fail()
  }
}
