import assert from "assert/strict"
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, stat } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { spawnSync } from "child_process"
import {
  DEPLOYMENT_JSON_MAX_BYTES,
  readPublicDeploymentJson,
  writePublicDeploymentJson,
} from "../../scripts/stocks/public-deployment-json"

describe("Stocks public deployment JSON boundaries", () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "stocks-public-json-"))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const invalid = /^Error: INVALID_PUBLIC_DEPLOYMENT_JSON$/
  const unwritten = /^Error: PUBLIC_DEPLOYMENT_JSON_NOT_WRITTEN$/

  it("round-trips explicit public JSON with private file permissions and refuses overwrite", async () => {
    const file = path.join(root, "plan.json"),
      value = { label: "테스트", nonce: "0" }
    await writePublicDeploymentJson(file, value)
    assert.deepEqual(await readPublicDeploymentJson(file), value)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    await assert.rejects(writePublicDeploymentJson(file, { changed: true }), unwritten)
    assert.deepEqual(await readPublicDeploymentJson(file), value)
    const alias = path.join(root, "alias.json")
    await symlink(file, alias)
    await assert.rejects(writePublicDeploymentJson(alias, {}), unwritten)
    assert.deepEqual(await readPublicDeploymentJson(alias), value)
  })

  it("accepts the exact byte cap and rejects excess, malformed UTF-8 and malformed JSON", async () => {
    const file = path.join(root, "input.json")
    await writeFile(file, "{}" + " ".repeat(DEPLOYMENT_JSON_MAX_BYTES - 2))
    assert.deepEqual(await readPublicDeploymentJson(file), {})
    for (const data of [
      " ".repeat(DEPLOYMENT_JSON_MAX_BYTES + 1),
      "{PRIVATE",
      Buffer.from([0xc3, 0x28]),
    ]) {
      await writeFile(file, data)
      await assert.rejects(readPublicDeploymentJson(file), invalid)
    }
    await assert.rejects(
      writePublicDeploymentJson(path.join(root, "too-large.json"), {
        text: "x".repeat(DEPLOYMENT_JSON_MAX_BYTES),
      }),
      unwritten,
    )
    await assert.rejects(
      writePublicDeploymentJson(path.join(root, "undefined.json"), undefined),
      unwritten,
    )
  })

  it("rejects forbidden path spellings before opening files or making output", async () => {
    for (const value of [
      "relative.json",
      path.join(root, ".env"),
      path.join(root, ".secrets", "input.json"),
      `${root}/.ENV-hidden/../input.json`,
      `${root}/bad\0file`,
    ]) {
      await assert.rejects(readPublicDeploymentJson(value), invalid)
      await assert.rejects(writePublicDeploymentJson(value, {}), unwritten)
    }
  })

  it("rejects directories and nonblocking named pipes without waiting for a writer", async () => {
    const folder = path.join(root, "folder")
    await mkdir(folder)
    await assert.rejects(readPublicDeploymentJson(folder), invalid)
    const fifo = path.join(root, "pipe")
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0)
    await assert.rejects(readPublicDeploymentJson(fifo), invalid)
  })

  it("redacts missing paths and rejects forbidden parent spellings", async () => {
    await assert.rejects(readPublicDeploymentJson(path.join(root, "PRIVATE-missing.json")), invalid)
    // No credential directory is created or opened: the forbidden lexical parent is rejected first.
    await assert.rejects(writePublicDeploymentJson(`${root}/.secrets/../safe.json`, {}), unwritten)
    assert.equal(await readFile(path.join(root, "safe.json")).catch(() => null), null)
  })
})
