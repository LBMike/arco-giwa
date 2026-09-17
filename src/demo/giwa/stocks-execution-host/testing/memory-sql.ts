// TEST FIXTURE ONLY. Never import this module from product code.
//
// A stateful in-memory SqlPool ({ query, connect }) that implements exactly the statements the real Stocks,
// execution and wallet-submission server code issues on the browser integration paths. Statements are matched
// on whitespace-normalized text; anything else throws UNSUPPORTED_SQL so a server change fails loudly.
// Row shapes follow node-postgres: NUMERIC as string, TIMESTAMPTZ as Date, JSONB parsed. Transactions are
// serialized by one async mutex (autocommit statements take it too), so FOR UPDATE rows and advisory locks
// hold trivially. BEGIN snapshots every table; ROLLBACK restores it. The constraints and triggers of the
// Stocks migrations that these statements can reach are enforced as a safety net.

export type SqlRow = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
export type SqlResult = { rows: SqlRow[]; rowCount: number | null }
export type MemorySqlClient = { query(text: string, values?: unknown[]): Promise<SqlResult>; release(): void }
export type MemorySqlPool = { query(text: string, values?: unknown[]): Promise<SqlResult>; connect(): Promise<MemorySqlClient> }

const COLUMNS = {
  StocksQuote: ["id", "actorId", "wallet", "symbol", "quantity", "cashAmount", "deploymentDigest", "expiresAt", "createdAt"],
  StocksOrder: ["id", "orderKey", "quoteId", "actorId", "wallet", "symbol", "quantity", "cashAmount", "idempotencyKey", "deploymentId", "deploymentDigest", "quoteExpiresAt", "state", "version", "createdAt", "updatedAt"],
  StocksSellQuote: ["id", "actorId", "wallet", "symbol", "quantity", "cashAmount", "deploymentDigest", "expiresAt", "createdAt"],
  StocksSellOrder: ["id", "orderKey", "quoteId", "actorId", "wallet", "symbol", "quantity", "cashAmount", "idempotencyKey", "deploymentId", "deploymentDigest", "quoteExpiresAt", "state", "version", "createdAt", "updatedAt"],
  StocksHolding: ["orderId", "actorId", "wallet", "symbol", "quantity", "deploymentId", "deploymentDigest", "txHash", "blockHash", "blockNumber", "createdAt"],
  StocksQuantityMovement: ["id", "deploymentDigest", "wallet", "custodyId", "walletDelta", "escrowDelta", "supplyDelta", "blockNumber", "blockHash", "txHash", "createdAt"],
  StocksQuantityReservation: ["orderId", "deploymentDigest", "wallet", "quantity", "status", "createdAt"],
  StocksAudit: ["id", "subject", "action", "detail", "deploymentDigest", "createdAt"],
  StocksLiquidityBinding: ["scopeKey", "deploymentDigest", "createdAt"],
  StocksWalletSubmissionEnrollment: ["side", "orderId", "intentKey", "actorId", "wallet", "deploymentDigest", "orderBinding", "createdAt"],
  StocksWalletSubmission: ["claimId", "intentKey", "stage", "transactionDigest", "transaction", "actorId", "wallet", "side", "orderId", "deploymentDigest", "status", "txHash", "createdAt", "updatedAt"],
  StocksWalletSubmissionProof: ["claimId", "intentKey", "transactionDigest", "deploymentDigest", "txHash", "status", "blockNumber", "blockHash", "proofDigest", "evidence", "createdAt"],
} as const

export type TableName = keyof typeof COLUMNS
export type Tables = { [K in TableName]: SqlRow[] }
export const TABLE_NAMES = Object.keys(COLUMNS) as TableName[]

const BUY_STATES = ["AWAITING_FUNDING", "FUNDED_QUOTE_EXPIRED", "FUNDING_REVIEW_REQUIRED", "BROKER_PENDING", "BROKER_UNKNOWN", "MINT_QUEUED", "MINT_SUBMITTED", "MINT_FINALITY_PENDING", "MINT_UNKNOWN", "COMPLETED", "REFUNDED", "REVIEW_REQUIRED"]
const SELL_STATES = ["AWAITING_ESCROW", "EXPIRED", "ESCROW_HELD", "ESCROW_REVIEW_REQUIRED", "LIQUIDITY_PENDING", "SELL_BROKER_PENDING", "SELL_BROKER_UNKNOWN", "SELL_PARTIAL_HELD", "REDEEM_QUEUED", "RETURN_QUEUED", "SETTLEMENT_PENDING", "SETTLEMENT_UNKNOWN", "COMPLETED", "RETURNED", "REVIEW_REQUIRED"]
const SUBMISSION_STATUSES = ["REQUEST_MAY_START", "UNKNOWN", "SUBMITTED", "CONFIRMED", "REVERTED"]
const DIGEST = /^[0-9a-f]{64}$/
const LOWER_WALLET = /^0x[0-9a-f]{40}$/
const TX_HASH = /^0x[0-9a-f]{64}$/
const ZERO_HASH = `0x${"0".repeat(64)}`

