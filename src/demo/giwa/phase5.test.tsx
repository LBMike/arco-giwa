import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { GIWA_LIVE_REFETCH, GIWA_PROVIDER_HIERARCHY, dynamicGiwaNetwork, GIWA_PUBLIC_RPC } from "./config"
import { normalizeCatalog, operatorTokenAuth } from "./api"
import { assertRequiredPaymentAsset } from "./catalog"
import { GiwaCatalogTable, GiwaInvestPanel, ProductCatalogList } from "./components"
import {
  afterConfirmedReceipt,
  dripAllTestAssetsWithClients,
  encodedOperationCall,
  sendPreparedTransactionWithClients,
  setDynamicWalletClient,
  setInjectedWalletSource,
  walletClient,
} from "./contracts"
import { vaultAddressForOperation } from "./operation-routing"
import {
  GIWA_ADMIN_CONFIG_ROUTE,
  GIWA_ADMIN_MONITORING_ROUTE,
  GIWA_ADMIN_OPERATIONS_ROUTE,
  GIWA_ADMIN_PRICES_ROUTE,
  GIWA_ADMIN_ROUTE,
  GIWA_PREPROD_ROUTE,
} from "./routes"
import type { GiwaCatalogItem, GiwaRedemption, HexAddress, UnsignedAdminTransaction } from "./types"

const product: GiwaCatalogItem = {
  productId: "acapix",
  symbol: "aCAPIX",
  name: "Arco CAPIX",
  paymentAssetSymbol: "tUSDC",
  paymentAsset: {
    symbol: "tUSDC",
    name: "Test USDC",
    decimals: 6,
    contract: { proxy: "0x00000000000000000000000000000000000000a1" },
    faucet: "0x00000000000000000000000000000000000000f1",
  },
  paymentAssetAddress: "0x00000000000000000000000000000000000000A1",
  productTokenAddress: "0x00000000000000000000000000000000000000b1",
  depositVaultAddress: "0x00000000000000000000000000000000000000c1",
  redemptionVaultAddress: "0x00000000000000000000000000000000000000d1",
  priceFeedAddress: "0x00000000000000000000000000000000000000e1",
}

test("GIWA route constants are root-based (app.arco.financial; legacy /app paths redirect)", () => {
  assert.equal(GIWA_PREPROD_ROUTE, "/")
  assert.equal(GIWA_ADMIN_ROUTE, "/admin")
  assert.equal(GIWA_ADMIN_PRICES_ROUTE, "/admin/prices")
  assert.equal(GIWA_ADMIN_CONFIG_ROUTE, "/admin/config")
  assert.equal(GIWA_ADMIN_OPERATIONS_ROUTE, "/admin/operations")
  assert.equal(GIWA_ADMIN_MONITORING_ROUTE, "/admin/monitoring")
})

test("GIWA live-read queries poll 20s + focus refetch, never in the background", () => {
  assert.equal(GIWA_LIVE_REFETCH.refetchInterval, 20_000)
  assert.equal(GIWA_LIVE_REFETCH.refetchOnWindowFocus, true)
  assert.equal(GIWA_LIVE_REFETCH.refetchIntervalInBackground, false)
  // The live market/catalog/price-history/detail queries opt into the shared policy. The vault
  // detail's market + price-history queries live in useGiwaVaultDetail.ts (extracted from
  // ProductDetailPage in the Phase 3 section-reuse refactor).
  for (const file of ["Investor.tsx", "useGiwaVaultDetail.ts", "AdminPrices.tsx"]) {
    assert.match(readFileSync(`src/demo/giwa/${file}`, "utf8"), /\.\.\.GIWA_LIVE_REFETCH/, file)
  }
})

test("AdminPrices refreshes catalog/market/price-history on a confirmed NAV post + bridges the indexer lag", () => {
  const src = readFileSync("src/demo/giwa/AdminPrices.tsx", "utf8")
  assert.match(src, /invalidateQueries\(\{ queryKey: \["giwa", "catalog"\] \}\)/)
  assert.match(src, /invalidateQueries\(\{ queryKey: \["giwa", "market"\] \}\)/)
  assert.match(src, /invalidateQueries\(\{ queryKey: \["giwa", "price-history", productId\] \}\)/)
  // Immediate refresh + two delayed refetches (~6s, ~14s) to cover indexing lag.
  assert.match(src, /setTimeout\(refreshLiveReads, 6_000\)/)
  assert.match(src, /setTimeout\(refreshLiveReads, 14_000\)/)
})

test("provider-hierarchy shape constants use the public GIWA RPC metadata", () => {
  assert.deepEqual([...GIWA_PROVIDER_HIERARCHY], [
    "DynamicContextProvider",
    "WagmiProvider",
    "QueryClientProvider",
    "DynamicWagmiConnector",
  ])
  assert.equal(dynamicGiwaNetwork.chainId, 91342)
  assert.equal(dynamicGiwaNetwork.networkId, 91342)
  assert.deepEqual(dynamicGiwaNetwork.rpcUrls, [GIWA_PUBLIC_RPC])
})

test("GIWA providers scope Dynamic wallet modal and keep injected fallback branch", () => {
  const source = readFileSync("src/demo/giwa/providers.tsx", "utf8")

  assert.match(source, /if \(DYNAMIC_ENVIRONMENT_ID\)/)
  assert.match(source, /<DynamicContextProvider[\s\S]*<WagmiProvider[\s\S]*<QueryClientProvider[\s\S]*<DynamicWagmiConnector/)
  assert.match(source, /walletConnectors: \[EthereumWalletConnectors\]/)
  assert.match(source, /evmNetworks: \(networks\) => mergeNetworks\(\[dynamicGiwaNetwork\], networks\)/)
  assert.match(source, /<GiwaWalletProvider><GiwaStocksHost>{children}<\/GiwaStocksHost><\/GiwaWalletProvider>/)
  assert.match(source, /<DynamicGiwaWalletProvider><GiwaStocksHost>{children}<\/GiwaStocksHost><\/DynamicGiwaWalletProvider>/)
})

