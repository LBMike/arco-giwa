import { enrollWalletSubmission } from '../stocks-submissions/enrollment.js';
import { recoverOrder } from './order-recovery.js';
import { StocksSellService, type EscrowReturnPolicy } from './sell-service.js';
import { randomUUID } from 'node:crypto';
import { address, ensure, immutable, liquidityScope, manifestDigest, operationKey, PROFILE, StocksError, units, validateActor, freezeManifest, type Activation, type Actor, type Manifest, type PausePolicy, type SqlClient } from './contracts.js';
import { authorizedCall, ReceiptVerifier } from './chain.js';
import { StocksRepository } from './repository.js';
import { buyCost, buyQuantity, feeBps, FIXED_PRICE, FIXED_PRICING, formatPriceUnits, type StocksPricing } from './pricing.js';
import { ACTIVITY_LIMIT, DIRECT_HOLDS, directActorId, directIdempotencyKey, directPrice, isDirectOrderKey, type DirectHold, type DirectOrderStatus, type StocksActivityEntry } from './direct.js';
import type { TradingLimitGate, TradingSide } from '../stocks-trading-limits/contracts.js';
import type { Hex } from 'viem';
export type RefundPolicy = (input: {
    fundingId: string;
    reason: string;
    payer: string;
    verifiedWallet: string;
    orderState: string;
}) => Promise<boolean>;
export class StocksService {
    readonly digest: string;
    readonly sell: StocksSellService;
    /** The last price a quote or the catalog read (the catalog shows it when a fresh read fails). */
    private lastPrice: bigint | null = null;
    /**
     * `directHalted` decides whether a direct payment or escrow is held instead of becoming an order: an explicit halt
     * (configured or operator pause, stopped runtime, changed cash identity). It defaults to `paused`. Transient states
     * that only delay dispatch (the observer catching up after a restart) must not hold a wallet's own payment: its order
     * is created and then waits for dispatch like any other.
     *
     * `limits` (STOCKS_TRADING_LIMITS=1) refuses new orders for a disabled side or past the side's daily cap, and holds a
     * direct payment or escrow instead of taking it as an order. Without it every side is open with no cap, as before.
     */
    constructor(readonly repo: StocksRepository, readonly manifest: Manifest, readonly verifier: ReceiptVerifier, private readonly activation?: Activation, readonly paused: PausePolicy = async () => true, private readonly refundPolicy: RefundPolicy = async () => false, returnPolicy?: EscrowReturnPolicy, readonly pricing: StocksPricing = FIXED_PRICING, readonly directHalted: PausePolicy = paused, readonly limits?: TradingLimitGate) {
        feeBps(pricing.mintFeeBps);
        feeBps(pricing.burnFeeBps);
        this.manifest = freezeManifest(manifest);
        this.digest = manifestDigest(this.manifest);
        if (activation)
            this.activation = Object.freeze(structuredClone(activation));
        ensure(repo.deploymentDigest === this.digest, 'REPOSITORY_DEPLOYMENT_MISMATCH');
        ensure(this.digest === manifestDigest(verifier.manifest), 'VERIFIER_DEPLOYMENT_MISMATCH');
        this.sell = new StocksSellService(this, returnPolicy);
    }
    requireActivation(): void { ensure(this.activation?.manifestDigest === this.digest && this.activation.contractPolicyVerified === true, 'STOCKS_NOT_ACTIVATED', 503); }
    async bindDeployment(): Promise<void> {
        this.requireActivation();
        const scope = liquidityScope(this.manifest);
        await this.repo.pool.query('INSERT INTO arco_evm."StocksLiquidityBinding" ("scopeKey","deploymentDigest") VALUES($1,$2) ON CONFLICT DO NOTHING', [scope, this.digest]);
        const binding = (await this.repo.pool.query('SELECT "deploymentDigest" FROM arco_evm."StocksLiquidityBinding" WHERE "scopeKey"=$1', [scope])).rows[0];
        ensure(binding?.deploymentDigest === this.digest, 'VAULT_ALREADY_BOUND_TO_OTHER_DEPLOYMENT', 503);
    }
    async ready(): Promise<void> { await this.bindDeployment(); ensure(this.activation?.manifestDigest === this.digest && this.activation.contractPolicyVerified === true, 'STOCKS_NOT_ACTIVATED', 503); ensure(!(await this.paused()), 'STOCKS_PAUSED', 503); }
    /**
     * A trading limit refuses a new order with 409 SIDE_DISABLED or DAILY_LIMIT_REACHED. With `db` (inside the transaction
     * that creates the order) the check is serialized per (symbol, side); without it, before a quote, it is a hint.
     */
    async requireLimit(symbol: string, side: TradingSide, cash: bigint, db?: SqlClient): Promise<void> {
        if (!this.limits)
            return;
        const block = db ? await this.limits.admit(db, symbol, side, cash) : await this.limits.check(symbol, side, cash);
        if (block)
            throw new StocksError(block, 409);
    }
    /** The price a quote uses now. The profile's priceSource name stays FIXED_MOCK_PRICE: each quote fixes its price. */
    async currentPrice(): Promise<bigint> { const price = await this.pricing.price(); this.lastPrice = price; return price; }
    /** The catalog route: the current price when it can be read, otherwise the last one seen. Quotes always need a current one. */
    async currentCatalog() {
        try { await this.currentPrice(); }
        catch (error) { if (this.lastPrice === null) throw error; }
        return this.catalog();
    }
    /**
     * Public: whether a new order of `side` for `cashAmount` cash base units (default: the smallest amount) would be taken
     * now. A direct Buy or Sell asks before the wallet sends anything, because the server cannot refuse a transaction
     * that is already on GIWA, only hold it. The answer is a hint: the order itself (or the observed payment) decides.
     */
    async tradingAvailability(side: unknown, cashAmount: unknown) {
        ensure(side === 'BUY' || side === 'SELL', 'INVALID_SIDE', 400);
        ensure(cashAmount === undefined || (typeof cashAmount === 'string' && /^[1-9]\d{0,30}$/.test(cashAmount) && BigInt(cashAmount) <= 10n ** 30n), 'INVALID_CASH_AMOUNT', 400);
        const cash = cashAmount === undefined ? 1n : BigInt(cashAmount);
        const block = (await this.directHalted()) ? 'TRADING_PAUSED' : this.limits ? await this.limits.check('NVDA', side, cash) : null;
        return { symbol: 'NVDA', side, accepts: block === null, block };
    }
    /**
     * Public. `tokenAddress` is the verified NVDA token, so a wallet's balance can be read on GIWA without signing in;
     * `contracts` are the verified deployment's addresses a direct Buy or Sell is sent to (see direct.ts).
     */
    catalog() { return { ...PROFILE, instruments: [{ symbol: 'NVDA', quantityScale: 9, price: formatPriceUnits(this.lastPrice ?? FIXED_PRICE), priceSource: 'FIXED_MOCK_PRICE', orderCapability: this.activation?.manifestDigest === this.digest ? 'CHECK_PAUSE_AT_ORDER' : 'NOT_ACTIVATED', tokenAddress: this.manifest.stockToken.toLowerCase() }], contracts: { cashToken: this.manifest.cashToken.toLowerCase(), fundingVault: this.manifest.fundingVault.toLowerCase(), stockToken: this.manifest.stockToken.toLowerCase(), redemptionEscrow: this.manifest.redemptionEscrow.toLowerCase() }, cashSymbol: this.manifest.cashSymbol, deploymentId: this.manifest.deploymentId, observedAt: new Date().toISOString() }; }
    async quote(actor: Actor, symbol: string, quantity: unknown) {
        actor = immutable(actor);
        validateActor(actor);
        await this.ready();
        ensure(symbol === 'NVDA', 'UNSUPPORTED_SYMBOL');
        const value = units(quantity, 9);
        const cash = buyCost(value, await this.currentPrice(), this.pricing.mintFeeBps);
        await this.requireLimit(symbol, 'BUY', cash);
        return this.insertQuote(actor, symbol, value, cash);
    }
    /** A Buy for an exact tUSDC amount: the NVDA it buys at the current price, less the mint fee, rounded down. */
    async quoteForCash(actor: Actor, symbol: string, cashAmount: unknown) {
        actor = immutable(actor);
        validateActor(actor);
        await this.ready();
        ensure(symbol === 'NVDA', 'UNSUPPORTED_SYMBOL');
        const cash = units(cashAmount, 6);
        const value = buyQuantity(cash, await this.currentPrice(), this.pricing.mintFeeBps);
        ensure(value > 0n, 'QUOTE_TOO_SMALL');
        await this.requireLimit(symbol, 'BUY', cash);
        return this.insertQuote(actor, symbol, value, cash);
    }
    private insertQuote(actor: Actor, symbol: string, value: bigint, cash: bigint) {
        const id = randomUUID();
        return this.repo.tx(async (db) => {
            const row = (await db.query('INSERT INTO arco_evm."StocksQuote" (id,"actorId",wallet,symbol,quantity,"cashAmount","deploymentDigest","expiresAt") VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval \'60 seconds\') RETURNING *', [id, actor.actorId, address(actor.wallet), symbol, value.toString(), cash.toString(), this.digest])).rows[0];
            await this.repo.audit(db, id, 'QUOTE_CREATED', { actorId: actor.actorId });
            return row;
        });
    }
    async createOrder(actor: Actor, quoteId: string, idempotencyKey: string) {
        actor = immutable(actor);
        validateActor(actor);
        await this.ready();
        ensure(typeof quoteId === 'string' && quoteId.length <= 128 && typeof idempotencyKey === 'string' && /^[a-zA-Z0-9:_-]{8,128}$/.test(idempotencyKey), 'INVALID_ORDER_REQUEST');
        return this.repo.tx(async (db) => {
            // Serialize the actor/key before checking for an existing row; a unique constraint is the backstop.
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`stocks:${actor.actorId}:${idempotencyKey}`]);
            const existing = (await db.query('SELECT * FROM arco_evm."StocksOrder" WHERE "actorId"=$1 AND "idempotencyKey"=$2', [actor.actorId, idempotencyKey])).rows[0];
            if (existing) {
                ensure(existing.quoteId === quoteId && existing.wallet === address(actor.wallet) && existing.deploymentDigest === this.digest, 'IDEMPOTENCY_CONFLICT', 409);
                return existing;
            }
            const q = (await db.query('SELECT *, "expiresAt">clock_timestamp() AS valid FROM arco_evm."StocksQuote" WHERE id=$1 FOR UPDATE', [quoteId])).rows[0];
            ensure(q && q.actorId === actor.actorId && q.wallet === address(actor.wallet), 'QUOTE_NOT_FOUND', 404);
            ensure(q.deploymentDigest === this.digest && q.valid, 'QUOTE_EXPIRED_OR_DEPLOYMENT_CHANGED', 409);
            const used = (await db.query('SELECT id FROM arco_evm."StocksOrder" WHERE "quoteId"=$1', [quoteId])).rows[0];
            ensure(!used, 'QUOTE_ALREADY_USED', 409);
            await this.requireLimit(q.symbol, 'BUY', BigInt(q.cashAmount), db);
            const id = randomUUID();
            const row = (await db.query('INSERT INTO arco_evm."StocksOrder" (id,"orderKey","quoteId","actorId",wallet,symbol,quantity,"cashAmount","idempotencyKey","deploymentId","deploymentDigest","quoteExpiresAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *', [id, operationKey(`${this.manifest.networkInstance}:${id}`), q.id, q.actorId, q.wallet, q.symbol, q.quantity, q.cashAmount, idempotencyKey, this.manifest.deploymentId, this.digest, q.expiresAt])).rows[0];
            await enrollWalletSubmission(db, this.manifest, row, 'BUY');
            await this.repo.audit(db, id, 'ORDER_CREATED', { actorId: actor.actorId, deploymentDigest: this.digest });
            return row;
        });
    }
    recoverOrder(actor: Actor, quoteId: string, key: string) { return recoverOrder(this.repo, actor, 'BUY', quoteId, key); }
    // Internal indexer boundary only. A hash causes a fresh trusted RPC read; clients cannot submit proof envelopes.
    async observeFunding(txHash: Hex) {
        await this.bindDeployment();
        ensure(this.activation?.manifestDigest === this.digest, 'STOCKS_NOT_ACTIVATED', 503);
        const proof = await this.verifier.fetch(txHash);
        if (!proof)
            return { status: 'FINALITY_PENDING' };
        const evidenceDigest = operationKey(JSON.stringify({ receipt: proof.receipt, tx: proof.tx }));
        if (!proof.events.some(e => e.name === 'FundingReceived')) {
            const incoming = this.verifier.unallocated(proof);
            return this.repo.tx(async (db) => {
                const recorded = [];
                for (const item of incoming.sort((a, b) => a.eventId.localeCompare(b.eventId))) {
                    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [item.eventId]);
                    const existing = (await db.query('SELECT * FROM arco_evm."StocksFunding" WHERE id=$1', [item.eventId])).rows[0];
                    if (existing) {
                        recorded.push(existing.proof.evidenceDigest === evidenceDigest ? existing : await this.fundingConflict(db, existing, evidenceDigest));
                        continue;
                    }
                    const row = (await db.query(`INSERT INTO arco_evm."StocksFunding" (id,payer,amount,status,reason,"txHash",proof,"deploymentDigest") VALUES ($1,$2,$3,'SUSPENSE','UNATTRIBUTED_TRANSFER',$4,$5,$6) RETURNING *`, [item.eventId, item.payer, item.amount, txHash, JSON.stringify({ blockHash: proof.block.hash, blockNumber: proof.block.number, evidenceDigest, deploymentDigest: this.digest }), this.digest])).rows[0];
                    await this.repo.journal(db, `funding:${item.eventId}`, this.manifest.cashToken, 'CASH_VAULT', `SUSPENSE:${item.eventId}`, item.amount, proof.block.number);
                    await this.repo.audit(db, item.eventId, 'UNALLOCATED_FUNDING_RECORDED', { txHash });
                    recorded.push(row);
                }
                return recorded;
            });
        }
        const funding = this.verifier.funding(proof);
        // A direct Buy: the deposit is the order. It is priced here, before the transaction, at the live price.
        const direct = await this.directBuy(funding);
        return this.repo.tx(async (db) => {
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [funding.eventId]);
            const duplicate = (await db.query('SELECT * FROM arco_evm."StocksFunding" WHERE id=$1', [funding.eventId])).rows[0];
            if (duplicate)
                return duplicate.proof.evidenceDigest === evidenceDigest ? duplicate : this.fundingConflict(db, duplicate, evidenceDigest);
            let order = (await db.query('SELECT * FROM arco_evm."StocksOrder" WHERE "orderKey"=$1 FOR UPDATE', [funding.orderKey])).rows[0];
            // A direct Buy past a trading limit is held like a paused one: the chain has already moved the payment.
            const limited = !order && direct && 'quantity' in direct && this.limits ? await this.limits.admit(db, 'NVDA', 'BUY', BigInt(funding.amount)) : null;
            if (!order && direct && 'quantity' in direct && !limited)
                order = await this.insertDirectBuy(db, funding, direct.quantity, direct.price);
            else if (!order && isDirectOrderKey(funding.orderKey))
                await this.repo.audit(db, funding.orderKey, 'DIRECT_ORDER_NOT_CREATED', { side: 'BUY', fundingId: funding.eventId, txHash, amount: funding.amount, hold: limited ?? (direct && 'hold' in direct ? direct.hold : null) });
            let reason = 'UNIDENTIFIED_ORDER';
            if (order) {
                if (order.deploymentDigest !== this.digest)
                    reason = 'DEPLOYMENT_MISMATCH';
                else if (order.wallet !== funding.payer)
                    reason = 'WRONG_WALLET';
                else if (order.state !== 'AWAITING_FUNDING')
                    reason = 'SECOND_PAYMENT';
                else if (BigInt(funding.blockTimestamp) * 1000n > BigInt(new Date(order.quoteExpiresAt).getTime()))
                    reason = 'QUOTE_EXPIRED';
                else if (order.cashAmount !== funding.amount)
                    reason = 'AMOUNT_MISMATCH';
                else
                    reason = 'EXACT_PAYMENT';
            }
            const accepted = reason === 'EXACT_PAYMENT';
            const row = (await db.query('INSERT INTO arco_evm."StocksFunding" (id,"orderId",payer,amount,status,reason,"txHash",proof,"deploymentDigest") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [funding.eventId, order?.id ?? null, funding.payer, funding.amount, accepted ? 'ACCEPTED' : 'SUSPENSE', reason, txHash, JSON.stringify({ blockHash: proof.block.hash, blockNumber: proof.block.number, evidenceDigest, deploymentDigest: this.digest, orderKey: funding.orderKey }), this.digest])).rows[0];
            await this.repo.journal(db, `funding:${funding.eventId}`, this.manifest.cashToken, 'CASH_VAULT', accepted ? `ORDER_RESERVED:${order.id}` : `SUSPENSE:${funding.eventId}`, funding.amount, proof.block.number);
            await this.repo.audit(db, order?.id ?? funding.eventId, 'FUNDING_RECORDED', { fundingId: funding.eventId, reason });
            if (order && order.state === 'AWAITING_FUNDING' && order.wallet === funding.payer && order.deploymentDigest === this.digest) {
                await this.repo.state(db, order, accepted ? 'BROKER_PENDING' : reason === 'QUOTE_EXPIRED' ? 'FUNDED_QUOTE_EXPIRED' : 'FUNDING_REVIEW_REQUIRED');
                if (accepted)
                    await this.repo.enqueue(db, `broker:${order.id}`, order.id, 'BROKER', { operationId: `broker:${order.id}`, orderId: order.id, symbol: 'NVDA', quantity: order.quantity, cashAmount: order.cashAmount });
            }
            return row;
        });
    }
    /**
     * A direct Buy's NVDA at the live price; a hold when it cannot be taken as an order (trading paused, no price for
     * DIRECT_PRICE_WAIT_SECONDS, less than one base unit); null when it is not a direct key or was already recorded.
     * A failed price read on a recent deposit throws, so the observer reads the deposit again.
     */
    private async directBuy(funding: { orderKey: string; eventId: string; amount: string; blockTimestamp: string }): Promise<{ quantity: bigint; price: bigint } | { hold: DirectHold } | null> {
        if (!isDirectOrderKey(funding.orderKey))
            return null;
        const known = await this.repo.pool.query('SELECT 1 FROM arco_evm."StocksOrder" WHERE "orderKey"=$1 UNION ALL SELECT 1 FROM arco_evm."StocksFunding" WHERE id=$2', [funding.orderKey, funding.eventId]);
        if (known.rows.length)
            return null;
        if (await this.directHalted())
            return { hold: 'TRADING_PAUSED' };
        const price = await directPrice(() => this.currentPrice(), funding.blockTimestamp);
        if (price === null)
            return { hold: 'PRICE_UNAVAILABLE' };
        const quantity = buyQuantity(BigInt(funding.amount), price, this.pricing.mintFeeBps);
        return quantity > 0n ? { quantity, price } : { hold: 'BELOW_ONE_UNIT' };
    }
    /** The quote and order a direct Buy stands for, created with its funding, in its transaction. No wallet submission. */
    private async insertDirectBuy(db: SqlClient, funding: { orderKey: string; payer: string; amount: string }, quantity: bigint, price: bigint) {
        const actorId = directActorId(funding.payer);
        const quote = (await db.query('INSERT INTO arco_evm."StocksQuote" (id,"actorId",wallet,symbol,quantity,"cashAmount","deploymentDigest","expiresAt") VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval \'60 seconds\') RETURNING *', [randomUUID(), actorId, address(funding.payer), 'NVDA', quantity.toString(), funding.amount, this.digest])).rows[0];
        const id = randomUUID();
        const order = (await db.query('INSERT INTO arco_evm."StocksOrder" (id,"orderKey","quoteId","actorId",wallet,symbol,quantity,"cashAmount","idempotencyKey","deploymentId","deploymentDigest","quoteExpiresAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *', [id, funding.orderKey, quote.id, actorId, quote.wallet, quote.symbol, quote.quantity, quote.cashAmount, directIdempotencyKey(funding.orderKey), this.manifest.deploymentId, this.digest, quote.expiresAt])).rows[0];
        await this.repo.audit(db, id, 'DIRECT_ORDER_CREATED', { side: 'BUY', orderKey: funding.orderKey, price: formatPriceUnits(price) });
        return order;
    }
    /** Public: a direct order's progress by its key (the key is the browser's own random value). */
    async directOrder(orderKey: unknown): Promise<DirectOrderStatus> {
        ensure(isDirectOrderKey(orderKey), 'INVALID_DIRECT_ORDER_KEY', 400);
        const fields = 'state,quantity::text AS quantity,"cashAmount"::text AS "cashAmount","createdAt","updatedAt"';
        const buy = (await this.repo.pool.query(`SELECT ${fields} FROM arco_evm."StocksOrder" WHERE "orderKey"=$1 AND "deploymentDigest"=$2`, [orderKey, this.digest])).rows[0];
        const sell = buy ? undefined : (await this.repo.pool.query(`SELECT ${fields} FROM arco_evm."StocksSellOrder" WHERE "orderKey"=$1 AND "deploymentDigest"=$2`, [orderKey, this.digest])).rows[0];
        const row = buy ?? sell;
        const time = (value: unknown) => new Date(value as string).toISOString();
        if (!row) {
            // Observed but not taken as an order (see DirectHold): the payment or escrow waits for review.
            const held = (await this.repo.pool.query('SELECT detail,"createdAt" FROM arco_evm."StocksAudit" WHERE subject=$1 AND action=\'DIRECT_ORDER_NOT_CREATED\' AND "deploymentDigest"=$2 ORDER BY "createdAt" LIMIT 1', [orderKey, this.digest])).rows[0];
            ensure(held, 'DIRECT_ORDER_NOT_FOUND', 404);
            const escrow = held.detail?.side === 'SELL';
            const hold = DIRECT_HOLDS.includes(held.detail?.hold) ? held.detail.hold as DirectHold : undefined;
            return { side: escrow ? 'SELL' : 'BUY', state: escrow ? 'ESCROW_REVIEW_REQUIRED' : 'FUNDING_REVIEW_REQUIRED', quantity: escrow ? String(held.detail?.quantity ?? '0') : '0', cashAmount: escrow ? '0' : String(held.detail?.amount ?? '0'), createdAt: time(held.createdAt), updatedAt: time(held.createdAt), ...(hold ? { hold } : {}) };
        }
        return { side: buy ? 'BUY' : 'SELL', state: row.state, quantity: row.quantity, cashAmount: row.cashAmount, createdAt: time(row.createdAt), updatedAt: time(row.updatedAt) };
    }
    /**
     * Public, like a wallet's product activity: the Stocks trades this wallet paid for or escrowed NVDA into, and its
     * payments or escrows held without an order, newest first. Orders never funded or escrowed are not activity. Every
     * fact here (amounts, transactions) is already public on GIWA.
     */
    async walletActivity(wallet: unknown): Promise<StocksActivityEntry[]> {
        ensure(typeof wallet === 'string' && /^0x[0-9a-fA-F]{40}$/.test(wallet), 'INVALID_WALLET', 400);
        const owner = wallet.toLowerCase();
        const q = (text: string) => this.repo.pool.query(text, [owner, this.digest, ACTIVITY_LIMIT]);
        const settled = (column: string, kinds: string) => `(SELECT x."txHash" FROM arco_evm."StocksOutbox" x WHERE x."${column}"=o.id AND x."deploymentDigest"=$2 AND x.kind IN (${kinds}) AND x.status='DONE' AND x."txHash" IS NOT NULL ORDER BY x."createdAt" DESC, x.id LIMIT 1) AS "settlementTx"`;
        const [buys, sells, cash, stock] = await Promise.all([
            q(`SELECT o.state, o.quantity::text AS quantity, o."cashAmount"::text AS "cashAmount", p."txHash" AS "paymentTx", p."createdAt", ${settled('orderId', "'MINT','REFUND'")}
               FROM arco_evm."StocksOrder" o JOIN LATERAL (SELECT f."txHash", f."createdAt" FROM arco_evm."StocksFunding" f WHERE f."orderId"=o.id AND f."deploymentDigest"=$2 ORDER BY f."createdAt", f.id LIMIT 1) p ON true
               WHERE o.wallet=$1 AND o."deploymentDigest"=$2 ORDER BY p."createdAt" DESC LIMIT $3`),
            q(`SELECT o.state, o.quantity::text AS quantity, o."cashAmount"::text AS "cashAmount", p."txHash" AS "paymentTx", p."createdAt", ${settled('sellOrderId', "'REDEEM','RETURN'")}
               FROM arco_evm."StocksSellOrder" o JOIN LATERAL (SELECT c."txHash", c."createdAt" FROM arco_evm."StocksCustody" c WHERE c."orderId"=o.id AND c."deploymentDigest"=$2 ORDER BY c."createdAt", c.id LIMIT 1) p ON true
               WHERE o.wallet=$1 AND o."deploymentDigest"=$2 ORDER BY p."createdAt" DESC LIMIT $3`),
            q(`SELECT amount::text AS "cashAmount", "txHash" AS "paymentTx", "createdAt" FROM arco_evm."StocksFunding" WHERE payer=$1 AND "deploymentDigest"=$2 AND "orderId" IS NULL ORDER BY "createdAt" DESC LIMIT $3`),
            q(`SELECT quantity::text AS quantity, "txHash" AS "paymentTx", "createdAt" FROM arco_evm."StocksCustody" WHERE payer=$1 AND "deploymentDigest"=$2 AND "orderId" IS NULL ORDER BY "createdAt" DESC LIMIT $3`),
        ]);
        const time = (value: unknown) => new Date(value as string).toISOString();
        const entries: StocksActivityEntry[] = [
            ...buys.rows.map((r): StocksActivityEntry => ({ side: 'BUY', state: r.state, quantity: r.quantity, cashAmount: r.cashAmount, paymentTx: r.paymentTx, settlementTx: r.settlementTx ?? null, createdAt: time(r.createdAt) })),
            ...sells.rows.map((r): StocksActivityEntry => ({ side: 'SELL', state: r.state, quantity: r.quantity, cashAmount: r.cashAmount, paymentTx: r.paymentTx, settlementTx: r.settlementTx ?? null, createdAt: time(r.createdAt) })),
            // Held without an order (a direct payment taken for review, an unknown key, a plain transfer to the vault).
            ...cash.rows.map((r): StocksActivityEntry => ({ side: 'BUY', state: 'FUNDING_REVIEW_REQUIRED', quantity: '0', cashAmount: r.cashAmount, paymentTx: r.paymentTx, settlementTx: null, createdAt: time(r.createdAt) })),
            ...stock.rows.map((r): StocksActivityEntry => ({ side: 'SELL', state: 'ESCROW_REVIEW_REQUIRED', quantity: r.quantity, cashAmount: '0', paymentTx: r.paymentTx, settlementTx: null, createdAt: time(r.createdAt) })),
        ];
        return entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).slice(0, ACTIVITY_LIMIT);
    }
    private async fundingConflict(db: SqlClient, previous: Record<string, any>, evidenceDigest: string) {
        await this.repo.audit(db, previous.orderId ?? previous.id, 'FUNDING_EVIDENCE_CONFLICT', { fundingId: previous.id, originalEvidenceDigest: previous.proof.evidenceDigest, conflictingEvidenceDigest: evidenceDigest });
        if (previous.orderId && previous.deploymentDigest === this.digest) {
            const order = await this.repo.order(db, previous.orderId);
            if (!['COMPLETED', 'REFUNDED', 'REVIEW_REQUIRED'].includes(order.state))
                await this.repo.state(db, order, 'REVIEW_REQUIRED');
            await db.query(`UPDATE arco_evm."StocksOutbox" SET status='REVIEW',"leaseId"=NULL,"leaseUntil"=NULL WHERE "orderId"=$1 AND "deploymentDigest"=$2 AND status NOT IN ('DONE','REVIEW')`, [order.id, this.digest]);
        }
        return { ...previous, conflict: 'REVIEW_REQUIRED' };
    }
    async requestRefund(fundingId: string): Promise<{
        operationId: string;
    }> {
        await this.ready();
        // Read the immutable funding fact and ask a trusted policy outside the transaction.
        const row = (await this.repo.pool.query('SELECT f.*,o.wallet,o.state AS "orderState" FROM arco_evm."StocksFunding" f JOIN arco_evm."StocksOrder" o ON o.id=f."orderId" WHERE f.id=$1 AND f."deploymentDigest"=$2', [fundingId, this.digest])).rows[0];
        ensure(row && row.payer === row.wallet && row.reason !== 'EXACT_PAYMENT' && row.reason !== 'DEPLOYMENT_MISMATCH', 'REFUND_INELIGIBLE', 409);
        ensure(await this.refundPolicy({ fundingId, reason: row.reason, payer: row.payer, verifiedWallet: row.wallet, orderState: row.orderState }), 'REFUND_POLICY_DENIED', 403);
        return this.repo.tx(async (db) => {
            const current = (await db.query('SELECT * FROM arco_evm."StocksFunding" WHERE id=$1 FOR UPDATE', [fundingId])).rows[0];
            const operationId = `refund:${fundingId}`;
            if (['REFUND_PENDING', 'REFUNDED'].includes(current.status))
                return { operationId };
            ensure(current.status === 'SUSPENSE', 'REFUND_INELIGIBLE', 409);
            const call = authorizedCall(this.manifest, operationId, 'REFUND', current.payer, current.amount);
            await this.repo.enqueue(db, operationId, current.orderId, 'REFUND', { call, wallet: current.payer, amount: current.amount, fundingId });
            await db.query('UPDATE arco_evm."StocksFunding" SET status=\'REFUND_PENDING\' WHERE id=$1', [fundingId]);
            await this.repo.audit(db, current.orderId, 'REFUND_INTENT_CREATED', { fundingId, operationId });
            return { operationId };
        });
    }
}
