// TEST_HARNESS_ONLY. Explicit imports from tests only; never selected by runtime composition.
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import { ABI, ABI_DIGEST, callDigest, operationKey, type Actor, type AuthorizedCall, type Manifest, type SignerPort, type Submission } from './contracts.js';
import type { ChainBlock, ChainPort, ChainReceipt, ChainTransaction, RawLog } from './chain.js';
export const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
export const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
export const ACTOR: Actor = { actorId: 'test-actor', wallet: a(10), chainId: 91342, scope: 'STOCKS_TESTNET', verified: true };
export function testManifest(): Manifest {
    return { deploymentId: 'TEST_HARNESS_ONLY_STOCKS_V1', profile: 'DEMO_TESTNET', chainId: 91342, networkInstance: 'TEST_HARNESS_ONLY_NETWORK_V1', checkpointNumber: '1', checkpointHash: h(1), abiDigest: ABI_DIGEST, finalityPolicy: 'FINALIZED', cashToken: a(100), cashSymbol: 'ARCO_TEST_USDC', cashScale: 6, stockToken: a(101), quantityScale: 9, fundingVault: a(102), mintController: a(103), signerAddress: a(104), codeHashes: Object.fromEntries([100, 101, 102, 103].map(n => [a(n), keccak256('0x6000')])), restrictedTransfers: true, nonUpgradeable: true };
}
export function eventLog(contract: Address, name: string, args: Record<string, unknown>, index: number): RawLog {
    const event = ABI.find(entry => entry.type === 'event' && entry.name === name);
    if (!event || event.type !== 'event')
        throw new Error('INVALID_TEST_EVENT');
    const params = event.inputs.filter(input => !('indexed' in input && input.indexed));
    return { address: contract, topics: encodeEventTopics({ abi: ABI as Abi, eventName: name, args }) as [
            Hex,
            ...Hex[]
        ], data: encodeAbiParameters(params, params.map(p => args[p.name]) as never), logIndex: index, removed: false };
}
export class TestChain implements ChainPort {
    mode = 'TEST_HARNESS_ONLY' as const;
    receipts = new Map<string, ChainReceipt>();
    transactions = new Map<string, ChainTransaction>();
    blocks = new Map<string, ChainBlock>();
    finalizedNumber = '100';
    wrongCode = false;
    wrongChain = false;
    stockSupply = '0';
    cashBalance = '0';
    walletBalances: Record<string, string> = {};
    constructor(readonly m: Manifest) { this.blocks.set('1', { number: '1', hash: h(1), timestamp: '1' }); this.blocks.set('100', { number: '100', hash: h(100), timestamp: '2000000000' }); }
    async network() { return { chainId: this.wrongChain ? 1 : 91342, networkInstance: this.m.networkInstance, checkpointHash: this.m.checkpointHash }; }
    async transaction(id: Hex) { return this.transactions.get(id) ?? null; }
    async receipt(id: Hex) { return this.receipts.get(id) ?? null; }
    async block(number: string | 'finalized') { return this.blocks.get(number === 'finalized' ? this.finalizedNumber : number) ?? null; }
    async codeHash() { return this.wrongCode ? h(77) : keccak256('0x6000'); }
    async tokenBalance(token: Address, wallet: Address) { return token === this.m.cashToken ? this.cashBalance : this.walletBalances[wallet] ?? '0'; }
    async tokenSupply() { return this.stockSupply; }
    add(tx: ChainTransaction, logs: RawLog[], timestamp = Math.floor(Date.now() / 1000).toString(), blockNumber = '10') {
        const blockHash = h(parseInt(blockNumber, 10));
        this.blocks.set(blockNumber, { number: blockNumber, hash: blockHash, timestamp });
        this.transactions.set(tx.hash, tx);
        this.receipts.set(tx.hash, { transactionHash: tx.hash, blockNumber, blockHash, status: 'success', logs });
        return tx.hash;
    }
    funding(orderKey: Hex, cash: string, payer = ACTOR.wallet, txHash = h(200), timestamp?: string) {
        return this.add({ hash: txHash, from: payer, to: this.m.fundingVault, input: encodeFunctionData({ abi: ABI, functionName: 'depositForOrder', args: [orderKey, BigInt(cash)] }), value: '0' }, [eventLog(this.m.fundingVault, 'FundingReceived', { orderKey, payer, token: this.m.cashToken, amount: BigInt(cash) }, 0), eventLog(this.m.cashToken, 'Transfer', { from: payer, to: this.m.fundingVault, value: BigInt(cash) }, 1)], timestamp);
    }
    confirmation(call: AuthorizedCall, quantity: string, wallet: Address, kind: 'MINT' | 'REFUND', txHash: Hex) {
        const logs = kind === 'MINT' ? [eventLog(this.m.mintController, 'StockMinted', { operationId: operationKey(call.operationId), token: this.m.stockToken, recipient: wallet, quantity: BigInt(quantity) }, 0), eventLog(this.m.stockToken, 'Transfer', { from: zeroAddress, to: wallet, value: BigInt(quantity) }, 1)] : [eventLog(this.m.fundingVault, 'FundingRefunded', { operationId: operationKey(call.operationId), recipient: wallet, amount: BigInt(quantity) }, 0), eventLog(this.m.cashToken, 'Transfer', { from: this.m.fundingVault, to: wallet, value: BigInt(quantity) }, 1)];
        return this.add({ hash: txHash, from: call.from, to: call.to, input: call.data, value: '0' }, logs, undefined, '20');
    }
}
export class TestSigner implements SignerPort {
    readonly mode = 'TEST_HARNESS_ONLY';
    calls: AuthorizedCall[] = [];
    receipts = new Map<string, Submission>();
    throwAfterSubmit = false;
    async submit(call: AuthorizedCall) {
        this.calls.push(call);
        const result = { operationId: call.operationId, txHash: h(1000 + this.calls.length), callDigest: callDigest(call) };
        this.receipts.set(call.operationId, result);
        if (this.throwAfterSubmit)
            throw new Error('SIMULATED_TIMEOUT');
        return result;
    }
    async lookup(id: string) { return this.receipts.get(id) ?? null; }
}