test("wallet client source uses Dynamic when configured and preserves injected fallback", () => {
  const originalWindow = globalThis.window

  try {
    setDynamicWalletClient(null)
    assert.throws(() => walletClient(), /Dynamic wallet client is unavailable/)

    ;(globalThis as any).window = {
      ethereum: {
        request: async () => "0x165ce",
      },
    }
    setInjectedWalletSource()
    assert.doesNotThrow(() => walletClient())
  } finally {
    ;(globalThis as any).window = originalWindow
    setInjectedWalletSource()
  }
})

test("catalog rendering is registry-driven and shows one payment asset per product", () => {
  const html = renderToStaticMarkup(
    <ProductCatalogList products={[product]} selectedProductId="acapix" onSelect={() => undefined} />,
  )

  assert.match(html, /aCAPIX/)
  assert.match(html, /tUSDC/)
  assert.match(html, /aCAPIX accepts tUSDC only/)
})

test("vault-list APY: implied APY fills the gap for registered vaults; built-ins keep their static/legacy rate", () => {
  // A newly-registered vault (not a built-in, no fund-deck rate) has no static/legacy APY.
  const registered = { ...product, productId: "newvault", symbol: "nVAULT" }
  const renderTable = (
    rows: GiwaCatalogItem[],
    apyByProductId: Record<string, number | null>,
    impliedApyByProductId: Record<string, number | null>,
  ) =>
    renderToStaticMarkup(
      <GiwaCatalogTable
        rows={rows}
        selectedProductId=""
        sortKey="aum"
        sortDir="desc"
        onSelect={() => undefined}
        apyByProductId={apyByProductId}
        impliedApyByProductId={impliedApyByProductId}
      />,
    )

  // ≥2 posts → implied APY (2%) shows for the registered vault.
  const withImplied = renderTable([registered], {}, { newvault: 2 })
  assert.match(withImplied, /2%/)

  // <2 posts (implied null, no static, no legacy) → "—", never a fabricated APY.
  const noImplied = renderTable([registered], {}, { newvault: null })
  assert.match(noImplied, /—/)
  assert.doesNotMatch(noImplied, /\d+%/)

  // Built-in with a legacy profile APY: implied APY must NOT override it (gap-filler only).
  const builtin = renderTable([product], {}, { acapix: 999 })
  assert.doesNotMatch(builtin, /999%/)
})

test("vault-list row is config-first: registered vault shows configured image/category/manager/issuer; built-ins stay legacy", () => {
  const registered = {
    ...product,
    productId: "beqty",
    symbol: "bEQTY",
    vaultConfig: vaultConfig({
      category: "Prime Credit",
      assetManagerName: "Acme Capital",
      assetManagerImageUrl: "/logos/acme-mgr.png",
      issuerName: "Acme Trust",
      issuerImageUrl: "/logos/acme-iss.png",
      vaultImageUrl: "/logos/beqty.png",
      aum: "$903M",
    }),
  }
  const renderRow = (rows: GiwaCatalogItem[]) =>
    renderToStaticMarkup(
      <GiwaCatalogTable rows={rows} selectedProductId="" sortKey="aum" sortDir="desc" onSelect={() => undefined} />,
    )

  // Registered vault → configured identity, not the legacy "Money Market Fund" fallback. The
  // category shows under its investor title (Prime Credit → Income Strategies).
  const configured = renderRow([registered])
  assert.match(configured, /Income Strategies/)
  assert.doesNotMatch(configured, /Money Market Fund/)
  assert.match(configured, /Acme Capital/)
  assert.match(configured, /Acme Trust/)
  assert.match(configured, /\/logos\/beqty\.png/) // configured vault image
  assert.match(configured, /\/logos\/acme-mgr\.png/) // configured manager logo
  assert.match(configured, /\/logos\/acme-iss\.png/) // configured issuer logo
  assert.match(configured, /\$903M/) // config-first AUM column (matches the detail AUM stat)

  // Built-in (aCAPIX, null config) → legacy values, byte-identical.
  const builtin = renderRow([product])
  assert.match(builtin, /Private Credit/) // legacy fund type (productType), not a taxonomy category
  assert.doesNotMatch(builtin, /Prime Credit|Income Strategies/)
  assert.match(builtin, /Aksia/) // legacy asset manager
  assert.match(builtin, /Arco/) // legacy issuer
  assert.match(builtin, /\$1\.15B/) // legacy numeric AUM (aumLabel), unchanged
  assert.doesNotMatch(builtin, /\$903M/) // no config leakage
  assert.doesNotMatch(builtin, /Acme/) // no config leakage
})

test("captured Funds managers use local logos while other configured logos remain untouched", () => {
  const snapshot = JSON.parse(readFileSync("src/demo/giwa/investor-shell/verification/deployed-giwa.snapshot.json", "utf8"))
  const core = normalizeCatalog(snapshot.catalog).filter(({ productId }) => ["beqty", "umint", "ibenji", "acapix"].includes(productId))
  const html = renderToStaticMarkup(
    <GiwaCatalogTable rows={core} selectedProductId="" sortKey="aum" sortDir="desc" onSelect={() => undefined} />,
  )
  for (const logo of ["bny-investments.jpg", "umint.svg", "franklin.png", "aksia.svg"]) {
    assert.match(html, new RegExp(`src="/logos/${logo.replace(".", "\\.")}"`))
  }
  assert.doesNotMatch(html, /src="https:\/\/(?:pbs\.twimg\.com|img\.rwa\.xyz|encrypted-tbn0\.gstatic\.com)[^"]*" alt="(?:BNY Investments|UBS Asset Management|Franklin Templeton|Aksia)"/)
})

