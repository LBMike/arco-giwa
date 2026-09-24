import { decodeEventLog, decodeFunctionData, erc20Abi, toEventSelector, type Hex } from 'viem';
import { ABI, address, ensure, freezeManifest, hash, immutable, manifestDigest, StocksError, type Manifest } from '../stocks/contracts.js';
import { ReceiptVerifier, type ChainPort, type VerifiedEnvelope } from '../stocks/chain.js';
import { digest, type Side, type Stage, type Transaction } from './contracts.js';

export type SubmissionReceiptRequest = { claimId: string; intentKey: string; transactionDigest: string; txHash: Hex; stage: Stage; side: Side; transaction: Transaction };
export type SubmissionReceiptProof = { version: 1; deploymentDigest: string; claimId: string; intentKey: string; transactionDigest: string; txHash: Hex; status: 'CONFIRMED' | 'REVERTED'; blockNumber: string; blockHash: Hex; evidence: Record<string, unknown> };
export type SubmissionReceiptVerifier = { verify(request: SubmissionReceiptRequest): Promise<SubmissionReceiptProof | null> };
const approvalEvent = erc20Abi.find(e => e.type === 'event' && e.name === 'Approval')!;
const canonicalNumber = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value);

/** Only server composition supplies this port. It never performs database writes. */
export function createSubmissionReceiptVerifier(input: Manifest, rpc: ChainPort, options: { timeoutMs?: number } = {}): SubmissionReceiptVerifier {
  const m = freezeManifest(input), verifier = new ReceiptVerifier(m, rpc);
  const timeoutMs = options.timeoutMs ?? 8000;
  ensure(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 8000, 'INVALID_RECEIPT_TIMEOUT');
  return { async verify(inputRequest) {
    const request = immutable(inputRequest);
    let expired = false;
    const deadline = performance.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => ensure(!expired && performance.now() < deadline, 'SUBMISSION_RECEIPT_TIMEOUT', 503);
    const read = async <T>(call: () => Promise<T>): Promise<T> => { check(); const value = await call(); check(); return immutable(value); };
    const work = async (): Promise<SubmissionReceiptProof | null> => {
      hash(request.txHash);
      ensure(request.transactionDigest === digest(request.transaction) && request.transaction.chainId === m.chainId && request.transaction.value === '0', 'RECEIPT_BINDING');
      const network = await read(() => rpc.network());
      ensure(network.chainId === m.chainId && network.networkInstance === m.networkInstance && network.checkpointHash === m.checkpointHash, 'RECEIPT_NETWORK');
      const tx = await read(() => rpc.transaction(request.txHash)), receipt = await read(() => rpc.receipt(request.txHash));
      if (!tx || !receipt) return null;
      ensure(tx.hash === request.txHash && receipt.transactionHash === request.txHash && address(tx.from) === address(request.transaction.from) && address(tx.to) === address(request.transaction.to) && tx.input === request.transaction.data && tx.value === '0', 'RECEIPT_TRANSACTION');
      ensure(canonicalNumber(receipt.blockNumber) && ['success','reverted'].includes(receipt.status), 'RECEIPT_SHAPE'); hash(receipt.blockHash);
      const block = await read(() => rpc.block(receipt.blockNumber)), finalized = await read(() => rpc.block('finalized')), checkpoint = await read(() => rpc.block(m.checkpointNumber));
      ensure(checkpoint && checkpoint.number === m.checkpointNumber && checkpoint.hash === m.checkpointHash, 'RECEIPT_CHECKPOINT');
      if (!block || !finalized) return null;
      ensure(canonicalNumber(block.number) && canonicalNumber(finalized.number) && canonicalNumber(block.timestamp) && block.number === receipt.blockNumber && block.hash === receipt.blockHash, 'RECEIPT_CANONICAL');
      hash(finalized.hash);
      ensure(BigInt(block.number) >= BigInt(m.checkpointNumber), 'RECEIPT_BEFORE_CHECKPOINT');
      if (BigInt(block.number) > BigInt(finalized.number)) return null;
      const code: Record<string,string> = {};
      for (const target of [m.cashToken,m.stockToken,m.fundingVault,m.mintController,m.redemptionEscrow]) {
        code[address(target)] = await read(() => rpc.codeHash(target,block.number));
        ensure(code[address(target)] === m.codeHashes[address(target)], 'RECEIPT_CODE');
      }
      ensure(Array.isArray(receipt.logs) && receipt.logs.length <= 256, 'RECEIPT_LOGS');
      const indices = new Set<number>(), events: VerifiedEnvelope['events'] = [];
      const approvals: { address: string; args: Record<string,unknown> }[] = [];
      for (const log of receipt.logs) {
        ensure(!log.removed && Number.isSafeInteger(log.logIndex) && log.logIndex >= 0 && !indices.has(log.logIndex), 'RECEIPT_LOG_IDENTITY'); indices.add(log.logIndex);
        const emitter = address(log.address);
        if (!Object.prototype.hasOwnProperty.call(code,emitter)) continue;
        if (log.topics[0] === toEventSelector(approvalEvent)) {
          ensure(log.topics.length === 3 && /^0x[0-9a-fA-F]{64}$/.test(log.data), 'RECEIPT_APPROVAL_ENCODING');
          const decoded = decodeEventLog({ abi: erc20Abi, topics: log.topics, data: log.data, strict: true });
          approvals.push({address: emitter,args: decoded.args as unknown as Record<string,unknown>});
        } else if (ABI.some(e => e.type === 'event' && toEventSelector(e) === log.topics[0])) {
          const decoded = decodeEventLog({abi:ABI,topics:log.topics,data:log.data,strict:true});
          events.push({name:decoded.eventName,args:decoded.args as unknown as Record<string,unknown>,address:emitter,logIndex:log.logIndex});
        }
      }
      if (receipt.status === 'success') {
        if (request.stage === 'APPROVAL') {
          const token = request.side === 'BUY' ? m.cashToken : m.stockToken, spender = request.side === 'BUY' ? m.fundingVault : m.redemptionEscrow;
          const call = decodeFunctionData({abi:erc20Abi,data:request.transaction.data});
          ensure(address(tx.to) === address(token) && call.functionName === 'approve' && address(String(call.args[0])) === address(spender), 'RECEIPT_APPROVAL_CALL');
          const matches = approvals.filter(e => e.address === address(token));
          ensure(matches.length === 1 && address(String(matches[0].args.owner)) === address(tx.from) && address(String(matches[0].args.spender)) === address(spender) && matches[0].args.value === call.args[1], 'RECEIPT_APPROVAL_EVENT');
        } else {
          const proof: VerifiedEnvelope = {tx,receipt,block,events};
          if (request.side === 'BUY') verifier.funding(proof); else verifier.escrow(proof);
        }
      } else ensure(receipt.logs.length === 0, 'RECEIPT_REVERT_LOGS');
      // Check the receipt block and checkpoint again after every event/code observation.
      const canonical = await read(() => rpc.block(block.number)), finalCheckpoint = await read(() => rpc.block(m.checkpointNumber));
      ensure(canonical?.number === block.number && canonical.hash === block.hash && finalCheckpoint?.number === m.checkpointNumber && finalCheckpoint.hash === m.checkpointHash, 'RECEIPT_REORG');
      check();
      return {version:1,deploymentDigest:manifestDigest(m),claimId:request.claimId,intentKey:request.intentKey,transactionDigest:request.transactionDigest,txHash:request.txHash,status:receipt.status === 'success' ? 'CONFIRMED' : 'REVERTED',blockNumber:block.number,blockHash:block.hash,evidence:{network,tx,receipt,block,finalized,checkpoint,code}};
    };
    try {
      return await Promise.race([work(),new Promise<never>((_,reject) => { timer = setTimeout(() => {expired=true;reject(new StocksError('SUBMISSION_RECEIPT_TIMEOUT',503));},timeoutMs); })]);
    } catch (error) {
      if (error instanceof StocksError && error.code === 'SUBMISSION_RECEIPT_TIMEOUT') throw error;
      throw new StocksError('SUBMISSION_RECEIPT_UNAVAILABLE',503);
    } finally { clearTimeout(timer!); expired=true; }
  }};
}