export function normalizeSql(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function pgError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

function check(condition: unknown, table: TableName, constraint: string) {
  if (!condition) throw pgError(`new row for relation "${table}" violates check constraint "${constraint}"`, "23514")
}

function raise(condition: unknown, message: string) {
  if (!condition) throw pgError(message, "P0001")
}

function numeric(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "bigint" && !(typeof value === "number" && Number.isSafeInteger(value))) throw pgError("invalid input syntax for type numeric", "22P02")
  const text = String(value)
  if (!/^-?\d+$/.test(text)) throw pgError("invalid input syntax for type numeric", "22P02")
  return BigInt(text).toString()
}

function timestamp(value: unknown): Date {
  const at = value instanceof Date ? new Date(value.getTime()) : typeof value === "string" ? new Date(value) : new Date(Number.NaN)
  if (!Number.isFinite(at.getTime())) throw pgError("invalid input syntax for type timestamp with time zone", "22007")
  return at
}

function jsonb(value: unknown): unknown {
  if (typeof value !== "string") throw pgError("invalid input syntax for type json", "22P02")
  return JSON.parse(value)
}

function text(value: unknown): string {
  if (typeof value !== "string") throw pgError("invalid input syntax for type text", "22P02")
  return value
}

function sum(values: unknown[]): string {
  return values.reduce<bigint>((total, value) => total + BigInt(String(value)), 0n).toString()
}

type Db = { tables: Tables; now(): Date }
type Handler = { write: boolean; run(db: Db, params: unknown[]): SqlResult }

const result = (rows: SqlRow[]): SqlResult => ({ rows, rowCount: rows.length })
const command = (rowCount: number | null): SqlResult => ({ rows: [], rowCount })

function shape(table: TableName, values: SqlRow): SqlRow {
  return Object.fromEntries(COLUMNS[table].map((column) => [column, values[column] ?? null]))
}

function unique(db: Db, table: TableName, row: SqlRow, columns: string[], constraint: string) {
  const clash = db.tables[table].some((existing) => columns.every((column) => existing[column] === row[column]))
  if (clash) throw pgError(`duplicate key value violates unique constraint "${constraint}"`, "23505")
}

function hasConflict(db: Db, table: TableName, row: SqlRow, columns: string[]) {
  return db.tables[table].some((existing) => columns.every((column) => existing[column] === row[column]))
}

// ---- wallet submission triggers and checks (20260918/20260919 migrations) ----

function checkSubmission(row: SqlRow) {
  const table: TableName = "StocksWalletSubmission"
  check(DIGEST.test(row.intentKey) && DIGEST.test(row.transactionDigest) && DIGEST.test(row.deploymentDigest), table, "digest_format")
  check(row.stage === "APPROVAL" || row.stage === "TRANSFER", table, "stage_check")
  check(row.side === "BUY" || row.side === "SELL", table, "side_check")
  check(LOWER_WALLET.test(row.wallet), table, "wallet_check")
  check(SUBMISSION_STATUSES.includes(row.status), table, "StocksWalletSubmission_status_check")
  check(row.txHash === null || (TX_HASH.test(row.txHash) && row.txHash !== ZERO_HASH), table, "txHash_check")
  check(row.status !== "SUBMITTED" || row.txHash !== null, table, "submitted_hash")
  check(row.status !== "REQUEST_MAY_START" || row.txHash === null, table, "request_may_start_hash")
  check(!["CONFIRMED", "REVERTED"].includes(row.status) || row.txHash !== null, table, "StocksWalletSubmission_terminal_hash")
}

const BINDING_COLUMNS = ["claimId", "intentKey", "stage", "transactionDigest", "actorId", "wallet", "side", "orderId", "deploymentDigest"]

function guardSubmissionUpdate(db: Db, old: SqlRow, next: SqlRow) {
  const bindingChanged = BINDING_COLUMNS.some((column) => old[column] !== next[column]) || JSON.stringify(old.transaction) !== JSON.stringify(next.transaction) || old.createdAt.getTime() !== next.createdAt.getTime()
  raise(!bindingChanged, "SUBMISSION_BINDING_IMMUTABLE")
  const terminal = (status: string) => status === "CONFIRMED" || status === "REVERTED"
  const regression = (terminal(old.status) && next.status !== old.status) || (old.status !== "REQUEST_MAY_START" && next.status === "REQUEST_MAY_START") || (old.status === "SUBMITTED" && !["SUBMITTED", "CONFIRMED", "REVERTED"].includes(next.status))
  raise(!regression, "SUBMISSION_STATUS_REGRESSION")
  raise(old.txHash === null || next.txHash === old.txHash, "SUBMISSION_HASH_IMMUTABLE")
  if (terminal(next.status)) {
    const proven = db.tables.StocksWalletSubmissionProof.some((proof) => proof.claimId === next.claimId && proof.intentKey === next.intentKey && proof.transactionDigest === next.transactionDigest && proof.deploymentDigest === next.deploymentDigest && proof.txHash === next.txHash && proof.status === next.status)
    raise(proven, "SUBMISSION_TRUSTED_PROOF_REQUIRED")
  }
}

