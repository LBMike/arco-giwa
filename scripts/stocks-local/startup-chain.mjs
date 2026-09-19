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