test("catalog normalization reads addresses from registry-shaped payloads", () => {
  const [normalized] = normalizeCatalog([
    {
      productId: "acapix",
      symbol: "aCAPIX",
      name: "Arco CAPIX",
      paymentAssetSymbol: "tUSDC",
      productToken: { proxy: "0x00000000000000000000000000000000000000b1" },
      depositVault: { proxy: "0x00000000000000000000000000000000000000c1" },
      redemptionVault: { proxy: "0x00000000000000000000000000000000000000d1" },
      priceFeed: { proxy: "0x00000000000000000000000000000000000000e1" },
      paymentAsset: {
        symbol: "tUSDC",
        name: "Test USDC",
        decimals: 6,
        contract: { proxy: "0x00000000000000000000000000000000000000a1" },
      },
    },
  ])

  assert.equal(normalized.depositVaultAddress, "0x00000000000000000000000000000000000000C1")
  assert.equal(normalized.redemptionVaultAddress, "0x00000000000000000000000000000000000000D1")
  assert.equal(normalized.paymentAssetAddress, "0x00000000000000000000000000000000000000A1")
})

test("catalog normalization rejects backend payment mapping drift", () => {
  assert.doesNotThrow(() => assertRequiredPaymentAsset(product))
  assert.throws(
    () =>
      normalizeCatalog([
        {
          ...product,
          paymentAssetSymbol: "tBTC",
        },
      ]),
    /acapix must use tUSDC/,
  )
})

test("operation routing binds deposits to deposit vault and redemptions to redemption vault", () => {
  assert.equal(vaultAddressForOperation(product, "deposit"), product.depositVaultAddress)
  assert.equal(vaultAddressForOperation(product, "requestDeposit"), product.depositVaultAddress)
  assert.equal(vaultAddressForOperation(product, "redeemInstant"), product.redemptionVaultAddress)
  assert.equal(vaultAddressForOperation(product, "requestRedeem"), product.redemptionVaultAddress)
  assert.equal(vaultAddressForOperation(product, "claimRedeem"), product.redemptionVaultAddress)

  assert.equal(encodedOperationCall(product, "deposit", 100n, "0x00000000000000000000000000000000000000aa").to, product.depositVaultAddress)
  assert.equal(
    encodedOperationCall(product, "requestRedeem", 100n, "0x00000000000000000000000000000000000000aa").to,
    product.redemptionVaultAddress,
  )
})

test("test funds action prefers faucet dripAll as one transaction", async () => {
  const calls: string[] = []
  const hash = "0x5555555555555555555555555555555555555555555555555555555555555555"
  const result = await dripAllTestAssetsWithClients(
    {
      account: "0x00000000000000000000000000000000000000aa",
      faucet: "0x00000000000000000000000000000000000000f1",
      tokens: [
        "0x00000000000000000000000000000000000000a1",
        "0x00000000000000000000000000000000000000a2",
      ],
    },
    {
      publicClient: {
        simulateContract: async (args) => {
          calls.push(String(args.functionName))
          return { request: { functionName: args.functionName } }
        },
      },
      wallet: {
        writeContract: async (request) => {
          assert.equal((request as { functionName: string }).functionName, "dripAll")
          return hash
        },
      },
    },
  )

  assert.deepEqual(calls, ["dripAll"])
  assert.deepEqual(result, { mode: "dripAll", hashes: [hash] })
})

test("test funds action falls back to per-asset drip when dripAll is not deployed", async () => {
  const calls: string[] = []
  const tokens = [
    "0x00000000000000000000000000000000000000a1",
    "0x00000000000000000000000000000000000000a2",
  ] as HexAddress[]
  const result = await dripAllTestAssetsWithClients(
    {
      account: "0x00000000000000000000000000000000000000aa",
      faucet: "0x00000000000000000000000000000000000000f1",
      tokens,
    },
    {
      publicClient: {
        simulateContract: async (args) => {
          if (args.functionName === "dripAll") throw new Error("function selector not recognized")
          calls.push(`${String(args.functionName)}:${String((args.args as unknown[])[0])}`)
          return { request: { token: (args.args as unknown[])[0] } }
        },
      },
      wallet: {
        writeContract: async (request) =>
          (request as { token: string }).token === tokens[0]
            ? "0x6666666666666666666666666666666666666666666666666666666666666666"
            : "0x7777777777777777777777777777777777777777777777777777777777777777",
      },
    },
  )

  assert.deepEqual(calls, [`drip:${tokens[0]}`, `drip:${tokens[1]}`])
  assert.equal(result.mode, "perAssetFallback")
  assert.deepEqual(result.hashes, [
    "0x6666666666666666666666666666666666666666666666666666666666666666",
    "0x7777777777777777777777777777777777777777777777777777777777777777",
  ])
})

test("legacy-style invest panel keeps deposit approval bound to the deposit vault", () => {
  const html = renderToStaticMarkup(
    <GiwaInvestPanel
      product={product}
      operation="deposit"
      amount="5"
      requestId="1"
      paymentBalance="100"
      productBalance="0"
      allowance="0"
      allowanceRequired
      greenlistEnforced={false}
      activeVault={product.depositVaultAddress}
      phase="allowance-required"
      error={null}
      txHashes={[]}
      pendingRedemptions={[]}
      onOperationChange={() => undefined}
      onAmountChange={() => undefined}
      onRequestIdChange={() => undefined}
      onApprove={() => undefined}
      onSubmit={() => undefined}
      onRequestRedeem={() => undefined}
      onClaim={() => undefined}
      onConnect={() => undefined}
      onSwitchNetwork={() => undefined}
    />,
  )

  assert.match(html, /Approve/)
  assert.match(html, /\bUSDC\b/)
  assert.match(html, /aCAPIX/)
  assert.equal(encodedOperationCall(product, "deposit", 5n, "0x00000000000000000000000000000000000000aa").to, product.depositVaultAddress)
})