function guardProofInsert(db: Db, proof: SqlRow) {
  const table: TableName = "StocksWalletSubmissionProof"
  check(DIGEST.test(proof.intentKey) && DIGEST.test(proof.transactionDigest) && DIGEST.test(proof.deploymentDigest) && DIGEST.test(proof.proofDigest), table, "digest_format")
  check(TX_HASH.test(proof.txHash) && proof.txHash !== ZERO_HASH && TX_HASH.test(proof.blockHash) && proof.blockHash !== ZERO_HASH, table, "hash_format")
  check(proof.status === "CONFIRMED" || proof.status === "REVERTED", table, "status_check")
  const bound = db.tables.StocksWalletSubmission.some((row) => row.claimId === proof.claimId && row.intentKey === proof.intentKey && row.transactionDigest === proof.transactionDigest && row.deploymentDigest === proof.deploymentDigest && row.txHash === proof.txHash && ["UNKNOWN", "SUBMITTED"].includes(row.status))
  raise(bound, "SUBMISSION_PROOF_BINDING_MISMATCH")
  const evidence = proof.evidence
  const envelope = evidence !== null && typeof evidence === "object" && !Array.isArray(evidence)
    && evidence.version === 1 && evidence.claimId === proof.claimId && evidence.intentKey === proof.intentKey && evidence.transactionDigest === proof.transactionDigest
    && evidence.deploymentDigest === proof.deploymentDigest && evidence.txHash === proof.txHash && evidence.status === proof.status
    && evidence.blockNumber === proof.blockNumber && evidence.blockHash === proof.blockHash
  raise(envelope, "SUBMISSION_PROOF_ENVELOPE_MISMATCH")
  unique(db, table, proof, ["claimId"], "StocksWalletSubmissionProof_pkey")
}

// ---- statement handlers ----

function createHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  const on = (sql: string, write: boolean, run: Handler["run"]) => {
    const key = normalizeSql(sql)
    if (handlers.has(key)) throw new Error(`DUPLICATE_SQL_HANDLER: ${key.slice(0, 100)}`)
    handlers.set(key, { write, run })
  }

  // Stocks repository (server/src/stocks/repository.ts)
  on('INSERT INTO arco_evm."StocksAudit" (id,subject,action,detail,"deploymentDigest") VALUES ($1,$2,$3,$4,$5)', true, (db, [id, subject, action, detail, digest]) => {
    const row = shape("StocksAudit", { id: text(id), subject: text(subject), action: text(action), detail: jsonb(detail), deploymentDigest: text(digest), createdAt: db.now() })
    unique(db, "StocksAudit", row, ["id"], "StocksAudit_pkey")
    db.tables.StocksAudit.push(row)
    return command(1)
  })
  on('SELECT * FROM arco_evm."StocksOrder" WHERE "actorId"=$1 AND "deploymentDigest"=$3 AND ($2::text IS NULL OR id=$2) ORDER BY "createdAt" DESC LIMIT 100', false, (db, [actorId, id, digest]) =>
    result(newestFirst(db.tables.StocksOrder.filter((row) => row.actorId === actorId && row.deploymentDigest === digest && (id === null || row.id === id))).slice(0, 100)))
  on(`SELECT *,'SELL' AS side FROM arco_evm."StocksSellOrder" WHERE "actorId"=$1 AND "deploymentDigest"=$2 AND ($3::text IS NULL OR id=$3) ORDER BY "createdAt" DESC LIMIT 100`, false, (db, [actorId, digest, id]) =>
    result(newestFirst(db.tables.StocksSellOrder.filter((row) => row.actorId === actorId && row.deploymentDigest === digest && (id === null || row.id === id))).slice(0, 100).map((row) => ({ ...row, side: "SELL" }))))
  on(`SELECT
          (SELECT COALESCE(SUM(quantity),0) FROM arco_evm."StocksHolding" WHERE "deploymentDigest"=$1 AND wallet=$2)+
          (SELECT COALESCE(SUM("walletDelta"),0) FROM arco_evm."StocksQuantityMovement" WHERE "deploymentDigest"=$1 AND wallet=$2) AS wallet,
          (SELECT COALESCE(SUM("escrowDelta"),0) FROM arco_evm."StocksQuantityMovement" WHERE "deploymentDigest"=$1 AND wallet=$2) AS escrow,
          (SELECT COALESCE(SUM(quantity),0) FROM arco_evm."StocksQuantityReservation" WHERE "deploymentDigest"=$1 AND wallet=$2 AND status='ACTIVE') AS reserved`, false, (db, [digest, wallet]) => {
    const scoped = <T extends SqlRow>(rows: T[]) => rows.filter((row) => row.deploymentDigest === digest && row.wallet === wallet)
    const movements = scoped(db.tables.StocksQuantityMovement)
    const holdings = sum(scoped(db.tables.StocksHolding).map((row) => row.quantity))
    return result([{
      wallet: (BigInt(holdings) + BigInt(sum(movements.map((row) => row.walletDelta)))).toString(),
      escrow: sum(movements.map((row) => row.escrowDelta)),
      reserved: sum(scoped(db.tables.StocksQuantityReservation).filter((row) => row.status === "ACTIVE").map((row) => row.quantity)),
    }])
  })
  on('SELECT * FROM arco_evm."StocksOrder" WHERE id=$1 AND "deploymentDigest"=$2 FOR UPDATE', false, (db, [id, digest]) =>
    result(db.tables.StocksOrder.filter((row) => row.id === id && row.deploymentDigest === digest)))
  on('UPDATE arco_evm."StocksOrder" SET state=$1,version=version+1,"updatedAt"=clock_timestamp() WHERE id=$2 AND version=$3 AND "deploymentDigest"=$4', true, (db, params) => updateState(db, "StocksOrder", BUY_STATES, params))

  // Portfolio (repository.portfolio)
  on(`SELECT wallet FROM arco_evm."StocksHolding" WHERE "actorId"=$1 AND "deploymentDigest"=$2 UNION SELECT wallet FROM arco_evm."StocksSellOrder" WHERE "actorId"=$1 AND "deploymentDigest"=$2`, false, (db, [actorId, digest]) => {
    const wallets = [...db.tables.StocksHolding, ...db.tables.StocksSellOrder].filter((row) => row.actorId === actorId && row.deploymentDigest === digest).map((row) => row.wallet as string)
    return result([...new Set(wallets)].map((wallet) => ({ wallet })))
  })
  on(`SELECT id,state,quantity::text,"cashAmount"::text,'BUY' AS side FROM arco_evm."StocksOrder" WHERE "actorId"=$1 AND "deploymentDigest"=$2 AND state NOT IN('COMPLETED','REFUNDED') UNION ALL SELECT id,state,quantity::text,"cashAmount"::text,'SELL' AS side FROM arco_evm."StocksSellOrder" WHERE "actorId"=$1 AND "deploymentDigest"=$2 AND state NOT IN('COMPLETED','RETURNED','EXPIRED')`, false, (db, [actorId, digest]) => {
    const pick = (row: SqlRow, side: string) => ({ id: row.id, state: row.state, quantity: row.quantity, cashAmount: row.cashAmount, side })
    const scoped = (row: SqlRow) => row.actorId === actorId && row.deploymentDigest === digest
    const buy = db.tables.StocksOrder.filter((row) => scoped(row) && !["COMPLETED", "REFUNDED"].includes(row.state)).map((row) => pick(row, "BUY"))
    const sell = db.tables.StocksSellOrder.filter((row) => scoped(row) && !["COMPLETED", "RETURNED", "EXPIRED"].includes(row.state)).map((row) => pick(row, "SELL"))
    return result([...buy, ...sell])
  })

  // StocksService (server/src/stocks/service.ts)
  on('INSERT INTO arco_evm."StocksLiquidityBinding" ("scopeKey","deploymentDigest") VALUES($1,$2) ON CONFLICT DO NOTHING', true, (db, [scopeKey, digest]) => {
    const row = shape("StocksLiquidityBinding", { scopeKey: text(scopeKey), deploymentDigest: text(digest), createdAt: db.now() })
    if (hasConflict(db, "StocksLiquidityBinding", row, ["scopeKey"]) || hasConflict(db, "StocksLiquidityBinding", row, ["deploymentDigest"])) return command(0)
    db.tables.StocksLiquidityBinding.push(row)
    return command(1)
  })
  on('SELECT "deploymentDigest" FROM arco_evm."StocksLiquidityBinding" WHERE "scopeKey"=$1', false, (db, [scopeKey]) =>
    result(db.tables.StocksLiquidityBinding.filter((row) => row.scopeKey === scopeKey).map((row) => ({ deploymentDigest: row.deploymentDigest }))))
  on(`INSERT INTO arco_evm."StocksQuote" (id,"actorId",wallet,symbol,quantity,"cashAmount","deploymentDigest","expiresAt") VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '60 seconds') RETURNING *`, true, (db, [id, actorId, wallet, symbol, quantity, cash, digest]) =>
    insertQuote(db, "StocksQuote", { id, actorId, wallet, symbol, quantity, cash, digest }))
  on('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', false, (_db, [key]) => {
    text(key)
    return result([{ pg_advisory_xact_lock: "" }])
  })
  on('SELECT * FROM arco_evm."StocksOrder" WHERE "actorId"=$1 AND "idempotencyKey"=$2', false, (db, [actorId, key]) =>
    result(db.tables.StocksOrder.filter((row) => row.actorId === actorId && row.idempotencyKey === key)))
  on('SELECT *, "expiresAt">clock_timestamp() AS valid FROM arco_evm."StocksQuote" WHERE id=$1 FOR UPDATE', false, (db, [id]) =>
    result(db.tables.StocksQuote.filter((row) => row.id === id).map((row) => ({ ...row, valid: row.expiresAt.getTime() > db.now().getTime() }))))
  on('SELECT id FROM arco_evm."StocksOrder" WHERE "quoteId"=$1', false, (db, [quoteId]) =>
    result(db.tables.StocksOrder.filter((row) => row.quoteId === quoteId).map((row) => ({ id: row.id }))))
  on('INSERT INTO arco_evm."StocksOrder" (id,"orderKey","quoteId","actorId",wallet,symbol,quantity,"cashAmount","idempotencyKey","deploymentId","deploymentDigest","quoteExpiresAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *', true, (db, [id, orderKey, quoteId, actorId, wallet, symbol, quantity, cash, key, deploymentId, digest, expiresAt]) =>
    insertOrder(db, "StocksOrder", { id, orderKey, quoteId, actorId, wallet, symbol, quantity, cash, key, deploymentId, digest, expiresAt }))

  // Enrollment (server/src/stocks-submissions/enrollment.ts)
  on('INSERT INTO arco_evm."StocksWalletSubmissionEnrollment" (side,"orderId","intentKey","actorId",wallet,"deploymentDigest","orderBinding") VALUES($1,$2,$3,$4,$5,$6,$7)', true, (db, [side, orderId, intentKey, actorId, wallet, digest, binding]) => {
    const table: TableName = "StocksWalletSubmissionEnrollment"
    const row = shape(table, { side: text(side), orderId: text(orderId), intentKey: text(intentKey), actorId: text(actorId), wallet: text(wallet), deploymentDigest: text(digest), orderBinding: text(binding), createdAt: db.now() })
    check(row.side === "BUY" || row.side === "SELL", table, "side_check")
    check(DIGEST.test(row.intentKey) && DIGEST.test(row.deploymentDigest) && DIGEST.test(row.orderBinding) && LOWER_WALLET.test(row.wallet), table, "format_check")
    unique(db, table, row, ["side", "orderId"], "StocksWalletSubmissionEnrollment_pkey")
    unique(db, table, row, ["intentKey"], "StocksWalletSubmissionEnrollment_intentKey_key")
    db.tables.StocksWalletSubmissionEnrollment.push(row)
    return command(1)
  })

  // StocksSellService (server/src/stocks/sell-service.ts)
  on(`INSERT INTO arco_evm."StocksSellQuote" (id,"actorId",wallet,symbol,quantity,"cashAmount","deploymentDigest","expiresAt") VALUES ($1,$2,$3,'NVDA',$4,$5,$6,clock_timestamp()+interval '60 seconds') RETURNING *`, true, (db, [id, actorId, wallet, quantity, cash, digest]) =>
    insertQuote(db, "StocksSellQuote", { id, actorId, wallet, symbol: "NVDA", quantity, cash, digest }))
  on('SELECT * FROM arco_evm."StocksSellOrder" WHERE "actorId"=$1 AND "idempotencyKey"=$2', false, (db, [actorId, key]) =>
    result(db.tables.StocksSellOrder.filter((row) => row.actorId === actorId && row.idempotencyKey === key)))
  on('SELECT *,"expiresAt">clock_timestamp() AS valid FROM arco_evm."StocksSellQuote" WHERE id=$1 FOR UPDATE', false, (db, [id]) =>
    result(db.tables.StocksSellQuote.filter((row) => row.id === id).map((row) => ({ ...row, valid: row.expiresAt.getTime() > db.now().getTime() }))))
  on('SELECT id FROM arco_evm."StocksSellOrder" WHERE "quoteId"=$1', false, (db, [quoteId]) =>
    result(db.tables.StocksSellOrder.filter((row) => row.quoteId === quoteId).map((row) => ({ id: row.id }))))
  on(`INSERT INTO arco_evm."StocksSellOrder" (id,"orderKey","quoteId","actorId",wallet,symbol,quantity,"cashAmount","idempotencyKey","deploymentId","deploymentDigest","quoteExpiresAt") VALUES($1,$2,$3,$4,$5,'NVDA',$6,$7,$8,$9,$10,$11) RETURNING *`, true, (db, [id, orderKey, quoteId, actorId, wallet, quantity, cash, key, deploymentId, digest, expiresAt]) =>
    insertOrder(db, "StocksSellOrder", { id, orderKey, quoteId, actorId, wallet, symbol: "NVDA", quantity, cash, key, deploymentId, digest, expiresAt }))
  on(`INSERT INTO arco_evm."StocksQuantityReservation" ("orderId","deploymentDigest",wallet,quantity,status) VALUES($1,$2,$3,$4,'ACTIVE')`, true, (db, [orderId, digest, wallet, quantity]) => {
    const table: TableName = "StocksQuantityReservation"
    const row = shape(table, { orderId: text(orderId), deploymentDigest: text(digest), wallet: text(wallet), quantity: numeric(quantity), status: "ACTIVE", createdAt: db.now() })
    check(BigInt(row.quantity) > 0n, table, "quantity_check")
    if (!db.tables.StocksSellOrder.some((order) => order.id === row.orderId)) throw pgError(`insert or update on table "${table}" violates foreign key constraint`, "23503")
    unique(db, table, row, ["orderId"], "StocksQuantityReservation_pkey")
    db.tables.StocksQuantityReservation.push(row)
    return command(1)
  })
  on('SELECT * FROM arco_evm."StocksSellOrder" WHERE id=$1 AND "deploymentDigest"=$2 FOR UPDATE', false, (db, [id, digest]) =>
    result(db.tables.StocksSellOrder.filter((row) => row.id === id && row.deploymentDigest === digest)))
  on('UPDATE arco_evm."StocksSellOrder" SET state=$1,version=version+1,"updatedAt"=clock_timestamp() WHERE id=$2 AND version=$3 AND "deploymentDigest"=$4', true, (db, params) => updateState(db, "StocksSellOrder", SELL_STATES, params))

  // StocksExecutionService.eligible (server/src/stocks-execution/service.ts)
  on("SET LOCAL statement_timeout='2000ms'", false, () => command(null))
  on("SET LOCAL lock_timeout='2000ms'", false, () => command(null))
  on("SET LOCAL idle_in_transaction_session_timeout='3000ms'", false, () => command(null))
  for (const table of ["StocksOrder", "StocksSellOrder"] as const) {
    on(`SELECT * FROM arco_evm."${table}" WHERE id=$1 AND "actorId"=$2 AND wallet=$3 AND "deploymentDigest"=$4`, false, (db, [id, actorId, wallet, digest]) =>
      result(db.tables[table].filter((row) => row.id === id && row.actorId === actorId && row.wallet === wallet && row.deploymentDigest === digest)))
    // StocksSubmissionsService.order
    on(`SELECT *,"quoteExpiresAt">clock_timestamp() AS valid FROM arco_evm."${table}" WHERE id=$1 AND "deploymentDigest"=$2 FOR UPDATE`, false, (db, [id, digest]) =>
      result(db.tables[table].filter((row) => row.id === id && row.deploymentDigest === digest).map((row) => ({ ...row, valid: row.quoteExpiresAt.getTime() > db.now().getTime() }))))
  }
  on('SELECT * FROM arco_evm."StocksWalletSubmissionEnrollment" WHERE side=$1 AND "orderId"=$2', false, (db, [side, orderId]) =>
    result(db.tables.StocksWalletSubmissionEnrollment.filter((row) => row.side === side && row.orderId === orderId)))
  on('SELECT EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))*1000 AS "remainingMs"', false, (db, [deadline]) =>
    result([{ remainingMs: (timestamp(deadline).getTime() - db.now().getTime()).toFixed(3) }]))

  // StocksSubmissionsService (server/src/stocks-submissions/service.ts)
  on('SELECT * FROM arco_evm."StocksWalletSubmission" WHERE "intentKey"=$1 ORDER BY stage', false, (db, [intentKey]) =>
    result(db.tables.StocksWalletSubmission.filter((row) => row.intentKey === intentKey).sort((a, b) => (a.stage < b.stage ? -1 : a.stage > b.stage ? 1 : 0))))
  on('SELECT * FROM arco_evm."StocksWalletSubmission" WHERE "intentKey"=$1 FOR UPDATE', false, (db, [intentKey]) =>
    result(db.tables.StocksWalletSubmission.filter((row) => row.intentKey === intentKey)))
  on(`SELECT 1 FROM arco_evm."StocksWalletSubmissionProof" WHERE "claimId"=$1 AND status='CONFIRMED' AND "txHash"=$2 AND "transactionDigest"=$3 AND "intentKey"=$4 AND "deploymentDigest"=$5`, false, (db, [claimId, txHash, transactionDigest, intentKey, digest]) =>
    result(db.tables.StocksWalletSubmissionProof.filter((row) => row.claimId === claimId && row.status === "CONFIRMED" && row.txHash === txHash && row.transactionDigest === transactionDigest && row.intentKey === intentKey && row.deploymentDigest === digest).map(() => ({ "?column?": 1 }))))
  on('SELECT $1::timestamptz>clock_timestamp() AS valid', false, (db, [deadline]) =>
    result([{ valid: timestamp(deadline).getTime() > db.now().getTime() }]))
  on(`INSERT INTO arco_evm."StocksWalletSubmission" ("claimId","intentKey",stage,"transactionDigest",transaction,"actorId",wallet,side,"orderId","deploymentDigest",status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'REQUEST_MAY_START') ON CONFLICT("intentKey",stage) DO NOTHING RETURNING *`, true, (db, [claimId, intentKey, stage, transactionDigest, transaction, actorId, wallet, side, orderId, digest]) => {
    const now = db.now()
    const row = shape("StocksWalletSubmission", { claimId: text(claimId), intentKey: text(intentKey), stage: text(stage), transactionDigest: text(transactionDigest), transaction: jsonb(transaction), actorId: text(actorId), wallet: text(wallet), side: text(side), orderId: text(orderId), deploymentDigest: text(digest), status: "REQUEST_MAY_START", txHash: null, createdAt: now, updatedAt: now })
    // BEFORE INSERT trigger stocks_wallet_submission_initial
    raise(row.status === "REQUEST_MAY_START" && row.txHash === null, "SUBMISSION_INITIAL_STATE_REQUIRED")
    checkSubmission(row)
    if (hasConflict(db, "StocksWalletSubmission", row, ["intentKey", "stage"])) return result([])
    unique(db, "StocksWalletSubmission", row, ["claimId"], "StocksWalletSubmission_pkey")
    if (!db.tables.StocksWalletSubmissionEnrollment.some((enrollment) => enrollment.side === row.side && enrollment.orderId === row.orderId)) throw pgError('insert or update on table "StocksWalletSubmission" violates foreign key constraint', "23503")
    db.tables.StocksWalletSubmission.push(row)
    return result([row])
  })
  on('SELECT * FROM arco_evm."StocksWalletSubmission" WHERE "claimId"=$1 AND "actorId"=$2 AND wallet=$3 AND "deploymentDigest"=$4', false, (db, [claimId, actorId, wallet, digest]) =>
    result(db.tables.StocksWalletSubmission.filter((row) => row.claimId === claimId && row.actorId === actorId && row.wallet === wallet && row.deploymentDigest === digest)))
  on('SELECT * FROM arco_evm."StocksWalletSubmission" WHERE "claimId"=$1 FOR UPDATE', false, (db, [claimId]) =>
    result(db.tables.StocksWalletSubmission.filter((row) => row.claimId === claimId)))
  on('INSERT INTO arco_evm."StocksWalletSubmissionProof" ("claimId","intentKey","transactionDigest","deploymentDigest","txHash",status,"blockNumber","blockHash","proofDigest",evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', true, (db, [claimId, intentKey, transactionDigest, digest, txHash, status, blockNumber, blockHash, proofDigest, evidence]) => {
    const row = shape("StocksWalletSubmissionProof", { claimId: text(claimId), intentKey: text(intentKey), transactionDigest: text(transactionDigest), deploymentDigest: text(digest), txHash: text(txHash), status: text(status), blockNumber: numeric(blockNumber), blockHash: text(blockHash), proofDigest: text(proofDigest), evidence: jsonb(evidence), createdAt: db.now() })
    guardProofInsert(db, row)
    db.tables.StocksWalletSubmissionProof.push(row)
    return command(1)
  })
  on('UPDATE arco_evm."StocksWalletSubmission" SET status=$2,"updatedAt"=clock_timestamp() WHERE "claimId"=$1 RETURNING *', true, (db, [claimId, status]) =>
    updateSubmission(db, claimId, (row) => ({ ...row, status: text(status) })))
  on('UPDATE arco_evm."StocksWalletSubmission" SET status=$2,"txHash"=$3,"updatedAt"=clock_timestamp() WHERE "claimId"=$1 RETURNING *', true, (db, [claimId, status, txHash]) =>
    updateSubmission(db, claimId, (row) => ({ ...row, status: text(status), txHash: txHash === null ? null : text(txHash) })))
  return handlers
}

