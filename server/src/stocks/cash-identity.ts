import { keccak256, toBytes, toHex, type Hex } from 'viem';
import { address, ensure, hash, type Manifest } from './contracts.js';
import type { ChainPort } from './chain.js';
import type { JsonRpcTransport } from './rpc.js';

export const CASH_IMPLEMENTATION_SLOT = toHex(BigInt(keccak256(toBytes('eip1967.proxy.implementation'))) - 1n, { size: 32 });
export const CASH_ADMIN_SLOT = toHex(BigInt(keccak256(toBytes('eip1967.proxy.admin'))) - 1n, { size: 32 });
const word = (value: string) => `0x${address(value).slice(2).padStart(64, '0')}`;

/** Verify historical identity at the same block used for balances/receipts. */
export async function verifyCashIdentity(m: Manifest, rpc: Pick<ChainPort, 'storageAt' | 'codeHash'>, blockNumber: string): Promise<void> {
    if (m.schemaVersion !== 3) return;
    ensure(rpc.storageAt, 'CASH_IDENTITY_UNAVAILABLE', 503);
    const p = m.cashIdentity;
    const [implementation, admin, proxyCode, implementationCode, adminCode] = await Promise.all([
        rpc.storageAt(m.cashToken, CASH_IMPLEMENTATION_SLOT, blockNumber),
        rpc.storageAt(m.cashToken, CASH_ADMIN_SLOT, blockNumber),
        rpc.codeHash(m.cashToken, blockNumber),
        rpc.codeHash(p.implementation, blockNumber),
        rpc.codeHash(p.proxyAdmin, blockNumber),
    ]);
    ensure(implementation === word(p.implementation) && admin === word(p.proxyAdmin)
        && proxyCode === m.codeHashes[address(m.cashToken)]
        && implementationCode === p.implementationCodeHash && adminCode === p.proxyAdminCodeHash,
    'CASH_IDENTITY_MISMATCH', 503);
}

/** A finalized snapshot can lag an upgrade. New execution also checks latest identity. */
export async function verifyCurrentCashIdentity(m: Manifest, transport: JsonRpcTransport): Promise<void> {
    if (m.schemaVersion !== 3) return;
    ensure(await transport('eth_chainId', []) === '0x164ce', 'CASH_IDENTITY_NETWORK_MISMATCH', 503);
    const block = await transport('eth_getBlockByNumber', ['latest', false]) as Record<string, unknown> | null;
    ensure(block && typeof block.number === 'string' && /^0x(0|[1-9a-f][0-9a-f]*)$/.test(block.number), 'CASH_IDENTITY_UNAVAILABLE', 503);
    const blockHash = hash(String(block.hash)), tag = block.number;
    const port = {
        storageAt: async (target: `0x${string}`, slot: Hex) => {
            const result = await transport('eth_getStorageAt', [target, slot, tag]);
            ensure(typeof result === 'string' && /^0x[0-9a-f]{64}$/.test(result), 'CASH_IDENTITY_UNAVAILABLE', 503);
            return result as Hex;
        },
        codeHash: async (target: `0x${string}`) => {
            const result = await transport('eth_getCode', [target, tag]);
            ensure(typeof result === 'string' && /^0x(?:[0-9a-f]{2})+$/.test(result), 'CASH_IDENTITY_UNAVAILABLE', 503);
            return keccak256(result as Hex);
        },
    };
    await verifyCashIdentity(m, port, BigInt(tag).toString());
    const same = await transport('eth_getBlockByNumber', [tag, false]) as Record<string, unknown> | null;
    ensure(same?.number === tag && same.hash === blockHash, 'CASH_IDENTITY_BLOCK_CHANGED', 503);
}
