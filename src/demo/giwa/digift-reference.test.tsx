import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import GiwaProductDetailPage from './ProductDetailPage'
import { GiwaCatalogTable } from './components'
import { DIGIFT_REFERENCE_ASSETS, digiftDisplayCategory, digiftReferenceAssetById, referenceAssetsForList } from './digift-reference-assets'
import { digiftPortfolioCardData } from './digift-reference-portfolio'
import { DIGIFT_RESEARCH } from './digift-reference-research'

const expected = [
  { symbol: 'CMBMINT', id: 'digift-cmbmint', category: 'Cash Management', page: 4 },
  { symbol: 'ULTRA', id: 'digift-ultra', category: 'Cash Management', page: 5 },
  { symbol: 'TKStable', id: 'digift-tkstable', category: 'Cash Management', page: 5 },
  { symbol: 'CMBBOND', id: 'digift-cmbbond', category: 'Income Strategies', page: 6 },
  { symbol: 'JX', id: 'digift-jx', category: 'Equity Exposure', page: 7 },
  { symbol: 'kTW50', id: 'digift-ktw50', category: 'Equity Exposure', page: 7 },
  { symbol: 'GOLDX', id: 'digift-goldx', category: 'Alternative Assets', page: 9 },
] as const

test('reference catalog contains exactly the seven eligible DigiFT products', () => {
  assert.deepEqual(
    DIGIFT_REFERENCE_ASSETS.map(({ symbol, id, category, sourcePage }) => ({
      symbol,
      id,
      category,
      page: sourcePage,
    })),
    expected,
  )
  assert.equal(new Set(DIGIFT_REFERENCE_ASSETS.map((asset) => asset.id)).size, expected.length)

  for (const excluded of ['iSNR', 'FLOWC', 'pEAK', 'dDBTC', 'hGITD']) {
    assert.ok(!DIGIFT_REFERENCE_ASSETS.some((asset) => asset.symbol.toLowerCase() === excluded.toLowerCase()))
    assert.equal(digiftReferenceAssetById(`digift-${excluded.toLowerCase()}`), undefined)
  }
})