test("transaction read refresh waits until the receipt resolves", async () => {
  const receipt = deferred<{ status: string }>()
  let refreshed = false
  const promise = afterConfirmedReceipt(
    "0x1111111111111111111111111111111111111111111111111111111111111111",
    async () => {
      refreshed = true
    },
    {
      waitForTransactionReceipt: async () => receipt.promise,
    },
  )

  await Promise.resolve()
  assert.equal(refreshed, false)
  receipt.resolve({ status: "success" })
  await promise
  assert.equal(refreshed, true)
})

test("reverted receipts do not refresh reads", async () => {
  let refreshed = false
  await assert.rejects(
    afterConfirmedReceipt(
      "0x2222222222222222222222222222222222222222222222222222222222222222",
      async () => {
        refreshed = true
      },
      {
        waitForTransactionReceipt: async () => ({ status: "reverted" }),
      },
    ),
    /reverted/,
  )
  assert.equal(refreshed, false)
})

test("admin prepared transactions estimate gas before wallet signing", async () => {
  const account = "0x00000000000000000000000000000000000000aa" as HexAddress
  const tx = preparedAdminTx()
  let estimated = false
  let sent = false

  const hash = await sendPreparedTransactionWithClients(account, tx, {
    publicClient: {
      estimateGas: async (args) => {
        estimated = true
        assert.equal(args.to, tx.to)
        return 100000n
      },
    },
    wallet: {
      sendTransaction: async () => {
        sent = true
        return "0x3333333333333333333333333333333333333333333333333333333333333333"
      },
    },
  })

  assert.equal(estimated, true)
  assert.equal(sent, true)
  assert.equal(hash, "0x3333333333333333333333333333333333333333333333333333333333333333")
})

test("admin prepared transactions stop before wallet signing when simulation fails", async () => {
  const account = "0x00000000000000000000000000000000000000aa" as HexAddress
  let sent = false

  await assert.rejects(
    sendPreparedTransactionWithClients(account, preparedAdminTx(), {
      publicClient: {
        estimateGas: async () => {
          throw new Error("would revert")
        },
      },
      wallet: {
        sendTransaction: async () => {
          sent = true
          return "0x4444444444444444444444444444444444444444444444444444444444444444"
        },
      },
    }),
    /Transaction simulation failed: would revert/,
  )

  assert.equal(sent, false)
})

