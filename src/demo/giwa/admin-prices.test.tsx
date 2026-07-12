import assert from "node:assert/strict"
import test from "node:test"
import { buildHistoryRows } from "./AdminPrices"

const DAY = 86_400

test("buildHistoryRows pairs consecutive points and orders newest first", () => {
  // Deliberately unordered input; navs chosen so consecutive vs skip-pairing differ:
  // 1.0 → 2.0 over 365d (APY 100%), then 2.0 → 2.0 over 365d (APY 0%). Pairing t3
  // against t1 instead would yield ~41.4%, so asserting 0 proves consecutive pairing.
  const t1 = 1_700_000_000
  const points = [
    { t: t1 + 365 * DAY, navBase: 2.0, navUsd: null },
    { t: t1, navBase: 1.0, navUsd: null },
    { t: t1 + 730 * DAY, navBase: 2.0, navUsd: null },
  ]
  const rows = buildHistoryRows(points)

  assert.deepEqual(
    rows.map((row) => row.t),
    [t1 + 730 * DAY, t1 + 365 * DAY, t1],
  )
  assert.equal(rows[0].impliedApy, 0)
  assert.equal(rows[1].impliedApy, 100)
  // the oldest post has no prior point to derive an APY from
  assert.equal(rows[2].impliedApy, null)
})

test("buildHistoryRows derives the implied APY from the NAV change over the period", () => {
  const t1 = 1_700_000_000
  const rows = buildHistoryRows([
    { t: t1, navBase: 1.0, navUsd: null },
    { t: t1 + 7 * DAY, navBase: 1.002, navUsd: null },
  ])
  const expected = (Math.pow(1.002, 365 / 7) - 1) * 100 // ≈ 10.98%
  assert.equal(rows.length, 2)
  assert.ok(rows[0].impliedApy !== null && Math.abs(rows[0].impliedApy - expected) < 1e-9)
})

test("buildHistoryRows returns null APY for zero-period pairs and empty input", () => {
  const t1 = 1_700_000_000
  const rows = buildHistoryRows([
    { t: t1, navBase: 1.0, navUsd: null },
    { t: t1, navBase: 1.5, navUsd: null },
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].impliedApy, null)
  assert.equal(rows[1].impliedApy, null)

  assert.deepEqual(buildHistoryRows([]), [])
})

test("previousNavBase returns the 2nd-to-last posted price; null under 2 posts", async () => {
  const { previousNavBase } = await import("./PriceFeedAdminPanel")
  const t1 = 1_700_000_000
  const point = (t: number, navBase: number) => ({ t, navBase, navUsd: null })

  // Deliberately unordered — must sort by t ascending, then take [len-2] (1.001, not 1.002 or 1.0).
  assert.equal(previousNavBase([point(t1 + 2 * DAY, 1.002), point(t1, 1.0), point(t1 + DAY, 1.001)]), 1.001)
  // Exactly 2 points → the older one.
  assert.equal(previousNavBase([point(t1 + DAY, 1.002), point(t1, 1.0)]), 1.0)
  // <2 posts / empty / null → null ("—").
  assert.equal(previousNavBase([point(t1, 1.0)]), null)
  assert.equal(previousNavBase([]), null)
  assert.equal(previousNavBase(null), null)
})

