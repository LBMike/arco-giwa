import { encodeFunctionData, parseAbi } from 'viem';
import { ensure, freezeManifest, type Manifest } from '../stocks/contracts.js';
import type { ChainPort } from '../stocks/chain.js';
import type { JsonRpcTransport } from '../stocks/rpc.js';

export async function verifyStocksDeployment(manifest: Manifest, rpc: ChainPort, transport: JsonRpcTransport): Promise<void> {
  manifest = freezeManifest(manifest) as Manifest;
  const network = await rpc.network();
  ensure(network.chainId === 91342 && network.networkInstance === manifest.networkInstance && network.checkpointHash === manifest.checkpointHash, 'STOCKS_CHECKPOINT_MISMATCH');
  const finalized = await rpc.block('finalized');
  ensure(finalized && BigInt(finalized.number) >= BigInt(manifest.checkpointNumber), 'STOCKS_FINALITY_UNAVAILABLE');
  for (const target of [manifest.cashToken, manifest.stockToken, manifest.fundingVault, manifest.mintController, manifest.redemptionEscrow]) ensure(await rpc.codeHash(target, finalized.number) === manifest.codeHashes[target.toLowerCase()], 'STOCKS_CODE_MISMATCH');
  const bindings: [string, string, string][] = [
    [manifest.stockToken, 'mintController', manifest.mintController], [manifest.stockToken, 'redemptionEscrow', manifest.redemptionEscrow],
    [manifest.fundingVault, 'cashToken', manifest.cashToken], [manifest.fundingVault, 'redemptionEscrow', manifest.redemptionEscrow], [manifest.fundingVault, 'operator', manifest.signerAddress],
    [manifest.mintController, 'stockToken', manifest.stockToken], [manifest.mintController, 'operator', manifest.signerAddress],
    [manifest.redemptionEscrow, 'stockToken', manifest.stockToken], [manifest.redemptionEscrow, 'cashToken', manifest.cashToken], [manifest.redemptionEscrow, 'fundingVault', manifest.fundingVault], [manifest.redemptionEscrow, 'operator', manifest.signerAddress],
  ];
  for (const [target, getter, expected] of bindings) {
    const data = encodeFunctionData({ abi: parseAbi([`function ${getter}() view returns (address)`]), functionName: getter });
    const value = await transport('eth_call', [{ to: target, data }, `0x${BigInt(finalized.number).toString(16)}`]);
    ensure(value === `0x${expected.slice(2).toLowerCase().padStart(64, '0')}`, 'STOCKS_CONSTRUCTOR_BINDING_MISMATCH');
  }
  for (const [target, expected] of [[manifest.cashToken, 6n], [manifest.stockToken, 9n]] as const) {
    const data = encodeFunctionData({ abi: parseAbi(['function decimals() view returns (uint8)']), functionName: 'decimals' });
    const value = await transport('eth_call', [{ to: target, data }, `0x${BigInt(finalized.number).toString(16)}`]);
    ensure(typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value) && BigInt(value) === expected, 'STOCKS_TOKEN_SCALE_MISMATCH');
  }
  ensure((await rpc.block(finalized.number))?.hash === finalized.hash, 'STOCKS_FINALIZED_BLOCK_CHANGED');
}