test("admin token is runtime-only and not represented as a VITE secret", () => {
  const adminSource = readFileSync("src/demo/giwa/GiwaAdminLayout.tsx", "utf8")
  assert.equal(adminSource.includes(["VITE", "ADMIN"].join("_")), false)
  assert.equal(adminSource.includes("ADMIN_OPERATOR_TOKEN"), false)
  assert.match(adminSource, /localStorage/)
  assert.match(adminSource, /Clear operator token/)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

function preparedAdminTx(): UnsignedAdminTransaction {
  return {
    chainId: 91342,
    to: "0x00000000000000000000000000000000000000c1",
    value: "0x0",
    data: "0x1234",
    description: "Pause redemption vault",
    simulation: { status: "not-run" },
  }
}

test("invest panel disables the primary action and shows the notice when deposits are paused", () => {
  const html = renderToStaticMarkup(
    <GiwaInvestPanel
      product={product}
      operation="deposit"
      amount="5"
      requestId="1"
      paymentBalance="100"
      productBalance="0"
      allowance="1000"
      allowanceRequired={false}
      greenlistEnforced={false}
      activeVault={product.depositVaultAddress}
      phase="ready"
      pausedNotice="Deposits are temporarily paused"
      error={null}
      txHashes={[]}
      pendingRedemptions={[]}
      onOperationChange={() => undefined}
      onAmountChange={() => undefined}
      onRequestIdChange={() => undefined}
      onApprove={() => undefined}
      onSubmit={() => undefined}
      onRequestRedeem={() => undefined}
      onClaim={() => undefined}
      onConnect={() => undefined}
      onSwitchNetwork={() => undefined}
    />,
  )
  assert.match(html, /Deposits are temporarily paused/)
  assert.match(html, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Invest/s)
})

test("redeem panel disables the primary action and shows the notice when withdrawals are paused", () => {
  const html = renderToStaticMarkup(
    <GiwaInvestPanel
      product={product}
      operation="redeemInstant"
      amount="5"
      requestId="1"
      paymentBalance="100"
      productBalance="10"
      allowance="1000"
      allowanceRequired={false}
      greenlistEnforced={false}
      activeVault={product.redemptionVaultAddress}
      phase="ready"
      pausedNotice="Withdrawals are temporarily paused"
      error={null}
      txHashes={[]}
      pendingRedemptions={[]}
      onOperationChange={() => undefined}
      onAmountChange={() => undefined}
      onRequestIdChange={() => undefined}
      onApprove={() => undefined}
      onSubmit={() => undefined}
      onRequestRedeem={() => undefined}
      onClaim={() => undefined}
      onConnect={() => undefined}
      onSwitchNetwork={() => undefined}
    />,
  )
  assert.match(html, /Withdrawals are temporarily paused/)
  assert.match(html, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Redeem instant/s)
})

test("invest panel stays active when no pause notice is set", () => {
  const html = renderToStaticMarkup(
    <GiwaInvestPanel
      product={product}
      operation="deposit"
      amount="5"
      requestId="1"
      paymentBalance="100"
      productBalance="0"
      allowance="1000"
      allowanceRequired={false}
      greenlistEnforced={false}
      activeVault={product.depositVaultAddress}
      phase="ready"
      pausedNotice={null}
      error={null}
      txHashes={[]}
      pendingRedemptions={[]}
      onOperationChange={() => undefined}
      onAmountChange={() => undefined}
      onRequestIdChange={() => undefined}
      onApprove={() => undefined}
      onSubmit={() => undefined}
      onRequestRedeem={() => undefined}
      onClaim={() => undefined}
      onConnect={() => undefined}
      onSwitchNetwork={() => undefined}
    />,
  )
  assert.doesNotMatch(html, /temporarily paused/)
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Invest/s)
})

test("add-vault form emitter output passes the SHARED deploy-params validator (no drift possible)", async () => {
  const { ADD_VAULT_INITIAL_STATE, buildDeployParams, deployParamsCommand } = await import("./AdminConfig")
  const { validateDeployParams } = await import("../../../packages/contracts/scripts/deploy-params")

  const form = {
    ...ADD_VAULT_INITIAL_STATE,
    productId: "agold",
    symbol: "aGOLD",
    name: "Arco GOLD",
    category: "Prime Credit" as const,
  }
  const params = buildDeployParams(form)
  const result = validateDeployParams(params, ["acapix"], ["aCAPIX"])
  assert.equal(result.ok, true, result.errors.join("; "))
  assert.equal(result.parsed?.products[0].init?.feedInitialAnswer, "100000000")

  // Reserved collision surfaces through the same validator the harness runs.
  const duplicate = buildDeployParams({ ...form, productId: "acapix", symbol: "aCAPIX" })
  const duplicateResult = validateDeployParams(duplicate, ["acapix"], ["aCAPIX"])
  assert.equal(duplicateResult.ok, false)
  assert.match(duplicateResult.errors.join(), /duplicates/)

  const command = deployParamsCommand("agold")
  assert.match(command, /GIWA_EXTRA_PRODUCTS=deploy-params\/agold\.json/)
  // FIX 2: emit the keystore-wrapped npm script, not the raw hardhat run (which skips the
  // signer wrapper → "No signer available").
  assert.match(command, /npm run deploy:giwa/)
  assert.doesNotMatch(command, /npx hardhat/)
  assert.match(command, /ALLOW_DIRTY_GIWA_DEPLOY/)
})

test("add-vault category dropdown renders exactly the shared taxonomy (same as the §2 dropdown)", async () => {
  const { AddVaultCard } = await import("./AdminConfig")
  const { VAULT_CATEGORIES } = await import("../../../shared/vault-taxonomy")
  const html = renderToStaticMarkup(<AddVaultCard products={[product]} />)
  for (const category of VAULT_CATEGORIES) {
    assert.match(html, new RegExp(`<option value="${category.replace(".", "\\.")}"`))
  }
  // canonical string has NO period — the period form must not appear as an option value
  assert.doesNotMatch(html, /<option value="U\.S\. Treasuries"/)
  assert.match(html, /Generate deploy plan/)
})

test("AddVaultCard: Description removed (renders nowhere); Product ID + Name carry helper text", async () => {
  const { AddVaultCard, ADD_VAULT_INITIAL_STATE, buildDeployParams } = await import("./AdminConfig")
  const html = renderToStaticMarkup(<AddVaultCard products={[product]} />)

  // Operator-reference only — the displayed intro is the per-vault config `about`.
  assert.doesNotMatch(html, /Description \(operator reference\)/)
  // Everything deployment needs is kept.
  for (const label of ["Product ID", "Symbol", "Name", "Payment asset", "Category"]) {
    assert.match(html, new RegExp(label), label)
  }
  // Helper text disambiguates the two id-ish fields.
  assert.match(html, /internal id \(lowercase\); used in URLs\/registry, cannot change after deploy/)
  assert.match(html, /on-chain ERC20 token name; the app shows the display name set later in Vault Config/)

  // The emitter no longer writes a `description` key (deploy-params keeps it optional for back-compat).
  const params = buildDeployParams({ ...ADD_VAULT_INITIAL_STATE, productId: "agold", symbol: "aGOLD", name: "Arco GOLD" })
  assert.ok(!("description" in params.products[0]), "buildDeployParams must not emit description")
})

function panelBaseProps() {
  return {
    operation: "deposit" as const,
    amount: "5",
    requestId: "1",
    paymentBalance: "100",
    productBalance: "0",
    allowance: "1000",
    allowanceRequired: false,
    greenlistEnforced: false,
    activeVault: product.depositVaultAddress,
    phase: "ready" as const,
    pausedNotice: null,
    error: null,
    txHashes: [] as string[],
    pendingRedemptions: [],
    onOperationChange: () => undefined,
    onAmountChange: () => undefined,
    onRequestIdChange: () => undefined,
    onApprove: () => undefined,
    onSubmit: () => undefined,
    onRequestRedeem: () => undefined,
    onClaim: () => undefined,
    onConnect: () => undefined,
    onSwitchNetwork: () => undefined,
  }
}

function vaultConfig(overrides: Record<string, unknown>) {
  return {
    displayName: null, category: null, description: null, adminDepositAddress: null,
    cardSnapshot: true, cardIndustry: true, cardExposure: true, pinned: false, hidden: false,
    assetManagerName: null, issuerName: null, about: null, aum: null, redemptionTimelineDays: null,
    feeInstantMintingBps: null, feeInstantRedemptionBps: null, feeManagementBps: null, feePerformanceBps: null,
    vaultImageUrl: null, assetManagerImageUrl: null, issuerImageUrl: null,
    docsUrl: null, legalUrl: null, risksUrl: null, docsShown: true, legalShown: true, risksShown: true,
    kind: "product" as const, acceptAssets: null,
    portfolioSnapshot: null, portfolioIndustry: null, portfolioExposure: null,
    ...overrides,
  }
}

test("swap card renders the approved 'Transaction Fees' label (not 'Fee Structure') with live liquidity", () => {
  const html = renderToStaticMarkup(
    <GiwaInvestPanel product={product} {...panelBaseProps()} instantLiquidityUsd={12_340_000} />,
  )
  assert.match(html, /Transaction Fees/)
  assert.doesNotMatch(html, /Fee Structure/)
  assert.match(html, /\$12\.34M/) // live instant liquidity, not the old hardcoded 7.16M
})

test("swap card is config-first: overridden instant fees + timeline", () => {
  const configured = {
    ...product,
    productId: "abtc",
    symbol: "aBTC",
    vaultConfig: vaultConfig({ feeInstantMintingBps: 20, feeInstantRedemptionBps: 25, redemptionTimelineDays: 3 }),
  }
  const html = renderToStaticMarkup(
    <GiwaInvestPanel product={configured} {...panelBaseProps()} instantLiquidityUsd={1_000_000} />,
  )
  assert.match(html, /3 Days/) // config redemption timeline override
  assert.doesNotMatch(html, /30-90 Business Days/)
})

// The representative-sample disclaimer was removed from every GIWA surface. A non-aCAPIX vault
// still on fallback instant fees used to render it here — assert it stays gone.
test("swap card renders NO sample disclaimer for a non-aCAPIX vault on fallback instant fees", () => {
  const unconfigured = { ...product, productId: "abtc", symbol: "aBTC" }
  const html = renderToStaticMarkup(
    <GiwaInvestPanel product={unconfigured} {...panelBaseProps()} instantLiquidityUsd={null} />,
  )
  assert.doesNotMatch(html, /aCAPIX examples/)
  assert.doesNotMatch(html, /Representative sample content/)
  assert.match(html, /30-90 Business Days/) // legacy timeline fallback still renders
  assert.match(html, /Instant liquidity/)
})

test("swap panel product-token logo is config-first: admin vault image → legacy icon fallback", () => {
  // Configured registered vault → its admin vault image on the product-token swap row.
  const withImage = {
    ...product,
    productId: "beqty",
    symbol: "bEQTY",
    vaultConfig: vaultConfig({ vaultImageUrl: "/logos/beqty.png" }),
  }
  const configured = renderToStaticMarkup(
    <GiwaInvestPanel product={withImage} {...panelBaseProps()} instantLiquidityUsd={null} />,
  )
  assert.match(configured, /\/logos\/beqty\.png/) // configured product-token logo

  // Built-in (aCAPIX, null config) → legacy token icon, byte-identical; no config leakage.
  const builtin = renderToStaticMarkup(
    <GiwaInvestPanel product={product} {...panelBaseProps()} instantLiquidityUsd={null} />,
  )
  assert.match(builtin, /\/logos\/aksia\.svg/) // legacy tokenIcon("acapix")
  assert.doesNotMatch(builtin, /\/logos\/beqty\.png/)
})

test("pending tab settlement estimate is config-first (matches the Redemption Timeline override)", () => {
  const configured = {
    ...product,
    productId: "abtc",
    symbol: "aBTC",
    vaultConfig: vaultConfig({ redemptionTimelineDays: 3 }),
  }
  const pending = [
    {
      requestId: "7",
      status: "REQUESTED",
      sharesIn: "1000000000000000000",
      lockedAssetsOut: "0",
      createdAt: "2026-07-01T00:00:00.000Z",
      settledAt: null,
      fulfilledAt: null,
    } as unknown as (typeof product extends never ? never : any),
  ]
  const html = renderToStaticMarkup(
    <GiwaInvestPanel
      product={configured}
      {...panelBaseProps()}
      operation="claimRedeem"
      pendingRedemptions={pending}
      instantLiquidityUsd={null}
    />,
  )
  assert.match(html, /Est\. Settlement/)
  assert.match(html, /3 Days/)
  assert.doesNotMatch(html, /30-90 Business Days/)
})

test("PortfolioCard: Snapshot view renders its slices (config pie + table)", async () => {
  const { PortfolioCard } = await import("../components/PortfolioCard")
  const portfolio = {
    updatedAt: "now", note: "n", total: 10_000_000,
    industry: [{ label: "Ind", value: 1, pct: 100 }],
    exposure: [{ label: "Exp", value: 1, pct: 100 }],
    snapshot: [
      { label: "Alpha", value: 6_000_000, pct: 60 },
      { label: "Beta", value: 4_000_000, pct: 40 },
    ],
  }
  const html = renderToStaticMarkup(
    <PortfolioCard portfolio={portfolio as never} enabledViews={{ snapshot: true, industry: true, exposure: true }} />,
  )
  // Snapshot is the first (active) tab; its heading + slice labels + percents render.
  assert.match(html, /Snapshot/)
  assert.match(html, /Alpha/)
  assert.match(html, /Beta/)
  assert.match(html, /60%/)
})

test("PortfolioCard: GIWA values = pct × parsed AUM (no more $0), header relabels to % of AUM", async () => {
  const { PortfolioCard } = await import("../components/PortfolioCard")
  const portfolio = {
    updatedAt: "—", note: "n", total: null,
    industry: [{ label: "Credit", value: null, pct: 60 }, { label: "Cash", value: null, pct: 40 }],
    exposure: [{ label: "Exp", value: null, pct: 100 }],
  }
  const html = renderToStaticMarkup(
    <PortfolioCard
      portfolio={portfolio as never}
      enabledViews={{ industry: true, exposure: true }}
      aum={903_000_000}
      percentLabel="% of AUM"
    />,
  )
  assert.match(html, /% of AUM/)
  assert.doesNotMatch(html, /% of NAV/)
  assert.match(html, /\$541\.8M/) // 60% × $903M — value derived from AUM, not $0
  assert.doesNotMatch(html, /\$0\b/) // the "$0" bug is gone
  assert.match(html, /\$903M/) // donut total falls back to the AUM
})

test("PortfolioCard: Exposure Value column mirrors the pie views (aumLabel + 'Value (USD)')", async () => {
  const { PortfolioCard } = await import("../components/PortfolioCard")
  const portfolio = {
    updatedAt: "—", note: "n", total: null,
    industry: [{ label: "Ind", value: null, pct: 100 }],
    exposure: [{ label: "Aave", value: 38_830_000, pct: 100 }],
  }
  // industry:false → Exposure is the default active tab, so its table renders.
  const html = renderToStaticMarkup(
    <PortfolioCard
      portfolio={portfolio as never}
      enabledViews={{ industry: false, exposure: true }}
      aum={903_000_000}
      percentLabel="% of AUM"
    />,
  )
  assert.match(html, /Value \(USD\)/) // header mirrors Snapshot/Industry
  assert.doesNotMatch(html, /USD mio/) // old "(mio)" header is gone
  assert.match(html, /\$38\.83M/) // aumLabel format, not the raw "$38.83"
})

test("PortfolioCard: Snapshot/Industry/Exposure share one aligned, tabular-nums column layout", async () => {
  const { PortfolioCard } = await import("../components/PortfolioCard")
  const portfolio = {
    updatedAt: "—", note: "n", total: null,
    snapshot: [{ label: "S", value: 121_000_000, pct: 50 }, { label: "T", value: 220_330_000, pct: 50 }],
    industry: [{ label: "I", value: 84_000_000, pct: 100 }],
    exposure: [{ label: "E", value: 24_000_000, pct: 100 }],
  }
  const render = (views: { snapshot?: boolean; industry?: boolean; exposure?: boolean }) =>
    renderToStaticMarkup(
      <PortfolioCard
        portfolio={portfolio as never}
        enabledViews={views}
        aum={903_000_000}
        percentLabel="% of AUM"
      />,
    )
  // Each active view routes through the shared subgrid table (so value right edges line up)
  // and renders equal-width tabular-nums digits — asserted for Snapshot, Industry, Exposure.
  for (const html of [
    render({ snapshot: true, industry: false, exposure: false }),
    render({ industry: true, exposure: false }),
    render({ industry: false, exposure: true }),
  ]) {
    assert.match(html, /grid-cols-subgrid/)
    assert.match(html, /tabular-nums/)
  }
})

test("PortfolioCard: legacy default keeps '% of NAV' + explicit values/total (byte-identical path)", async () => {
  const { PortfolioCard } = await import("../components/PortfolioCard")
  const portfolio = {
    updatedAt: "now", note: "n", total: 29_620_000,
    industry: [{ label: "Ind", value: 13_550_000, pct: 45.8 }],
    exposure: [{ label: "Exp", value: 1, pct: 100 }],
  }
  const html = renderToStaticMarkup(<PortfolioCard portfolio={portfolio as never} />)
  assert.match(html, /% of NAV/)
  assert.doesNotMatch(html, /% of AUM/)
  assert.match(html, /\$13\.55M/) // explicit value kept
  assert.match(html, /\$29\.62M/) // explicit legacy donut total preserved (not the 29.61M sum)
})

test("PortfolioCard: enabled-but-empty Snapshot shows the empty state", async () => {
  const { PortfolioCard } = await import("../components/PortfolioCard")
  const portfolio = {
    updatedAt: "now", note: "n", total: 1,
    industry: [{ label: "Ind", value: 1, pct: 100 }],
    exposure: [{ label: "Exp", value: 1, pct: 100 }],
    snapshot: [],
  }
  const html = renderToStaticMarkup(
    <PortfolioCard portfolio={portfolio as never} enabledViews={{ snapshot: true, industry: true, exposure: true }} />,
  )
  assert.match(html, /No breakdown data yet/)
})

test("PortfolioCard: disabled views are hidden from the tab list (legacy = industry+exposure, no snapshot)", async () => {
  const { PortfolioCard } = await import("../components/PortfolioCard")
  const portfolio = {
    updatedAt: "now", note: "n", total: 1,
    industry: [{ label: "Ind", value: 1, pct: 100 }],
    exposure: [{ label: "Exp", value: 1, pct: 100 }],
  }
  // Legacy caller (no enabledViews): industry + exposure, NO Snapshot tab.
  const legacy = renderToStaticMarkup(<PortfolioCard portfolio={portfolio as never} />)
  assert.match(legacy, /Industry/)
  assert.match(legacy, /Exposure/)
  assert.doesNotMatch(legacy, /Snapshot/)

  // Explicit: only Industry enabled → no Snapshot/Exposure tabs.
  const industryOnly = renderToStaticMarkup(
    <PortfolioCard portfolio={portfolio as never} enabledViews={{ snapshot: false, industry: true, exposure: false }} />,
  )
  assert.doesNotMatch(industryOnly, /Snapshot/)
  assert.doesNotMatch(industryOnly, /Exposure/)
})

test("VaultConfigCard is collapsed by default (compact header + badges, form hidden)", async () => {
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query")
  const { VaultConfigCard } = await import("./AdminConfig")
  const client = new QueryClient()
  const configured = { ...product, productId: "abtc", symbol: "aBTC", vaultConfig: vaultConfig({ pinned: true, hidden: true }) }
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <VaultConfigCard product={configured as never} auth={operatorTokenAuth("t")} />
    </QueryClientProvider>,
  )
  assert.match(html, /aBTC/) // symbol in the header
  assert.match(html, /Pinned/) // badge
  assert.match(html, /Hidden/) // badge
  assert.doesNotMatch(html, /Display name/) // form body collapsed → hidden
  assert.doesNotMatch(html, /Portfolio breakdowns/)
})