function newestFirst(rows: SqlRow[]): SqlRow[] {
  // Stable for equal timestamps: later inserts first.
  return rows.map((row, index) => ({ row, index })).sort((a, b) => b.row.createdAt.getTime() - a.row.createdAt.getTime() || b.index - a.index).map((entry) => entry.row)
}

function insertQuote(db: Db, table: "StocksQuote" | "StocksSellQuote", input: Record<string, unknown>): SqlResult {
  const now = db.now()
  const row = shape(table, { id: text(input.id), actorId: text(input.actorId), wallet: text(input.wallet), symbol: text(input.symbol), quantity: numeric(input.quantity), cashAmount: numeric(input.cash), deploymentDigest: text(input.digest), expiresAt: new Date(now.getTime() + 60_000), createdAt: now })
  check(row.symbol === "NVDA", table, "symbol_check")
  check(BigInt(row.quantity) > 0n && BigInt(row.cashAmount) > 0n, table, "amount_check")
  unique(db, table, row, ["id"], `${table}_pkey`)
  db.tables[table].push(row)
  return result([row])
}

function insertOrder(db: Db, table: "StocksOrder" | "StocksSellOrder", input: Record<string, unknown>): SqlResult {
  const now = db.now()
  const row = shape(table, {
    id: text(input.id), orderKey: text(input.orderKey), quoteId: text(input.quoteId), actorId: text(input.actorId), wallet: text(input.wallet), symbol: text(input.symbol),
    quantity: numeric(input.quantity), cashAmount: numeric(input.cash), idempotencyKey: text(input.key), deploymentId: text(input.deploymentId), deploymentDigest: text(input.digest),
    quoteExpiresAt: timestamp(input.expiresAt), state: table === "StocksOrder" ? "AWAITING_FUNDING" : "AWAITING_ESCROW", version: 0, createdAt: now, updatedAt: now,
  })
  check(row.symbol === "NVDA", table, "symbol_check")
  check(BigInt(row.quantity) > 0n && BigInt(row.cashAmount) > 0n, table, "amount_check")
  unique(db, table, row, ["id"], `${table}_pkey`)
  unique(db, table, row, ["orderKey"], `${table}_orderKey_key`)
  unique(db, table, row, ["quoteId"], `${table}_quoteId_key`)
  unique(db, table, row, ["actorId", "idempotencyKey"], `${table}_actorId_idempotencyKey_key`)
  const quotes = table === "StocksOrder" ? db.tables.StocksQuote : db.tables.StocksSellQuote
  if (!quotes.some((quote) => quote.id === row.quoteId)) throw pgError(`insert or update on table "${table}" violates foreign key constraint`, "23503")
  db.tables[table].push(row)
  return result([row])
}

