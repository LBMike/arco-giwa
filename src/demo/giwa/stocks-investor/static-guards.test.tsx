import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import test from "node:test"

const ROOT = join(process.cwd(), "src/demo/giwa/stocks-investor")

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

const all = files(ROOT).filter((path) => /\.(ts|tsx|html)$/.test(path))
const featureFiles = all.filter((path) => !/\.test\.tsx$/.test(path) && !relative(ROOT, path).startsWith("fixtures") && !relative(ROOT, path).startsWith("verification"))

test("the module never uses browser storage for tokens, orders or anything else", () => {
  for (const path of all.filter((file) => !file.endsWith("static-guards.test.tsx"))) {
    assert.doesNotMatch(readFileSync(path, "utf8"), /\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/, relative(ROOT, path))
  }
})

test("feature code has no floating-point money parsing and no fixture fallback", () => {
  assert.ok(featureFiles.length >= 10)
  for (const path of featureFiles) {
    const source = readFileSync(path, "utf8")
    const name = relative(ROOT, path)
    assert.doesNotMatch(source, /\bparseFloat\b|\.toFixed\(|\bNumber\(|\bparseInt\b|\bMath\.round\(/, name)
    assert.doesNotMatch(source, /fixtures\//, `${name} must not import fixtures`)
    assert.doesNotMatch(source, /console\.(log|info|warn|error)/, name)
  }
})

test("only the verification page and tests use the fixture server", () => {
  const users = all.filter((path) => /fake-stocks-server|controller-harness/.test(readFileSync(path, "utf8")) && !relative(ROOT, path).startsWith("fixtures"))
  for (const path of users) assert.match(relative(ROOT, path), /\.test\.tsx$|^verification\//)
})

test("the public entry exports the feature, the client and the host contract types only", () => {
  const index = readFileSync(join(ROOT, "index.ts"), "utf8")
  assert.match(index, /GiwaStocksFeature/)
  assert.match(index, /createGiwaStocksHttpClient/)
  assert.doesNotMatch(index, /fixtures|controller-harness|fake-stocks-server/)
})
