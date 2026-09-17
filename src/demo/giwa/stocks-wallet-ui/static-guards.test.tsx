import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import test from "node:test"

const ROOT = join(process.cwd(), "src/demo/giwa/stocks-wallet-ui")

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

const all = files(ROOT).filter((path) => /\.(ts|tsx|html)$/.test(path))
const isTest = (path: string) => /\.test\.tsx$/.test(path)
const inFixtureOrVerification = (path: string) => /^(fixtures|verification)\//.test(relative(ROOT, path))
const feature = all.filter((path) => !isTest(path) && !inFixtureOrVerification(path))
const read = (path: string) => readFileSync(path, "utf8")
/** Source without comments, for rules about what code does (comments may name what it must not do). */
const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1")

/** Bodies of effect/timer calls, found by balanced parentheses. */
function callBodies(source: string, names: string[]): string[] {
  const bodies: string[] = []
  for (const name of names) {
    let index = source.indexOf(`${name}(`)
    while (index !== -1) {
      let depth = 0
      let end = index + name.length
      for (; end < source.length; end++) {
        if (source[end] === "(") depth++
        else if (source[end] === ")" && --depth === 0) break
      }
      bodies.push(source.slice(index, end + 1))
      index = source.indexOf(`${name}(`, end)
    }
  }
  return bodies
}

test("no browser storage anywhere in the module", () => {
  for (const path of all.filter((file) => !file.endsWith("static-guards.test.tsx"))) {
    assert.doesNotMatch(read(path), /\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/, relative(ROOT, path))
  }
})

test("feature code: no fixture import, console output or floating-point money handling", () => {
  assert.ok(feature.length >= 8, `feature files: ${feature.length}`)
  for (const path of feature) {
    const source = read(path)
    const name = relative(ROOT, path)
    assert.doesNotMatch(source, /fixtures\/|verification\//, `${name} must not import fixtures or verification code`)
    assert.doesNotMatch(source, /console\.(log|info|warn|error)/, name)
    assert.doesNotMatch(source, /\bparseFloat\b|\.toFixed\(|\bNumber\(|\bparseInt\b|\bMath\.round\(/, name)
  }
})

test("feature code supplies no verification, policy, journal, wallet or transport default", () => {
  for (const path of feature) {
    const source = code(path)
    const name = relative(ROOT, path)
    assert.doesNotMatch(source, /"VERIFIED"|allowed:\s*true|status:\s*"CONFIRMED"/, `${name}: no fake evidence or terminal status literal`)
    assert.doesNotMatch(source, /\bfetch\(|window\.ethereum|eth_sendTransaction|requestTransaction\(|createSubmissionGate|createStocksWalletController\(/, `${name}: no transport, wallet, journal or controller is created here`)
  }
})

test("controller actions are invoked only by the adapter mapping, never from effects or timers", () => {
  const callers = feature.filter((path) => /\.(prepare|approve|submit)\(\)/.test(code(path))).map((path) => relative(ROOT, path))
  assert.deepEqual(callers, ["adapter.ts"])
  for (const path of feature) {
    for (const body of callBodies(code(path), ["useEffect", "useLayoutEffect", "useIsomorphicLayoutEffect", "setTimeout", "setInterval", "queueMicrotask"])) {
      assert.doesNotMatch(body, /\bactions\b|\.prepare\(|\.approve\(|\.submit\(|\bactivate\(/, `${relative(ROOT, path)}: ${body.slice(0, 60)}`)
    }
  }
})

test("only the verification page and tests use the fixtures; the public entry exports neither", () => {
  const users = all.filter((path) => /scripted-wallet/.test(read(path)) && !relative(ROOT, path).startsWith("fixtures"))
  for (const path of users) assert.match(relative(ROOT, path), /\.test\.tsx$|^verification\//)
  const index = code(join(ROOT, "index.ts"))
  assert.match(index, /StocksWalletExecutionPanel/)
  assert.match(index, /StocksWalletPanel/)
  assert.match(index, /useStocksWalletPanel/)
  assert.doesNotMatch(index, /fixtures|verification|scripted-wallet|FIXTURE_/)
})

test("the verification page is not part of the application entry, router or build input", () => {
  for (const path of ["index.html", "src/main.tsx", "src/demo/giwa/routes.ts", "vite.config.ts"]) {
    assert.doesNotMatch(readFileSync(join(process.cwd(), path), "utf8"), /stocks-wallet-ui/, path)
  }
})
