import { runBackfillBlockTimestamps } from "../../server/dist/indexer/backfill-block-timestamps.js"

const result = await runBackfillBlockTimestamps()
console.log(JSON.stringify({ service: "arco-giwa-backfill-block-timestamps", result }))
