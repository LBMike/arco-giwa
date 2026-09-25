import { keccak256, encodeFunctionData, parseAbi, type Hex } from 'viem';
import { address, ensure, hash, freezeManifest, type Manifest } from './contracts.js';
import type { ChainBlock, ChainPort, ChainReceipt, ChainTransaction, RawLog } from './chain.js';
export type JsonRpcTransport = (method: string, params: unknown[]) => Promise<unknown>;
function object(value: unknown): Record<string, any> { ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'MALFORMED_RPC_RESPONSE'); return value as Record<string, any>; }
function integer(value: unknown): string { ensure(typeof value === 'string' && /^0x(0|[1-9a-f][0-9a-f]*)$/.test(value), 'MALFORMED_RPC_QUANTITY'); return BigInt(value).toString(); }
function hexData(value: unknown): Hex { ensure(typeof value === 'string' && /^0x([0-9a-f]{2})*$/.test(value), 'MALFORMED_RPC_DATA'); return value as Hex; }
function rpcBlock(value: unknown): ChainBlock | null {
    if (value === null)
        return null;
    const row = object(value);
    return { number: integer(row.number), hash: hash(row.hash), timestamp: integer(row.timestamp) };
}
export function createStocksRpcPort(transport: JsonRpcTransport, manifest: Manifest): ChainPort {
    manifest = freezeManifest(manifest);
    const block = async (number: string | 'finalized') => rpcBlock(await transport('eth_getBlockByNumber', [number === 'finalized' ? number : `0x${BigInt(number).toString(16)}`, false]));
    return {
        async network() {
            const chain = integer(await transport('eth_chainId', []));
            const checkpoint = await block(manifest.checkpointNumber);
            ensure(chain === '91342' && checkpoint, 'RPC_NETWORK_MISMATCH');
            // networkInstance is caller-selected scope; the immutable checkpoint binds it to actual RPC history.
            return { chainId: 91342, networkInstance: manifest.networkInstance, checkpointHash: checkpoint.hash };
        },
        async block(number) { return block(number); },
        async transaction(txHash): Promise<ChainTransaction | null> {
            const response = await transport('eth_getTransactionByHash', [txHash]);
            if (response === null)
                return null;
            const row = object(response);
            return { hash: hash(row.hash), from: address(row.from), to: address(row.to), input: hexData(row.input), value: integer(row.value) };
        },
        async receipt(txHash): Promise<ChainReceipt | null> {
            const response = await transport('eth_getTransactionReceipt', [txHash]);
            if (response === null)
                return null;
            const row = object(response);
            ensure(Array.isArray(row.logs), 'MALFORMED_RPC_LOGS');
            const logs: RawLog[] = row.logs.map((raw: unknown) => {
                const log = object(raw);
                ensure(log.transactionHash === row.transactionHash && log.blockHash === row.blockHash && log.blockNumber === row.blockNumber && Array.isArray(log.topics) && log.topics.length > 0 && typeof log.removed === 'boolean', 'RPC_LOG_IDENTITY_MISMATCH');
                const index = BigInt(integer(log.logIndex));
                ensure(index <= 2147483647n, 'RPC_LOG_INDEX_OVERFLOW');
                return { address: address(log.address), data: hexData(log.data), topics: log.topics.map((t: unknown) => { ensure(typeof t === 'string' && /^0x[0-9a-f]{64}$/.test(t), 'MALFORMED_RPC_TOPIC'); return t as Hex; }) as [
                        Hex,
                        ...Hex[]
                    ], logIndex: Number(index), removed: log.removed };
            });
            const status = integer(row.status);
            ensure(status === '0' || status === '1', 'MALFORMED_RPC_STATUS');
            return { transactionHash: hash(row.transactionHash), blockNumber: integer(row.blockNumber), blockHash: hash(row.blockHash), status: status === '1' ? 'success' : 'reverted', logs };
        },
        async tokenBalance(token, wallet, blockNumber) {
            const data = encodeFunctionData({ abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [wallet] });
            const result = hexData(await transport('eth_call', [{ to: token, data }, `0x${BigInt(blockNumber).toString(16)}`]));
            ensure(result.length === 66, 'INVALID_BALANCE_RESULT');
            return BigInt(result).toString();
        },
        async tokenSupply(token, blockNumber) {
            const data = encodeFunctionData({ abi: parseAbi(['function totalSupply() view returns (uint256)']), functionName: 'totalSupply' });
            const result = hexData(await transport('eth_call', [{ to: token, data }, `0x${BigInt(blockNumber).toString(16)}`]));
            ensure(result.length === 66, 'INVALID_SUPPLY_RESULT');
            return BigInt(result).toString();
        },
        async codeHash(contract, blockNumber) { return keccak256(hexData(await transport('eth_getCode', [contract, `0x${BigInt(blockNumber).toString(16)}`]))); },
        async storageAt(contract, slot, blockNumber) {
            const result = hexData(await transport('eth_getStorageAt', [contract, slot, `0x${BigInt(blockNumber).toString(16)}`]));
            ensure(result.length === 66, 'INVALID_STORAGE_RESULT');
            return result;
        },
    };
}
