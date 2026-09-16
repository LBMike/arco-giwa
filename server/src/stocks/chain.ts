import { decodeEventLog, encodeFunctionData, toEventSelector, zeroAddress, type Address, type Hex } from 'viem';
import { ABI, amount, address, ensure, hash, operationKey, freezeManifest, StocksError, type AuthorizedCall, type Manifest } from './contracts.js';
export type RawLog = {
    address: Address;
    topics: [
        Hex,
        ...Hex[]
    ];
    data: Hex;
    logIndex: number;
    removed: boolean;
};
export type ChainReceipt = {
    transactionHash: Hex;
    blockNumber: string;
    blockHash: Hex;
    status: 'success' | 'reverted';
    logs: RawLog[];
};
export type ChainTransaction = {
    hash: Hex;
    from: Address;
    to: Address;
    input: Hex;
    value: string;
};
export type ChainBlock = {
    number: string;
    hash: Hex;
    timestamp: string;
};
export type ChainPort = {
    network(): Promise<{
        chainId: number;
        networkInstance: string;
        checkpointHash: Hex;
    }>;
    transaction(txHash: Hex): Promise<ChainTransaction | null>;
    receipt(txHash: Hex): Promise<ChainReceipt | null>;
    block(number: string | 'finalized'): Promise<ChainBlock | null>;
    codeHash(contract: Address, blockNumber: string): Promise<Hex>;
    tokenBalance(token: Address, wallet: Address, blockNumber: string): Promise<string>;
    tokenSupply(token: Address, blockNumber: string): Promise<string>;
};
export type VerifiedEnvelope = {
    receipt: ChainReceipt;
    tx: ChainTransaction;
    block: ChainBlock;
    events: {
        name: string;
        args: Record<string, unknown>;
        address: string;
        logIndex: number;
    }[];
};
export class ReceiptVerifier {
    constructor(readonly manifest: Manifest, private readonly rpc: ChainPort) { this.manifest = freezeManifest(manifest); }
    async fetch(txHash: Hex): Promise<VerifiedEnvelope | null> {
        hash(txHash);
        const network = await this.rpc.network();
        const m = this.manifest;
        ensure(network.chainId === m.chainId && network.networkInstance === m.networkInstance && network.checkpointHash === m.checkpointHash, 'NETWORK_MISMATCH');
        const [tx, receipt] = await Promise.all([this.rpc.transaction(txHash), this.rpc.receipt(txHash)]);
        if (!tx || !receipt)
            return null;
        ensure(tx.hash === txHash && receipt.transactionHash === txHash, 'TRANSACTION_MISMATCH');
        const [block, finalized, checkpoint] = await Promise.all([this.rpc.block(receipt.blockNumber), this.rpc.block('finalized'), this.rpc.block(m.checkpointNumber)]);
        ensure(checkpoint?.hash === m.checkpointHash, 'CHECKPOINT_MISMATCH');
        if (!block || !finalized || block.hash !== receipt.blockHash || BigInt(block.number) > BigInt(finalized.number))
            return null;
        ensure(block.number === receipt.blockNumber && receipt.status === 'success' && tx.value === '0', 'UNSUCCESSFUL_RECEIPT');
        const events: VerifiedEnvelope['events'] = [];
        for (const contract of [m.cashToken, m.stockToken, m.fundingVault, m.mintController]) {
            ensure(await this.rpc.codeHash(contract, block.number) === m.codeHashes[contract.toLowerCase()], 'CODE_IDENTITY_MISMATCH');
        }
        const indices = new Set<number>();
        for (const log of receipt.logs) {
            ensure(!log.removed && Number.isSafeInteger(log.logIndex) && log.logIndex >= 0 && !indices.has(log.logIndex), 'INVALID_LOG_IDENTITY');
            indices.add(log.logIndex);
            if (![m.cashToken, m.stockToken, m.fundingVault, m.mintController].some(a => a.toLowerCase() === log.address.toLowerCase()))
                continue;
            if (!ABI.filter(e => e.type === 'event').some(e => toEventSelector(e) === log.topics[0]))
                continue;
            try {
                const event = decodeEventLog({ abi: ABI, topics: log.topics, data: log.data, strict: true });
                events.push({ name: event.eventName, args: event.args as unknown as Record<string, unknown>, address: log.address.toLowerCase(), logIndex: log.logIndex });
            }
            catch {
                throw new StocksError('UNDECODABLE_REGISTERED_LOG');
            }
        }
        return { receipt, tx, block, events };
    }
    async snapshot(blockNumber: string, blockHash: string, wallets: string[]) {
        const m = this.manifest;
        const network = await this.rpc.network();
        ensure(network.chainId === m.chainId && network.networkInstance === m.networkInstance && network.checkpointHash === m.checkpointHash, 'NETWORK_MISMATCH');
        const [block, finalized] = await Promise.all([this.rpc.block(blockNumber), this.rpc.block('finalized')]);
        if (!block || !finalized || block.hash !== blockHash || BigInt(blockNumber) > BigInt(finalized.number))
            return null;
        for (const token of [m.cashToken, m.stockToken])
            ensure(await this.rpc.codeHash(token, blockNumber) === m.codeHashes[token.toLowerCase()], 'CODE_IDENTITY_MISMATCH');
        const walletBalances: Record<string, string> = {};
        for (const wallet of wallets)
            walletBalances[wallet] = await this.rpc.tokenBalance(m.stockToken, address(wallet), blockNumber);
        const [cashBalance, stockSupply] = await Promise.all([this.rpc.tokenBalance(m.cashToken, m.fundingVault, blockNumber), this.rpc.tokenSupply(m.stockToken, blockNumber)]);
        ensure([cashBalance, stockSupply, ...Object.values(walletBalances)].every(v => /^(0|[1-9]\d*)$/.test(v)), 'INVALID_CHAIN_BALANCE');
        return { blockNumber, blockHash, cashBalance, stockSupply, walletBalances };
    }
    unallocated(proof: VerifiedEnvelope): {
        eventId: string;
        payer: string;
        amount: string;
    }[] {
        ensure(!proof.events.some(e => e.name === 'FundingReceived'), 'ATTRIBUTED_FUNDING_PRESENT');
        return proof.events.filter(e => e.name === 'Transfer' && e.address === address(this.manifest.cashToken) && String(e.args.to).toLowerCase() === address(this.manifest.fundingVault) && typeof e.args.value === 'bigint' && e.args.value > 0n).map(e => {
            ensure(typeof e.args.from === 'string' && typeof e.args.value === 'bigint', 'INVALID_TRANSFER');
            return { eventId: `${this.manifest.networkInstance}:${proof.receipt.transactionHash}:${e.logIndex}`, payer: e.args.from.toLowerCase() === zeroAddress ? zeroAddress : address(e.args.from), amount: amount(e.args.value.toString()).toString() };
        });
    }
    funding(proof: VerifiedEnvelope): {
        orderKey: string;
        payer: string;
        amount: string;
        eventId: string;
        blockTimestamp: string;
    } {
        const m = this.manifest;
        ensure(address(proof.tx.to) === address(m.fundingVault), 'WRONG_TARGET');
        const matches = proof.events.filter(e => e.name === 'FundingReceived' && e.address === address(m.fundingVault));
        ensure(matches.length === 1, 'FUNDING_EVENT_COUNT');
        const event = matches[0];
        const args = event.args;
        ensure(typeof args.orderKey === 'string' && typeof args.payer === 'string' && typeof args.token === 'string' && typeof args.amount === 'bigint', 'INVALID_FUNDING_EVENT');
        const paid = amount(args.amount.toString());
        ensure(address(args.token) === address(m.cashToken) && address(args.payer) === address(proof.tx.from), 'WRONG_FUNDING_ASSET_OR_SENDER');
        const input = encodeFunctionData({ abi: ABI, functionName: 'depositForOrder', args: [args.orderKey as Hex, paid] });
        ensure(input === proof.tx.input, 'WRONG_CALLDATA');
        const movement = this.transfer(proof, m.cashToken, args.payer, m.fundingVault, paid);
        return { orderKey: args.orderKey, payer: address(args.payer), amount: paid.toString(), eventId: `${m.networkInstance}:${proof.receipt.transactionHash}:${movement.logIndex}`, blockTimestamp: proof.block.timestamp };
    }
    confirmation(proof: VerifiedEnvelope, call: AuthorizedCall, kind: 'MINT' | 'REFUND', quantity: string, wallet: string): void {
        const m = this.manifest;
        ensure(address(proof.tx.from) === address(call.from) && address(proof.tx.to) === address(call.to) && proof.tx.input === call.data, 'SUBMISSION_CALL_MISMATCH');
        const expectedName = kind === 'MINT' ? 'StockMinted' : 'FundingRefunded';
        const events = proof.events.filter(e => e.name === expectedName && e.address === address(call.to));
        ensure(events.length === 1, 'OPERATION_EVENT_COUNT');
        const args = events[0].args;
        ensure(args.operationId === operationKey(call.operationId) && typeof args.recipient === 'string' && address(args.recipient) === address(wallet), 'OPERATION_IDENTITY_MISMATCH');
        if (kind === 'MINT') {
            ensure(typeof args.token === 'string' && address(args.token) === address(m.stockToken) && args.quantity === amount(quantity), 'MINT_QUANTITY_MISMATCH');
            this.transfer(proof, m.stockToken, zeroAddress, wallet, amount(quantity));
        }
        else {
            ensure(args.amount === amount(quantity), 'REFUND_AMOUNT_MISMATCH');
            this.transfer(proof, m.cashToken, m.fundingVault, wallet, amount(quantity));
        }
    }
    private transfer(proof: VerifiedEnvelope, token: string, from: string, to: string, quantity: bigint): VerifiedEnvelope['events'][number] {
        const transfers = proof.events.filter(e => e.name === 'Transfer' && e.address === address(token));
        ensure(transfers.length === 1 && String(transfers[0].args.from).toLowerCase() === from.toLowerCase() && String(transfers[0].args.to).toLowerCase() === to.toLowerCase() && transfers[0].args.value === quantity, 'ERC20_MOVEMENT_MISMATCH');
        return transfers[0];
    }
}
export function authorizedCall(m: Manifest, operationId: string, kind: 'MINT' | 'REFUND', wallet: string, quantity: string): AuthorizedCall {
    const data = kind === 'MINT' ? encodeFunctionData({ abi: ABI, functionName: 'mintForOperation', args: [operationKey(operationId), m.stockToken, address(wallet), amount(quantity)] }) : encodeFunctionData({ abi: ABI, functionName: 'refundForOperation', args: [operationKey(operationId), address(wallet), amount(quantity)] });
    return { operationId, chainId: m.chainId, networkInstance: m.networkInstance, deploymentId: m.deploymentId, from: m.signerAddress, to: kind === 'MINT' ? m.mintController : m.fundingVault, data, value: '0' };
}
