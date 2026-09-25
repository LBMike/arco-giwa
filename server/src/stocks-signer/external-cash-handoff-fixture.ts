// TEST_HARNESS_ONLY. Never imported by runtime or preparation tools.
import { getContractAddress, keccak256 } from 'viem';
import { PLATFORM_TUSDC, manifestDigest, type Manifest } from '../stocks/contracts.js';
import { a, h, testManifest } from '../stocks/test-fixtures.js';
import type { ExternalCashHandoffPlan } from './external-cash-handoff.js';
import type { JsonRpcTransport } from '../stocks/rpc.js';
export function externalCashFixture() {
  const priorManifest = testManifest();
  const order = ['fundingVault', 'mintController', 'stockToken', 'redemptionEscrow'] as const;
  const contracts = Object.fromEntries(order.map((name, i) => [name,
    getContractAddress({ from: priorManifest.signerAddress, nonce: BigInt(20 + i) }).toLowerCase()]));
  const manifest: Manifest = { ...priorManifest, ...contracts, schemaVersion: 3, cashSymbol: 'tUSDC', cashToken: PLATFORM_TUSDC,
    deploymentId: 'TEST_HARNESS_ONLY_TUSDC_025', networkInstance: 'TEST_HARNESS_ONLY_TUSDC_EPOCH_025',
    checkpointNumber: '10', checkpointHash: h(10), nonUpgradeable: false, stockContractsNonUpgradeable: true,
    cashIdentity: { kind: 'ERC1967', implementation: a(700), implementationCodeHash: h(700), proxyAdmin: a(701), proxyAdminCodeHash: h(701) },
    codeHashes: Object.fromEntries([PLATFORM_TUSDC, ...Object.values(contracts)].map(a => [a, keccak256('0x6000')])) };
  const plan: ExternalCashHandoffPlan = { schemaVersion: 1, purpose: 'GIWA_TUSDC_SIGNER_HANDOFF_025', priorManifest, manifest,
    reviewedPriorManifestDigest: manifestDigest(priorManifest), reviewedManifestDigest: manifestDigest(manifest),
    reviewedPriorInitialNonce: '20', reviewedFirstCreateNonce: '20', creations: order.map((contract, i) => ({ contract,
      nonce: String(20 + i), inputHash: keccak256('0x6001'), transactionHash: h(900 + i) })) };
  const account = { networkInstance: priorManifest.networkInstance, checkpointNumber: priorManifest.checkpointNumber,
    checkpointHash: priorManifest.checkpointHash, initialNonce: '20', nextNonce: '20' };
  const rpc: JsonRpcTransport = async (method, params) => {
    if (method === 'eth_chainId') return '0x164ce';
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'finalized' || params[0] === 'latest' ? 100 : Number(BigInt(params[0] as string));
      return { number: `0x${n.toString(16)}`, hash: h(n) };
    }
    if (method === 'eth_getTransactionCount') return '0x18';
    if (method === 'eth_getCode') return '0x6000';
    if (method === 'eth_call') return `0x${'0'.repeat(64)}`;
    const c = plan.creations.find(c => c.transactionHash === params[0]);
    if (!c) throw Error('TEST_RPC_UNEXPECTED');
    const common = { from: priorManifest.signerAddress, to: null, blockNumber: '0x14', blockHash: h(20) };
    if (method === 'eth_getTransactionByHash') return { ...common, hash: c.transactionHash, nonce: `0x${BigInt(c.nonce).toString(16)}`, input: '0x6001', value: '0x0' };
    if (method === 'eth_getTransactionReceipt') return { ...common, transactionHash: c.transactionHash, status: '0x1', contractAddress: manifest[c.contract] };
    throw Error('TEST_RPC_UNEXPECTED');
  };
  return { plan, account, rpc };
}