test("buildSlicesForSave rejects blank/exotic percents; clears empty to null; validates sum", async () => {
  const { buildSlicesForSave, sliceRowsSummary } = await import("./AdminConfig")
  const row = (label: string, percent: string, valueUsd = "") => ({ label, percent, valueUsd })

  // Fully blank set → null (clear override), no error.
  assert.deepEqual(buildSlicesForSave([]), { value: null })
  assert.deepEqual(buildSlicesForSave([row("", "", "")]), { value: null })

  // Label-only row with blank percent → error (not a silent 0% slice).
  const blankPct = buildSlicesForSave([row("Cash", ""), row("Bonds", "100")])
  assert.ok("error" in blankPct)
  assert.match(blankPct.error, /percent must be a number/)

  // Exponent/hex percent or USD → error (decimal-only).
  assert.ok("error" in buildSlicesForSave([row("A", "1e2")]))
  assert.ok("error" in buildSlicesForSave([row("A", "100", "1e5")]))

  // Sum not ~100 → error.
  assert.ok("error" in buildSlicesForSave([row("A", "60"), row("B", "30")]))

  // Valid → normalized slices.
  const ok = buildSlicesForSave([row("A", "60", "6000000"), row("B", "40")])
  assert.ok("value" in ok && ok.value)
  assert.equal(ok.value![1].valueUsd, null)

  // Badge summary flags invalid rows so it can't show a green tick while save is blocked.
  assert.equal(sliceRowsSummary([row("Cash", ""), row("Bonds", "100")]).hasInvalid, true)
  assert.equal(sliceRowsSummary([row("A", "60"), row("B", "40")]).hasInvalid, false)
  assert.equal(sliceRowsSummary([row("A", "60"), row("B", "40")]).sum, 100)
})

test("buildAcceptAssetsForSave derives savingVaultId/order, forces real APY live, clears empty to null", async () => {
  const { buildAcceptAssetsForSave } = await import("./AdminConfig")
  const row = (symbol: string, isDummy = false, apy = "", icon = "", sortOrder: number | null = null) => ({ symbol, icon, apy, isDummy, sortOrder })

  // Fully blank set → null (clear override), no error.
  assert.deepEqual(buildAcceptAssetsForSave([], "arcousd"), { value: null })
  assert.deepEqual(buildAcceptAssetsForSave([row("")], "arcousd"), { value: null })

  // Real row → savingVaultId = the vault, APY forced null (read live); dummy → null map, keeps APY.
  const ok = buildAcceptAssetsForSave([row("USDC"), row("RLUSD", true, "3.8")], "arcousd")
  assert.ok("value" in ok && ok.value)
  assert.equal(ok.value!.length, 2)
  assert.deepEqual(ok.value![0], { symbol: "USDC", icon: null, apy: null, savingVaultId: "arcousd", isDummy: false, sortOrder: null })
  assert.deepEqual(ok.value![1], { symbol: "RLUSD", icon: null, apy: 3.8, savingVaultId: null, isDummy: true, sortOrder: null })

  // A row's existing sortOrder is carried through untouched (field-preservation — the per-vault editor
  // never wipes the global order set by the SavingsOrderCard).
  const carried = buildAcceptAssetsForSave([row("USDC", false, "", "", 7)], "arcousd")
  assert.ok("value" in carried && carried.value)
  assert.equal(carried.value![0].sortOrder, 7)

  // A real row IGNORES any typed APY (input is dummy-only) — still stores null.
  const realApyIgnored = buildAcceptAssetsForSave([row("USDC", false, "99")], "arcousd")
  assert.ok("value" in realApyIgnored && realApyIgnored.value)
  assert.equal(realApyIgnored.value![0].apy, null)

  // A visually-blank Live row (empty symbol/icon) with only a hidden leftover APY is treated as
  // blank → dropped, NOT submitted-then-rejected with a misleading "symbol" error.
  assert.deepEqual(buildAcceptAssetsForSave([row("", false, "5")], "arcousd"), { value: null })
  // But a dummy row's APY still counts (it is a visible field) — kept, then flagged for the symbol.
  assert.ok("error" in buildAcceptAssetsForSave([row("", true, "5")], "arcousd"))

  // Icon over the 2048-char cap → error (client mirror of the server guard, no confusing round-trip 400).
  assert.ok("error" in buildAcceptAssetsForSave([{ symbol: "USDC", icon: `https://x/${"a".repeat(2100)}`, apy: "", isDummy: false, sortOrder: null }], "arcousd"))

  // Duplicate symbol (case-insensitive) → error.
  assert.ok("error" in buildAcceptAssetsForSave([row("USDC"), row("usdc", true, "3")], "arcousd"))

  // A dummy APY that is non-decimal (exponent) → error.
  assert.ok("error" in buildAcceptAssetsForSave([row("RLUSD", true, "1e2")], "arcousd"))
})