function updateState(db: Db, table: "StocksOrder" | "StocksSellOrder", states: string[], [state, id, version, digest]: unknown[]): SqlResult {
  const index = db.tables[table].findIndex((row) => row.id === id && row.version === Number(version) && row.deploymentDigest === digest)
  if (index < 0) return command(0)
  const next = { ...db.tables[table][index]!, state: text(state), version: db.tables[table][index]!.version + 1, updatedAt: db.now() }
  check(states.includes(next.state), table, `${table}_state_check`)
  db.tables[table][index] = next
  return command(1)
}

function updateSubmission(db: Db, claimId: unknown, change: (row: SqlRow) => SqlRow): SqlResult {
  const rows = db.tables.StocksWalletSubmission
  const index = rows.findIndex((row) => row.claimId === claimId)
  if (index < 0) return result([])
  const old = rows[index]!
  const next = { ...change(old), updatedAt: db.now() }
  // BEFORE UPDATE trigger stocks_wallet_submission_guard, then table CHECK constraints.
  guardSubmissionUpdate(db, old, next)
  checkSubmission(next)
  rows[index] = next
  return result([next])
}

function emptyTables(): Tables {
  return Object.fromEntries(TABLE_NAMES.map((name) => [name, []])) as unknown as Tables
}

type Mutex = () => Promise<() => void>

