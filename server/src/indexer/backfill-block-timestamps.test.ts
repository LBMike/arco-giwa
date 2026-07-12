import assert from "node:assert/strict"
import test from "node:test"
import { backfillBlockTimestamps } from "./backfill-block-timestamps.js"

test("backfill sets blockTimestamp on every null row and fetches each block once", async () => {
  const rows = [
    { id: "a", chainId: 1, blockNumber: 10n, blockTimestamp: null as Date | null },
    { id: "b", chainId: 1, blockNumber: 10n, blockTimestamp: null as Date | null }, // same block → served from cache
    { id: "c", chainId: 1, blockNumber: 11n, blockTimestamp: null as Date | null },
  ]
  let fetches = 0

  const result = await backfillBlockTimestamps({
    prisma: {
      evmIndexedEvent: {
        async findMany() {
          return rows.filter((row) => row.blockTimestamp === null)
        },
        async update({ where, data }) {
          const row = rows.find((r) => r.id === where.id)
          if (row) row.blockTimestamp = data.blockTimestamp
        },
      },
    },
    async getBlockTimestamp(_chainId, blockNumber) {
      fetches += 1
      return new Date(Number(blockNumber) * 1000)
    },
  })

  assert.equal(result.scanned, 3)
  assert.equal(result.updated, 3)
  assert.equal(result.blocksFetched, 2) // blocks 10 and 11 — block 10 fetched once, reused for row "b"
  assert.equal(fetches, 2)
  assert.equal(rows[0].blockTimestamp?.getTime(), 10 * 1000)
  assert.equal(rows[1].blockTimestamp?.getTime(), 10 * 1000)
  assert.equal(rows[2].blockTimestamp?.getTime(), 11 * 1000)
})
