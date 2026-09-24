import assert from 'node:assert/strict';

// Read-only proof over real committed journal rows, HTTP responses and node transactions.
// It runs AFTER UI scenarios and cannot grant a claim or cause a wallet send.
export async function verifyUiEvidence(stack, wallet) {
  const snapshot = await stack.snapshot();
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const equalPayload = (a, b) => same(a.from, b.from) && same(a.to, b.to) && a.data === b.data && BigInt(a.value) === BigInt(b.value);
  const sends = wallet.sends;
  const holderSends = snapshot.rpcTrace.filter(row => row.method === 'eth_sendTransaction' && same(row.from, stack.accounts.holder));
  assert.equal(holderSends.length, sends.length, 'Every holder send goes through the actual UI wallet bridge once');
  assert.equal(snapshot.claims.length, sends.length, 'One durable claim per wallet attempt in these scenarios');
  assert.equal(new Set(sends.map(row => row.hash)).size, sends.length, 'No same hash dispatched again');
  const usedClaims = new Set();
  const proofs = await Promise.all(sends.map(async send => {
    const forward = holderSends.find(row => row.acceptedHash === send.hash);
    assert.ok(forward && equalPayload(forward, send.transaction));
    const candidates = snapshot.claims.filter(claim => !usedClaims.has(claim.claimId) && equalPayload(claim.transaction, send.transaction));
    const claim = candidates.find(candidate => snapshot.requests.some(request => request.method === 'POST'
      && request.path.endsWith('/wallet-submissions/claims') && request.status === 200
      && request.orderId === candidate.orderId && request.stage === candidate.stage && request.seq < forward.seq));
    assert.ok(claim, 'A successful claim response must precede this exact single RPC send');
    usedClaims.add(claim.claimId);
    const response = snapshot.requests.find(request => request.path.endsWith('/wallet-submissions/claims') && request.status === 200
      && request.orderId === claim.orderId && request.stage === claim.stage && request.seq < forward.seq);
    assert.equal(claim.transaction.chainId, 91342);
    assert.ok(new Date(claim.createdAt).getTime() <= forward.at, 'Journal committed before the provider request');
    if (claim.txHash) assert.equal(claim.txHash, send.hash, 'Known server hash is the original local transaction');
    const actual = await stack.rpc('eth_getTransactionByHash', [send.hash]);
    assert.ok(actual && equalPayload({ ...actual, data: actual.input }, send.transaction));
    assert.equal(BigInt(actual.chainId), 91342n);
    return { claimId: claim.claimId, side: claim.side, orderId: claim.orderId, stage: claim.stage,
      claimResponseSeq: response.seq, sendSeq: forward.seq, txHash: send.hash, nonce: actual.nonce,
      journalStatus: claim.status, journalHasHash: Boolean(claim.txHash) };
  }));
  assert.equal(new Set(proofs.map(row => row.nonce)).size, proofs.length, 'Distinct local holder nonces; no replacement or retry');
  assert.equal(snapshot.reconciliation.status, 'MATCHED_AT_CUTOFF');
  assert.deepEqual(snapshot.reconciliation.differences, []);
  assert.deepEqual(snapshot.workerErrors.processing, []);
  assert.deepEqual(snapshot.workerErrors.reviewJobs, []);
  return { proof: 'REAL_PG_CLAIM_RESPONSE_BEFORE_SINGLE_EVM_SEND', attempts: proofs };
}
