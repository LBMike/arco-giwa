import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

// A hosted runner once lost its local HTTP socket on the first eth_chainId read
// after synchronous DB setup. Retry only that read once, before any UI wallet or
// funding operation. This is not a generic RPC retry or a transaction retry.
export async function assertLocalStartupChain(rpc) {
  let chain;
  try { chain = await rpc('eth_chainId', []); }
  catch (error) {
    if (!(error instanceof TypeError) || !['UND_ERR_SOCKET', 'ECONNRESET'].includes(error.cause?.code)) throw error;
    await delay(100);
    chain = await rpc('eth_chainId', []);
  }
  assert.equal(chain, '0x164ce', 'Local startup chain must be GIWA test chain 91342');
}

// Only the owner launcher calls this, against the Hardhat child it just spawned.
// Automining alone makes an idle workspace stale after one hour. Empty blocks
// keep local observation current; they do not bypass the runtime freshness gate.
export async function enableOwnerIntervalMining(rpc) {
  assert.equal(await rpc('eth_chainId', []), '0x164ce');
  const metadata = await rpc('hardhat_metadata', []);
  assert.equal(metadata?.chainId, 91342);
  assert.match(metadata?.instanceId ?? '', /^0x[0-9a-f]{64}$/);
  assert.ok(!metadata.forkedNetwork, 'Owner mining must not use a fork');
  assert.equal(await rpc('evm_setIntervalMining', [10000]), true, 'Owner interval mining was not enabled');
}