test('reference terms are source-traced strings, never transaction-ready ledger values', () => {
  const requiredTextFields = [
    'id', 'symbol', 'name', 'category', 'manager', 'managerLogoPath', 'underlying', 'description',
    'liquidity', 'minInvestment', 'fee', 'settlement', 'metricLabel', 'metricValue',
    'sourceAsOf', 'sourceUrl',
  ] as const

  for (const asset of DIGIFT_REFERENCE_ASSETS) {
    for (const field of requiredTextFields) {
      assert.equal(typeof asset[field], 'string', `${asset.symbol}.${field} must be text`)
      assert.ok(asset[field].trim().length > 0, `${asset.symbol}.${field} must not be empty`)
    }
    assert.match(asset.id, /^digift-/)
    assert.equal(asset.referenceOnly, true)
    assert.equal(asset.sourceAsOf, '2026-09-01')
    assert.equal(asset.sourceUrl, 'https://digift.docsend.com/view/7trp6frneivpjg4c')
    assert.ok(Number.isInteger(asset.sourcePage) && asset.sourcePage > 0)
    assert.ok(asset.metricAsOf === null || /^\d{4}-\d{2}-\d{2}$/.test(asset.metricAsOf))
    assert.ok(asset.aum === null || (typeof asset.aum === 'string' && asset.aum.length > 0))
    assert.ok(asset.aum || asset.aumEstimate, `${asset.symbol} needs a displayed AUM`)
    if (asset.aumEstimate) {
      assert.equal(asset.aum, null, `${asset.symbol} source AUM must stay unreported`)
      assert.match(asset.aumEstimate.value, /^USD [0-9.]+ (?:million|billion)$/)
      assert.ok(asset.aumEstimate.basis.length > 20)
      assert.match(asset.aumEstimate.sourceUrl, /^https:\/\//)
      assert.ok(asset.aumEstimate.asOf === null || /^\d{4}-\d{2}-\d{2}$/.test(asset.aumEstimate.asOf))
    }
    assert.equal(digiftReferenceAssetById(asset.id), asset)
  }

  assert.equal(digiftReferenceAssetById('digift-goldx')?.metricValue, 'Tracks LBMA Gold Price')
  assert.equal(digiftReferenceAssetById('digift-goldx')?.metricAsOf, null)
  assert.equal(digiftReferenceAssetById('digift-tkstable')?.metricLabel, 'Yield to maturity')
  assert.equal(digiftReferenceAssetById('digift-jx')?.metricLabel, '12-month return')
  assert.deepEqual(
    DIGIFT_REFERENCE_ASSETS.filter((asset) => asset.aumEstimate).map((asset) => [asset.symbol, asset.aumEstimate?.value]),
    [['TKStable', 'USD 150 million'], ['CMBBOND', 'USD 689 million'], ['kTW50', 'USD 6.3 billion'], ['GOLDX', 'USD 526 million']],
  )
  assert.equal(digiftReferenceAssetById('digift-tkstable')?.aumEstimate?.illustrative, true)
  assert.equal(digiftReferenceAssetById('digift-tkstable')?.aumEstimate?.asOf, null)
  assert.equal(digiftReferenceAssetById('digift-ktw50')?.aumEstimate?.secondarySourceLabel, 'TAIFEX daily FX rate')
  assert.equal(digiftReferenceAssetById('digift-goldx')?.manager, 'Lion Global Investors')
})

test('additional fund research is dated, source-linked and scoped to fund or token', () => {
  assert.deepEqual(Object.keys(DIGIFT_RESEARCH).sort(), expected.map(({ id }) => id).sort())
  for (const asset of DIGIFT_REFERENCE_ASSETS) {
    const research = DIGIFT_RESEARCH[asset.id]
    assert.ok(research.facts.length > 0, `${asset.symbol} needs product-specific facts`)
    for (const fact of research.facts) {
      assert.ok(fact.label && fact.value && fact.scope && fact.sourceLabel)
      assert.match(fact.sourceUrl, /^https:\/\//)
      if (fact.asOf) assert.match(fact.asOf, /^\d{4}-\d{2}-\d{2}$/)
    }
    if (research.portfolio) {
      assert.match(research.portfolio.asOf, /^\d{4}-\d{2}-\d{2}$/)
      assert.match(research.portfolio.sourceUrl, /^https:\/\//)
      for (const row of research.portfolio.rows) assert.match(row.percent, /^\d+(?:\.\d+)?%$/)
    }
  }
  assert.deepEqual(
    DIGIFT_REFERENCE_ASSETS.filter((asset) => DIGIFT_RESEARCH[asset.id].portfolio).map((asset) => asset.symbol),
    ['CMBMINT', 'kTW50', 'GOLDX'],
  )
})

test('DigiFT Portfolio derives Industry and Exposure from source Snapshot rows without inventing USD values', () => {
  for (const asset of DIGIFT_REFERENCE_ASSETS) {
    const card = digiftPortfolioCardData(DIGIFT_RESEARCH[asset.id].portfolio, asset.symbol)
    assert.equal(card.total, null)
    assert.ok([...card.snapshot, ...card.industry, ...card.exposure].every((row) => row.value === null))
    if (card.snapshot.length) {
      assert.equal(Math.round(card.snapshot.reduce((sum, row) => sum + row.pct, 0) * 100), 10_000)
      assert.deepEqual(card.exposure, card.snapshot, `${asset.symbol} Exposure uses the same disclosed weights`)
      assert.equal(Math.round(card.industry.reduce((sum, row) => sum + row.pct, 0) * 100), 10_000)
      assert.match(card.note, /Industry is derived from the named snapshot rows/)
    } else {
      assert.deepEqual(card.industry, [])
      assert.deepEqual(card.exposure, [])
    }
  }

  assert.deepEqual(digiftPortfolioCardData(DIGIFT_RESEARCH['digift-cmbmint'].portfolio, 'CMBMINT').industry, [
    { label: 'Banking (fixed deposits)', value: null, pct: 40.28 },
    { label: 'Industry not disclosed', value: null, pct: 59.72 },
  ])
  const taiwan = digiftPortfolioCardData(DIGIFT_RESEARCH['digift-ktw50'].portfolio, 'kTW50')
  assert.deepEqual(taiwan.snapshot[taiwan.snapshot.length - 1], {
    label: 'Remaining portfolio weight (calculated)', value: null, pct: 43.74,
  })
  assert.deepEqual(taiwan.industry, [
    { label: 'Information Technology (shown holdings)', value: null, pct: 53.29 },
    { label: 'Financials (shown holdings)', value: null, pct: 2.97 },
    { label: 'Remaining portfolio weight (not shown)', value: null, pct: 43.74 },
  ])
  assert.match(taiwan.note, /remaining portfolio weight is calculated/)
  assert.deepEqual(digiftPortfolioCardData(DIGIFT_RESEARCH['digift-goldx'].portfolio, 'GOLDX').industry, [
    { label: 'Precious metals (gold)', value: null, pct: 100 },
  ])
  assert.equal(digiftPortfolioCardData(undefined, 'ULTRA').snapshot.length, 0)
})

test('reference list removes deployed symbols and searches source-backed profile text', () => {
  assert.deepEqual(referenceAssetsForList([]).map((asset) => asset.symbol), expected.map((asset) => asset.symbol))
  assert.deepEqual(
    referenceAssetsForList(['cmbmint', 'GOLDX']).map((asset) => asset.symbol),
    ['ULTRA', 'TKStable', 'CMBBOND', 'JX', 'kTW50'],
  )
  assert.deepEqual(referenceAssetsForList([], '  TAIkang  ').map((asset) => asset.symbol), ['TKStable'])
  assert.deepEqual(referenceAssetsForList([], 'Income Strategies').map((asset) => asset.symbol), ['CMBBOND'])
  assert.deepEqual(referenceAssetsForList([], 'LBMA').map((asset) => asset.symbol), ['GOLDX'])
  assert.deepEqual(referenceAssetsForList([], 'not-a-product'), [])
})

test('GOLDX shows as Commodity while its DigiFT source category stays Alternative Assets', () => {
  const goldx = digiftReferenceAssetById('digift-goldx')!
  assert.equal(goldx.category, 'Alternative Assets')
  assert.equal(digiftDisplayCategory(goldx), 'Commodity')
  for (const asset of DIGIFT_REFERENCE_ASSETS.filter((entry) => entry.id !== goldx.id)) {
    assert.equal(digiftDisplayCategory(asset), asset.category, `${asset.symbol} keeps its DigiFT category`)
  }
  assert.deepEqual(referenceAssetsForList([], 'commodity').map((asset) => asset.symbol), ['GOLDX'])

  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/product/${goldx.id}`]}>
      <Routes>
        <Route path="/product/:id" element={<GiwaProductDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
  assert.match(html, />Commodity<\/span>/)
  assert.doesNotMatch(html, />Alternative Assets</)
})

test('one Funds table renders seven reference rows with live-table columns and no trading claims', () => {
  const html = renderToStaticMarkup(
    <GiwaCatalogTable
      rows={[]}
      referenceRows={DIGIFT_REFERENCE_ASSETS}
      selectedProductId=""
      sortKey="aum"
      sortDir="desc"
      onSelect={() => undefined}
    />,
  )
  assert.match(html, /data-testid="giwa-catalog"/)
  assert.equal((html.match(/data-testid="digift-reference-row"/g) ?? []).length, 7)
  assert.doesNotMatch(html, /DigiFT reference profiles|Source snapshot ·/)
  assert.match(html, /digift-reference-marks-2026-09\.png/)
  assert.match(html, /digift-jx-mark-2026-09\.png/)
  assert.match(html, /digift-manager-cmbi\.jpg/)
  assert.match(html, /digift-manager-lionglobal\.png/)
  assert.match(html, /Lion Global Investors/)
  assert.equal((html.match(/src="\/logos\/usdc\.svg"/g) ?? []).length, 7)
  assert.equal((html.match(/src="\/logos\/DigFT\.png"/g) ?? []).length, 7)
  assert.equal((html.match(/src="\/logos\/giwa\.png"/g) ?? []).length, 7)
  for (const heading of ['Product', 'Base Asset', 'Asset Manager', 'Issuer', 'AUM', 'APY', 'Network']) {
    assert.ok(html.includes('>' + heading + '<'), heading + ' column should render')
  }
  for (const { symbol } of expected) {
    assert.ok(html.includes('View ' + symbol + ' reference profile'), symbol + ' row should render')
  }
  assert.match(html, /12-month return/)
  for (const value of ['$150M', '$689M', '$6.3B', '$526M']) {
    assert.ok(html.includes(value), `${value} AUM should render in the list`)
  }
  assert.doesNotMatch(html, /≈|Demo estimate/)
  assert.doesNotMatch(html, /Underlying fund AUM|Est\. underlying AUM/)
  assert.doesNotMatch(html, /GIWA Sepolia|sepolia-explorer\.giwa\.io/)
  for (const excluded of ['iSNR', 'FLOWC', 'pEAK', 'dDBTC', 'hGITD']) {
    assert.ok(!html.includes('View ' + excluded + ' reference profile'))
  }
})

test('/product/digift-* renders source details without catalog query or transaction flow', () => {
  for (const asset of DIGIFT_REFERENCE_ASSETS) {
    // Deliberately omit QueryClientProvider. The deployed-product branch calls useQuery
    // and would throw here if a DigiFT ID were routed into the live catalog flow.
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/product/${asset.id}`]}>
        <Routes>
          <Route path="/product/:id" element={<GiwaProductDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )

    assert.match(html, /data-testid="digift-reference-detail"/)
    for (const section of ['overview', 'performance', 'transparency', 'more-info']) {
      assert.ok(html.includes(`id="${section}"`), `${asset.symbol} should have the auMINT ${section} section`)
    }
    assert.match(html, /aria-label="Sections"/)
    assert.match(html, /NAV \/ share unavailable/)
    assert.match(html, /src="\/logos\/giwa\.png"/)
    assert.match(html, /src="\/logos\/DigFT\.png"/)
    assert.match(html, /Reference profile/)
    assert.match(html, /read-only profile/)
    assert.match(html, /Product background/)
    assert.match(html, /data-testid="digift-underlying-portfolio"/)
    assert.match(html, /<h3[^>]*>Portfolio<\/h3>/)
    for (const tab of ['Snapshot', 'Industry', 'Exposure']) assert.ok(html.includes(`>${tab}<`))
    assert.ok(html.indexOf('>Portfolio</h3>') < html.indexOf('>Product background</h3>'))
    assert.match(html, /data-testid="digift-research-facts"/)
    const research = DIGIFT_RESEARCH[asset.id]
    for (const fact of research.facts) {
      assert.ok(html.includes(fact.value), `${asset.symbol} should show ${fact.label}`)
      assert.ok(html.includes(fact.scope), `${asset.symbol} should distinguish the fact's scope`)
      assert.ok(html.includes(fact.sourceUrl.replace(/&/g, '&amp;')), `${asset.symbol} should link ${fact.sourceLabel}`)
    }
    if (research.portfolio) {
      assert.match(html, /Value \(USD\)/)
      assert.ok(html.includes(research.portfolio.asOf))
      assert.ok(html.includes(research.portfolio.scope))
      for (const row of research.portfolio.rows) assert.ok(html.includes(`${Number(row.percent.slice(0, -1))}%`))
    } else {
      assert.match(html, /No breakdown data yet\./)
    }
    assert.ok(html.includes(asset.metricLabel), `${asset.symbol} should keep the source metric label`)
    assert.ok(html.includes(asset.metricValue), `${asset.symbol} should keep the source metric value`)
    assert.ok(html.includes(asset.metricAsOf ?? asset.sourceAsOf), `${asset.symbol} should show a source date`)
    assert.ok(html.includes(asset.description), `${asset.symbol} should show its strategy`)
    assert.ok(html.includes(asset.underlying), `${asset.symbol} should show its underlying`)
    assert.ok(html.includes(asset.minInvestment), `${asset.symbol} should show source minimum`)
    assert.ok(html.includes(asset.fee), `${asset.symbol} should show source fees`)
    assert.ok(html.includes(asset.settlement), `${asset.symbol} should show source settlement`)
    assert.ok(html.includes(`pages 3 and ${asset.sourcePage}`), `${asset.symbol} should cite its source pages`)
    assert.ok(html.includes(asset.sourceUrl), `${asset.symbol} should link to source`)
    if (asset.aumEstimate) {
      assert.match(html, /data-testid="digift-aum-estimate"/)
      assert.ok(html.includes(asset.aumEstimate.basis), `${asset.symbol} should explain its estimate`)
      assert.ok(html.includes(asset.aumEstimate.sourceUrl), `${asset.symbol} should link estimate source`)
      assert.match(html, /not token AUM or an Arco balance/)
    }
    assert.doesNotMatch(html, /Smart Contracts|GIWA Sepolia|sepolia-explorer\.giwa\.io/)
    assert.doesNotMatch(html, />\s*(?:7D|30D|90D|1Y|All)\s*</)
    assert.doesNotMatch(html, />\s*(?:Invest|Redeem)\s*</i)
  }
})