test("VaultConfigCard: Description input removed, AUM input added, About kept", () => {
  const source = readFileSync("src/demo/giwa/AdminConfig.tsx", "utf8")
  // The §2 description input is gone (its placeholder + the description state hook).
  assert.doesNotMatch(source, /Shown on product surfaces/)
  assert.doesNotMatch(source, /setDescription/)
  // AUM field + config-first save present; About retained.
  assert.match(source, /AUM \(fund AUM/)
  assert.match(source, /aum: aum\.trim\(\) \|\| null/)
  assert.match(source, /About \(one paragraph per blank line\)/)
})

test("redeem panel auto-switches to Request redemption when the payout exceeds instant liquidity", () => {
  const html = renderToStaticMarkup(
    <GiwaInvestPanel
      product={product}
      {...panelBaseProps()}
      operation="redeemInstant"
      amount="5"
      price={1}
      productBalance="10"
      instantLiquidityUsd={1}
      baseUsd={1}
    />,
  )
  // Auto-switch: the single primary button becomes the request action, never the instant revert path.
  assert.match(html, /Request redemption/)
  assert.doesNotMatch(html, /Redeem instant/)
  // Neutral notice explains the fallback in the product's own symbols.
  assert.match(html, /Instant liquidity is 1 USDC/)
  assert.match(html, /processed as a redemption request/)
  assert.match(html, /your aCAPIX is redeemed now/)
})

test("redeem panel keeps Redeem instant when the payout is within instant liquidity", () => {
  const html = renderToStaticMarkup(
    <GiwaInvestPanel
      product={product}
      {...panelBaseProps()}
      operation="redeemInstant"
      amount="5"
      price={1}
      productBalance="10"
      instantLiquidityUsd={1000}
      baseUsd={1}
    />,
  )
  assert.match(html, /Redeem instant/)
  assert.doesNotMatch(html, /Request redemption/)
  assert.doesNotMatch(html, /processed as a redemption request/)
})

test("redeem panel keeps the instant path when liquidity or rate is unknown (no false fallback)", () => {
  const unknownLiquidity = renderToStaticMarkup(
    <GiwaInvestPanel
      product={product}
      {...panelBaseProps()}
      operation="redeemInstant"
      amount="5"
      price={1}
      productBalance="10"
      instantLiquidityUsd={null}
      baseUsd={1}
    />,
  )
  assert.match(unknownLiquidity, /Redeem instant/)
  assert.doesNotMatch(unknownLiquidity, /Request redemption/)

  const unknownRate = renderToStaticMarkup(
    <GiwaInvestPanel
      product={product}
      {...panelBaseProps()}
      operation="redeemInstant"
      amount="5"
      price={1}
      productBalance="10"
      instantLiquidityUsd={1}
      baseUsd={null}
    />,
  )
  assert.match(unknownRate, /Redeem instant/)
  assert.doesNotMatch(unknownRate, /Request redemption/)
})

test("redeem fallback compares payout and liquidity in USD (payout is scaled by baseUsd)", () => {
  // Payout is 5 payment-asset units; instant liquidity is 8 USD. In payment-asset units 5 < 8
  // would (wrongly) stay instant — but at baseUsd 2 the payout is 10 USD > 8, so it must switch.
  const html = renderToStaticMarkup(
    <GiwaInvestPanel
      product={product}
      {...panelBaseProps()}
      operation="redeemInstant"
      amount="5"
      price={1}
      productBalance="10"
      instantLiquidityUsd={8}
      baseUsd={2}
    />,
  )
  assert.match(html, /Request redemption/)
  assert.doesNotMatch(html, /Redeem instant/)
  assert.match(html, /Instant liquidity is 4 USDC/) // 8 USD / baseUsd 2 = 4 payment-asset units
})

test("pending tab surfaces a REQUESTED redemption as Pending (the new request appears in the list)", () => {
  const pending: GiwaRedemption[] = [
    {
      requestId: "42",
      status: "REQUESTED",
      sharesIn: "1000000000000000000",
      lockedAssetsOut: "0",
      createdAt: "2026-07-01T00:00:00.000Z",
      settledAt: null,
      fulfilledAt: null,
    } as unknown as GiwaRedemption,
  ]
  const html = renderToStaticMarkup(
    <GiwaInvestPanel
      product={product}
      {...panelBaseProps()}
      operation="claimRedeem"
      pendingRedemptions={pending}
      instantLiquidityUsd={null}
    />,
  )
  assert.match(html, /ARCO-42/)
  assert.match(html, /Pending/)
  assert.doesNotMatch(html, /No pending redemptions/)
})

test("requestRedeem is a distinct redemption-vault call from redeemInstant (the pending-request path)", () => {
  const recipient = "0x00000000000000000000000000000000000000aa" as HexAddress
  const instant = encodedOperationCall(product, "redeemInstant", 100n, recipient)
  const request = encodedOperationCall(product, "requestRedeem", 100n, recipient)
  assert.equal(instant.to, product.redemptionVaultAddress)
  assert.equal(request.to, product.redemptionVaultAddress)
  // Different selectors => the fallback submits requestRedeem (creates a pending request that
  // lands in the admin payout queue), not redeemInstant (which reverts when liquidity is short).
  assert.notEqual(request.data, instant.data)
})

test("redeem tab renders the Instant liquidity row in the payment asset", () => {
  const html = renderToStaticMarkup(
    <GiwaInvestPanel
      product={product}
      {...panelBaseProps()}
      operation="redeemInstant"
      amount="1"
      price={1}
      productBalance="10"
      instantLiquidityUsd={1000}
      baseUsd={1}
    />,
  )
  // The row now renders on the redeem tab (previously invest-only) with the value in the
  // payment asset, matching the request-fallback notice format.
  assert.match(html, /Instant liquidity/)
  assert.match(html, /1,000 USDC/)
  // Payout (1) is within liquidity (1000) → instant path, so no request-fallback notice.
  assert.doesNotMatch(html, /processed as a redemption request/)
  assert.match(html, /Redeem instant/)
})
