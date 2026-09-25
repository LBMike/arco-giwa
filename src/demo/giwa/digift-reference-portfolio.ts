import type { BreakdownRow } from '../data/acapix-detail'
import type { DigiFTPortfolioSnapshot } from './digift-reference-research'

/** Adapt dated underlying-fund disclosures to the same Portfolio UI as auMINT. */
export function digiftPortfolioCardData(snapshot: DigiFTPortfolioSnapshot | undefined, symbol: string) {
  if (!snapshot) {
    return {
      updatedAt: '—',
      note: `A verified underlying-fund allocation breakdown is not available for ${symbol}.`,
      total: null,
      snapshot: [] as BreakdownRow[],
      industry: [] as BreakdownRow[],
      exposure: [] as BreakdownRow[],
    }
  }

  const rows: BreakdownRow[] = snapshot.rows.map((row) => ({
    label: row.label,
    value: null,
    pct: Number(row.percent.slice(0, -1)),
  }))

  // The disclosed kTW50 top holdings are only part of the ETF. The fixed donut
  // would otherwise normalize those five positions into a misleading full pie.
  // The remainder may include other holdings and exposures, so do not call it stocks.
  if (snapshot.partial) {
    const reportedBasisPoints = rows.reduce((sum, row) => sum + Math.round(row.pct * 100), 0)
    const remainderBasisPoints = 10_000 - reportedBasisPoints
    if (remainderBasisPoints > 0) {
      rows.push({ label: 'Remaining portfolio weight (calculated)', value: null, pct: remainderBasisPoints / 100 })
    }
  }

  // Classify only the named snapshot rows. An unreported sector stays explicit
  // rather than being guessed; basis points keep grouped weights exact.
  const byLabel = new Map(rows.map((row) => [row.label, row]))
  const classified = new Set<string>()
  const industry: BreakdownRow[] = (snapshot.industryGroups ?? []).map((group) => {
    const basisPoints = group.rowLabels.reduce((sum, label) => {
      const row = byLabel.get(label)
      if (!row || classified.has(label)) return sum
      classified.add(label)
      return sum + Math.round(row.pct * 100)
    }, 0)
    return { label: group.label, value: null, pct: basisPoints / 100 }
  }).filter((row) => row.pct > 0)
  const unclassifiedBasisPoints = rows.reduce((sum, row) =>
    sum + (classified.has(row.label) ? 0 : Math.round(row.pct * 100)), 0)
  if (unclassifiedBasisPoints > 0) {
    industry.push({ label: snapshot.unclassifiedIndustryLabel ?? 'Industry not disclosed', value: null, pct: unclassifiedBasisPoints / 100 })
  }

  return {
    updatedAt: snapshot.asOf,
    note: `${snapshot.title} · ${snapshot.scope}. ${snapshot.sourceLabel}, as of ${snapshot.asOf}. Percentages describe the underlying fund, not Arco token holdings. Industry is derived from the named snapshot rows; sectors without a displayed basis remain unclassified. Exposure mirrors the disclosed allocation.${snapshot.partial ? ' Only selected top holdings are shown; the remaining portfolio weight is calculated and may include other exposures.' : ''}`,
    total: null,
    snapshot: rows,
    industry,
    exposure: rows.map((row) => ({ ...row })),
  }
}
