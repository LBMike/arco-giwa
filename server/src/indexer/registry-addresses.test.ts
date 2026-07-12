import assert from "node:assert/strict"
import { test } from "node:test"
import { productForVault, registryIndexedAddresses } from "./registry-addresses.js"

function product(id: string, base: string) {
  return {
    productId: id,
    productToken: { proxy: `${base}token` },
    depositVault: { proxy: `${base}dep` },
    redemptionVault: { proxy: `${base}red` },
    priceFeed: { proxy: `${base}feed` },
  }
}

function registry(products: unknown[]) {
  return { chainId: 91342, faucet: { proxy: "0xfaucet" }, products } as never
}

test("registryIndexedAddresses is registry-derived — a newly-registered vault's 4 contracts get watched", () => {
  const before = registryIndexedAddresses(registry([product("acapix", "0xa")]))
  assert.ok(before.includes("0xfaucet" as never))
  assert.ok(["0xatoken", "0xadep", "0xared", "0xafeed"].every((address) => before.includes(address as never)))
  assert.equal(before.length, 5) // faucet + 4 per product, not a fixed 6×4 list

  // Register a 7th vault (bEQTY-like) → token/deposit/redemption/priceFeed all appear.
  const after = registryIndexedAddresses(registry([product("acapix", "0xa"), product("beqty", "0xb")]))
  assert.ok(["0xbtoken", "0xbdep", "0xbred", "0xbfeed"].every((address) => after.includes(address as never)))
  assert.equal(after.length, 9)
})

test("registryIndexedAddresses drops products' missing (null/undefined) addresses", () => {
  const addresses = registryIndexedAddresses({
    chainId: 91342,
    faucet: { proxy: null },
    products: [
      {
        productToken: { proxy: "0xtoken" },
        depositVault: { proxy: null },
        redemptionVault: { proxy: "0xred" },
        priceFeed: { proxy: undefined },
      },
    ],
  } as never)
  assert.deepEqual(addresses, ["0xtoken", "0xred"])
})

test("productForVault resolves any registry product by redemption vault (case-insensitive)", () => {
  const reg = registry([product("beqty", "0xb")])
  assert.equal(productForVault(reg, "0xBRED")?.productId, "beqty")
  assert.equal(productForVault(reg, "0xmissing"), null)
})
