// Test-only subprocess: read public journal, no key and no write-capable RPC.
import { readFile } from "fs/promises"
import path from "path"
import { inspectLocalDeployment } from "../../scripts/stocks/local-executor"
import { filesystemStocksArtifacts } from "../../scripts/stocks/prepare-deployment"

async function main() {
  const [file, endpoint] = process.argv.slice(2)
  if (!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(endpoint)) throw Error("TEST_LOOPBACK_REQUIRED")
  const context = JSON.parse(await readFile(file, "utf8"))
  const state = await inspectLocalDeployment({
    ...context,
    artifacts: filesystemStocksArtifacts(path.resolve("artifacts/stocks")),
    rpc: async (method, params) => {
      if (/send|sign/.test(method)) throw Error("READ_ONLY_TEST_RECOVERY")
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(10000),
      })
      const body: any = await response.json()
      if (!response.ok || body.error) throw Error("TEST_RPC_FAILED")
      return body.result
    },
  })
  console.log(JSON.stringify({ next: state.next?.index ?? null, count: state.entries.length }))
}
if (require.main === module)
  main().catch(() => {
    console.error("TEST_RECOVERY_FAILED")
    process.exitCode = 1
  })
