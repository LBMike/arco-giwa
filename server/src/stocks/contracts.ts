import { createHash } from 'node:crypto';
import { isAddress, type Address, type Hex, parseAbi } from 'viem';
export const PROFILE = Object.freeze({ profile: 'DEMO_TESTNET', valuePolicy: 'TEST_VALUE_ONLY', brokerMode: 'MOCK_BROKER', chainId: 91342, priceSource: 'FIXED_MOCK_PRICE' });
export const ABI = parseAbi([
    'function depositForOrder(bytes32 orderKey,uint256 amount)',
    'function mintForOperation(bytes32 operationId,address token,address recipient,uint256 quantity)',
    'function refundForOperation(bytes32 operationId,address recipient,uint256 amount)',
    'event FundingReceived(bytes32 indexed orderKey,address indexed payer,address token,uint256 amount)',
    'event StockMinted(bytes32 indexed operationId,address indexed token,address recipient,uint256 quantity)',
    'event FundingRefunded(bytes32 indexed operationId,address indexed recipient,uint256 amount)',
    'function escrowForOrder(bytes32 orderKey,address token,uint256 quantity)',
    'function settleRedemption(bytes32 operationId,bytes32 escrowId,uint256 cashAmount)',
    'function returnEscrowForOperation(bytes32 operationId,bytes32 escrowId)',
    'event StockEscrowed(bytes32 indexed escrowId,bytes32 indexed orderKey,address indexed payer,address token,uint256 quantity)',
    'event StockRedeemed(bytes32 indexed operationId,bytes32 indexed escrowId,address indexed recipient,address token,uint256 quantity,address cashToken,uint256 cashAmount)',
    'event StockReturned(bytes32 indexed operationId,bytes32 indexed escrowId,address indexed recipient,address token,uint256 quantity)',
    'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
export const ABI_DIGEST = createHash('sha256').update(JSON.stringify(ABI)).digest('hex');
export class StocksError extends Error {
    constructor(public code: string, public status = 400) { super(code); }
}
export function ensure(condition: unknown, code: string, status = 400): asserts condition {
    if (!condition)
        throw new StocksError(code, status);
}
export function units(value: unknown, scale: number): bigint {
    ensure(typeof value === 'string' && /^(0|[1-9]\d*)(\.\d+)?$/.test(value) && value.length <= 80, 'INVALID_DECIMAL');
    const [whole, fraction = ''] = value.split('.');
    ensure(fraction.length <= scale, 'EXCESS_PRECISION');
    const result = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
    ensure(result > 0n && result <= 10n ** 30n, 'AMOUNT_BOUNDS');
    return result;
}
export function amount(value: string): bigint { ensure(typeof value === 'string' && /^[1-9]\d{0,35}$/.test(value), 'INVALID_BASE_AMOUNT'); return BigInt(value); }
export function operationKey(value: string): Hex { return `0x${createHash('sha256').update(value).digest('hex')}`; }
export function address(value: string): Address { ensure(isAddress(value) && !/^0x0{40}$/i.test(value), 'INVALID_ADDRESS'); return value.toLowerCase() as Address; }
export function hash(value: string): Hex { ensure(/^0x[0-9a-f]{64}$/.test(value) && !/^0x0{64}$/.test(value), 'INVALID_HASH'); return value as Hex; }
export type Manifest = {
    schemaVersion: 2;
    redemptionEscrow: Address;
    deploymentId: string;
    profile: 'DEMO_TESTNET';
    chainId: 91342;
    networkInstance: string;
    checkpointNumber: string;
    checkpointHash: Hex;
    abiDigest: string;
    finalityPolicy: 'FINALIZED';
    cashToken: Address;
    cashSymbol: 'ARCO_TEST_USDC' | 'ARCO_TEST_RLUSD';
    cashScale: 6;
    stockToken: Address;
    quantityScale: 9;
    fundingVault: Address;
    mintController: Address;
    signerAddress: Address;
    codeHashes: Record<string, Hex>;
    restrictedTransfers: true;
    nonUpgradeable: true;
};
// An alias/checkpoint rollover must never split one physical cash pool into new ledgers.
// Reusing addresses after a chain reset also fails closed until a reviewed migration.
export function liquidityScope(manifest: Manifest): string {
    return `cash:${manifest.chainId}:${address(manifest.fundingVault)}:${address(manifest.cashToken)}`;
}
export function immutable<T>(input: T): T {
    const value = structuredClone(input);
    const freeze = (node: unknown): void => {
        if (node && typeof node === 'object') {
            for (const child of Object.values(node))
                freeze(child);
            Object.freeze(node);
        }
    };
    freeze(value);
    return value;
}
export function freezeManifest(input: Manifest): Manifest {
    const copy = structuredClone(input);
    validateManifest(copy);
    Object.freeze(copy.codeHashes);
    return Object.freeze(copy);
}
export function canonicalJson(value: unknown): string {
    const ordered = (input: unknown): unknown => {
        if (Array.isArray(input))
            return input.map(ordered);
        if (input !== null && typeof input === 'object')
            // Preserve historical en-US hashes independently of the host's default locale.
            return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b, 'en-US')).map(([key, child]) => [key, ordered(child)]));
        return input;
    };
    return JSON.stringify(ordered(value));
}
export function manifestDigest(manifest: Manifest): string { return createHash('sha256').update(canonicalJson(manifest)).digest('hex'); }
export function validateManifest(m: Manifest): void {
    ensure(m?.schemaVersion === 2 && m.profile === 'DEMO_TESTNET' && m.chainId === 91342 && m.cashScale === 6 && m.quantityScale === 9, 'INVALID_PROFILE');
    ensure(m.abiDigest === ABI_DIGEST && m.finalityPolicy === 'FINALIZED' && m.restrictedTransfers === true && m.nonUpgradeable === true, 'UNSUPPORTED_DEPLOYMENT');
    ensure(/^[a-zA-Z0-9:_-]{8,128}$/.test(m.deploymentId) && /^[a-zA-Z0-9:_-]{8,128}$/.test(m.networkInstance), 'INVALID_DEPLOYMENT_ID');
    ensure(/^\d+$/.test(m.checkpointNumber), 'INVALID_CHECKPOINT');
    hash(m.checkpointHash);
    ensure(['ARCO_TEST_USDC', 'ARCO_TEST_RLUSD'].includes(m.cashSymbol), 'INVALID_CASH');
    const contracts = [m.cashToken, m.stockToken, m.fundingVault, m.mintController, m.redemptionEscrow].map(address);
    ensure(new Set(contracts).size === contracts.length, 'OVERLAPPING_CONTRACTS');
    address(m.signerAddress);
    for (const a of contracts)
        hash(m.codeHashes[a] ?? '');
}
export type Actor = {
    actorId: string;
    wallet: Address;
    chainId: 91342;
    scope: 'STOCKS_TESTNET';
    verified: true;
};
export function validateActor(a: Actor): void { ensure(a?.verified === true && a.chainId === 91342 && a.scope === 'STOCKS_TESTNET' && typeof a.actorId === 'string' && a.actorId.length > 0 && a.actorId.length <= 128, 'UNAUTHORIZED', 401); address(a.wallet); }
export type Operator = {
    operatorId: string;
    permissions: readonly string[];
};
export type Activation = {
    manifestDigest: string;
    contractPolicyVerified: true;
};
export type PausePolicy = () => Promise<boolean>;
export type SqlResult = {
    rows: Record<string, any>[];
    rowCount: number | null;
};
export type SqlClient = {
    query(text: string, values?: unknown[]): Promise<SqlResult>;
    release(): void;
};
export type SqlPool = {
    connect(): Promise<SqlClient>;
    query(text: string, values?: unknown[]): Promise<SqlResult>;
};
export type OrderState = 'AWAITING_FUNDING' | 'FUNDED_QUOTE_EXPIRED' | 'FUNDING_REVIEW_REQUIRED' | 'BROKER_PENDING' | 'BROKER_UNKNOWN' | 'MINT_QUEUED' | 'MINT_SUBMITTED' | 'MINT_FINALITY_PENDING' | 'MINT_UNKNOWN' | 'COMPLETED' | 'REFUNDED' | 'REVIEW_REQUIRED';
export type BrokerRequest = {
    side?: 'BUY' | 'SELL';
    operationId: string;
    orderId: string;
    symbol: 'NVDA';
    quantity: string;
    cashAmount: string;
};
export type BrokerResult = {
    operationId: string;
    outcome: 'FILLED' | 'PARTIAL' | 'REJECTED' | 'UNKNOWN';
    quantity: string;
    cashAmount: string;
    mode: 'MOCK_BROKER';
};
export type BrokerPort = {
    submit(request: BrokerRequest): Promise<BrokerResult>;
    lookup(operationId: string): Promise<BrokerResult | null>;
};
export type AuthorizedCall = {
    operationId: string;
    chainId: 91342;
    networkInstance: string;
    deploymentId: string;
    from: Address;
    to: Address;
    data: Hex;
    value: '0';
};
export type Submission = {
    operationId: string;
    txHash: Hex;
    callDigest: string;
};
export type SignerPort = {
    submit(call: AuthorizedCall): Promise<Submission>;
    lookup(operationId: string): Promise<Submission | null>;
};
export function callDigest(call: AuthorizedCall): string { return createHash('sha256').update(canonicalJson(call)).digest('hex'); }
