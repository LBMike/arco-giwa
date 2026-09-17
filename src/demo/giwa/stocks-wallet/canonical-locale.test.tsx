// Browser planner digests must equal the backend's frozen en-US vectors whatever the process default locale is.
// Each case runs a FRESH Node process with a real LANG/LC_ALL and checks that Intl actually resolved it: a mocked
// localeCompare would not prove anything.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repo = fileURLToPath(new URL("../../../../", import.meta.url))
const probe = fileURLToPath(new URL("./canonical-locale-probe.ts", import.meta.url))
const LOCALES = [
  ["en_US.UTF-8", "en-US"],
  ["cs_CZ.UTF-8", "cs-CZ"],
  ["sk_SK.UTF-8", "sk-SK"],
] as const

// Only runtime discovery and the chosen locale are passed: never tokens, DB or deployment settings.
const environment = (lang: string) => ({ PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: lang, LC_ALL: lang, TZ: "UTC" })

for (const [lang, locale] of LOCALES) {
  test(`browser canonical digests and planner match the frozen en-US backend vectors under a real ${locale} process`, (t) => {
    const child = spawnSync(process.execPath, ["--import", "tsx", probe], { cwd: repo, env: environment(lang), encoding: "utf8", timeout: 60_000 })
    assert.equal(child.error, undefined)
    const line = child.stdout.trim().split("\n").pop() ?? ""
    const result = JSON.parse(line) as { locale: string; node: string; icu: string; vectorCount: number; failures: string[]; adapter: string; defaultLocaleOrderMatchesGolden: boolean }
    t.diagnostic(JSON.stringify(result))
    assert.equal(result.locale, locale, "the child really runs with the requested default locale")
    assert.equal(result.vectorCount, 13)
    // Negative control: without the pinned locale, cs/sk would reorder the manifest keys.
    assert.equal(result.defaultLocaleOrderMatchesGolden, locale === "en-US")
    assert.deepEqual(result.failures, [], `golden mismatches: ${result.failures.join(", ")}`)
    assert.equal(result.adapter, "ACCEPTED", "en-US server evidence is accepted by the read adapter")
    assert.equal(child.status, 0, child.stderr)
  })
}

for (const [lang, locale] of LOCALES.slice(1)) {
  test(`actual server plugin DTOs → read adapter → planner roundtrip passes under a real ${locale} process`, () => {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--test", "src/demo/giwa/stocks-wallet-http/server-roundtrip.test.tsx"], { cwd: repo, env: environment(lang), encoding: "utf8", timeout: 120_000 })
    assert.equal(child.error, undefined)
    assert.match(child.stdout, /ℹ pass 5\b/, child.stdout.slice(-2_000))
    assert.match(child.stdout, /ℹ fail 0\b/)
    assert.equal(child.status, 0)
  })
}
