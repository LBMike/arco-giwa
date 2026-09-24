import { constants } from "fs"
import { open, realpath, writeFile } from "fs/promises"
import path from "path"

export const DEPLOYMENT_JSON_MAX_BYTES = 1024 * 1024
function publicPath(value: string): string {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    value
      .split(/[\\/]/)
      .some((part) => part.toLowerCase().startsWith(".env") || part.toLowerCase() === ".secrets")
  )
    throw Error("INVALID_PUBLIC_DEPLOYMENT_PATH")
  return value
}

/** Explicit regular public JSON only, with a byte cap even if the file grows during a read. */
export async function readPublicDeploymentJson(value: string): Promise<unknown> {
  try {
    const source = publicPath(path.resolve(publicPath(value)))
    const target = publicPath(await realpath(source))
    const file = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > DEPLOYMENT_JSON_MAX_BYTES) throw Error()
      const buffer = Buffer.alloc(DEPLOYMENT_JSON_MAX_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > DEPLOYMENT_JSON_MAX_BYTES) throw Error()
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)),
      )
    } finally {
      await file.close()
    }
  } catch {
    throw Error("INVALID_PUBLIC_DEPLOYMENT_JSON")
  }
}

export async function writePublicDeploymentJson(value: string, data: unknown): Promise<void> {
  try {
    const output = publicPath(path.resolve(publicPath(value)))
    const parent = publicPath(await realpath(path.dirname(output)))
    const encoded = JSON.stringify(data, null, 2)
    if (typeof encoded !== "string") throw Error()
    const text = encoded + "\n"
    if (Buffer.byteLength(text, "utf8") > DEPLOYMENT_JSON_MAX_BYTES) throw Error()
    await writeFile(path.join(parent, path.basename(output)), text, { flag: "wx", mode: 0o600 })
  } catch {
    throw Error("PUBLIC_DEPLOYMENT_JSON_NOT_WRITTEN")
  }
}