function createMutex(): Mutex {
  let tail: Promise<void> = Promise.resolve()
  return () => {
    let unlock!: () => void
    const held = new Promise<void>((resolve) => { unlock = resolve })
    const acquired = tail.then(() => unlock)
    tail = tail.then(() => held)
    return acquired
  }
}

export type MemorySql = Readonly<{
  pool: MemorySqlPool
  /** Normalized text of every statement received, in order (including rejected ones). */
  readonly statements: readonly string[]
  /** Deep copy of the committed tables. Do not call while a transaction is open. */
  snapshot(): Tables
  /** Test seeding outside SQL: appends a row in column order after the same clock defaults. */
  seed(table: TableName, values: SqlRow): void
}>

const BEGIN = new Set(["BEGIN", "BEGIN ISOLATION LEVEL READ COMMITTED", "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY"])

export function createMemorySql(options: { clock?: () => number } = {}): MemorySql {
  const clock = options.clock ?? Date.now
  const handlers = createHandlers()
  const lock = createMutex()
  let tables = emptyTables()
  const statements: string[] = []
  const db: Db = { get tables() { return tables }, now: () => new Date(clock()) }

  type Transaction = { readOnly: boolean; aborted: boolean; snapshot: Tables; unlock: () => void }

  function handlerFor(sql: string): Handler {
    const handler = handlers.get(sql)
    if (!handler) throw new Error(`UNSUPPORTED_SQL: ${sql.slice(0, 100)}`)
    return handler
  }

  function execute(handler: Handler, params: unknown[], readOnly: boolean): SqlResult {
    if (handler.write && readOnly) throw pgError("cannot execute statement in a read-only transaction", "25006")
    return structuredClone(handler.run(db, params))
  }

  function createClient(): MemorySqlClient {
    let transaction: Transaction | null = null
    let released = false

    function end(restore: boolean) {
      const current = transaction!
      if (restore) tables = current.snapshot
      transaction = null
      current.unlock()
    }

    async function query(input: string, values: unknown[] = []): Promise<SqlResult> {
      if (released) throw new Error("MEMORY_SQL_CLIENT_RELEASED")
      const sql = normalizeSql(input)
      statements.push(sql)
      if (BEGIN.has(sql)) {
        if (transaction) throw pgError("there is already a transaction in progress", "25001")
        const unlock = await lock()
        transaction = { readOnly: sql.endsWith("READ ONLY"), aborted: false, snapshot: structuredClone(tables), unlock }
        return command(null)
      }
      if (sql === "COMMIT" || sql === "ROLLBACK") {
        // COMMIT of an aborted transaction rolls back, as in PostgreSQL.
        if (transaction) end(sql === "ROLLBACK" || transaction.aborted)
        return command(null)
      }
      if (transaction) {
        if (transaction.aborted) throw pgError("current transaction is aborted, commands ignored until end of transaction block", "25P02")
        try {
          return execute(handlerFor(sql), values, transaction.readOnly)
        } catch (error) {
          transaction.aborted = true
          throw error
        }
      }
      return autocommit(sql, values)
    }

    return {
      query,
      release() {
        if (released) return
        released = true
        if (transaction) end(true)
      },
    }
  }

  async function autocommit(sql: string, values: unknown[]): Promise<SqlResult> {
    const handler = handlerFor(sql)
    const unlock = await lock()
    const before = structuredClone(tables)
    try {
      return execute(handler, values, false)
    } catch (error) {
      tables = before
      throw error
    } finally {
      unlock()
    }
  }

  const pool: MemorySqlPool = {
    async query(input, values = []) {
      const sql = normalizeSql(input)
      statements.push(sql)
      if (BEGIN.has(sql) || sql === "COMMIT" || sql === "ROLLBACK") throw new Error(`UNSUPPORTED_SQL: ${sql.slice(0, 100)}`)
      return autocommit(sql, values)
    },
    async connect() {
      return createClient()
    },
  }

  return Object.freeze({
    pool,
    get statements() { return statements },
    snapshot: () => structuredClone(tables),
    seed(table: TableName, values: SqlRow) {
      const now = db.now()
      const defaults: SqlRow = COLUMNS[table].includes("createdAt" as never) ? { createdAt: now } : {}
      tables[table].push(shape(table, { ...defaults, ...values }))
    },
  })
}
