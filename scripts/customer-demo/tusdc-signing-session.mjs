const CHAIN_ID = 91342;
const FIRST_NONCE = 232n;
const PLAN_SIZE = 4;
const MAX_TTL_MS = 600_000;
const PLAN_KEYS = ['chainId', 'from', 'nonce', 'to', 'value', 'data'];
const SIGN_KEYS = ['type', 'chainId', 'nonce', 'value', 'data', 'gasLimit', 'maxPriorityFeePerGas', 'maxFeePerGas', 'accessList'];
const LIMIT_KEYS = ['maxGas', 'maxPriorityFeePerGas', 'maxFeePerGas', 'maxTotalFeeWei'];
const fail = reason => Error(`TUSDC_SIGNING_SESSION_${reason}`);

function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string')
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw fail('INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length
    || keys.some(key => !Object.prototype.hasOwnProperty.call(descriptors[key], 'value'))) throw fail('INVALID');
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function address(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/.test(value)) throw fail('INVALID');
  return value.toLowerCase();
}
function decimal(value, zero = false) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) throw fail('INVALID');
  const result = BigInt(value);
  if (result >= 2n ** 256n || (zero ? result < 0n : result <= 0n)) throw fail('INVALID');
  return result;
}
function nonce(value) {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) throw fail('INVALID');
  return BigInt(value);
}
function data(value) {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value) || value.length > 2 + 49_152 * 2) throw fail('INVALID');
  return value.toLowerCase();
}

/** Memory-only capability for the four already-reviewed CREATEs. This does not
 * attest signed bytes, query a chain, write a journal or broadcast. The caller's
 * unlock helper must authenticate the encrypted wallet against expectedSigner.
 * close releases our references; it does not claim JavaScript zeroization. */
export function createTusdcSigningSession({ transactions, expectedSigner, limits, unlock,
  ttlMs = MAX_TTL_MS, now = Date.now, signal } = {}) {
  let planned, caps, signer;
  try {
    signer = address(expectedSigner);
    if (!Array.isArray(transactions) || transactions.length !== PLAN_SIZE || typeof unlock !== 'function'
      || typeof now !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS
      || signal !== undefined && !(signal instanceof AbortSignal)) throw fail('INVALID');
    caps = record(limits, LIMIT_KEYS);
    caps = Object.freeze(Object.fromEntries(LIMIT_KEYS.map(key => [key, decimal(caps[key], key === 'maxPriorityFeePerGas')])));
    if (caps.maxPriorityFeePerGas > caps.maxFeePerGas) throw fail('INVALID');
    planned = Object.freeze(transactions.map((value, index) => {
      const tx = record(value, PLAN_KEYS);
      if (tx.chainId !== CHAIN_ID || address(tx.from) !== signer || tx.to !== null || tx.value !== '0x0'
        || nonce(tx.nonce) !== FIRST_NONCE + BigInt(index)) throw fail('INVALID');
      return Object.freeze({ nonce: tx.nonce, data: data(tx.data) });
    }));
  } catch { throw fail('CONFIGURATION_INVALID'); }

  let unlockCapability = unlock, walletSign = null, busy = false, nextIndex = null;
  let closed = null, startedAt = null, lastNow = null, timer = null;
  const close = (reason = 'CLOSED') => {
    closed ??= reason;
    walletSign = null;
    unlockCapability = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    signal?.removeEventListener('abort', onAbort);
  };
  const onAbort = () => close('ABORTED');
  const live = () => {
    if (signal?.aborted) close('ABORTED');
    if (closed) throw fail(closed);
    let current;
    try { current = now(); } catch { close(); throw fail('CLOSED'); }
    if (!Number.isSafeInteger(current) || current < 0 || lastNow !== null && current < lastNow) {
      close(); throw fail('CLOSED');
    }
    lastNow = current;
    if (startedAt !== null && current - startedAt >= ttlMs) {
      close('EXPIRED'); throw fail('EXPIRED');
    }
    return current;
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) close('ABORTED');

  const sign = async value => {
    let transaction, index;
    try {
      live();
      if (busy) throw fail('BUSY');
      try {
        const tx = record(value, SIGN_KEYS);
        index = Number(nonce(tx.nonce) - FIRST_NONCE);
        if (tx.type !== 2 || tx.chainId !== CHAIN_ID || tx.value !== '0'
          || !Number.isInteger(index) || index < 0 || index >= PLAN_SIZE
          || nextIndex !== null && index !== nextIndex || planned[index].nonce !== tx.nonce
          || planned[index].data !== data(tx.data) || !Array.isArray(tx.accessList) || tx.accessList.length !== 0
          || Reflect.ownKeys(tx.accessList).length !== 1) throw fail('INVALID');
        const gas = decimal(tx.gasLimit), fee = decimal(tx.maxFeePerGas), priority = decimal(tx.maxPriorityFeePerGas, true);
        if (gas > caps.maxGas || fee > caps.maxFeePerGas || priority > caps.maxPriorityFeePerGas
          || priority > fee || gas * fee > caps.maxTotalFeeWei) throw fail('INVALID');
        // The only object that crosses an await is a fresh immutable copy.
        transaction = Object.freeze({ ...tx, data: planned[index].data, accessList: Object.freeze([]) });
      } catch { throw fail('REQUEST_DENIED'); }
      busy = true;
      if (startedAt === null) {
        startedAt = live();
        timer = setTimeout(() => close('EXPIRED'), ttlMs);
        timer.unref?.();
        const open = unlockCapability;
        unlockCapability = null; // No failure, expiry or cancellation can reopen it.
        let wallet;
        try { wallet = await open(); } catch { throw fail('UNLOCK_FAILED'); }
        live();
        try {
          if (!wallet || typeof wallet.signTransaction !== 'function'
            || wallet.address !== undefined && address(wallet.address) !== signer) throw fail('INVALID');
          walletSign = wallet.signTransaction.bind(wallet);
        } catch { throw fail('UNLOCK_FAILED'); }
        finally { wallet = null; }
      }
      live();
      let signed;
      try { signed = await walletSign(transaction); } catch { throw fail('SIGN_FAILED'); }
      live();
      if (typeof signed !== 'string' || !/^0x02(?:[0-9a-fA-F]{2})+$/.test(signed) || signed.length > 2 + 65_536 * 2) throw fail('SIGN_FAILED');
      nextIndex = index + 1;
      if (nextIndex === PLAN_SIZE) close();
      return signed;
    } catch (error) {
      close();
      // Propagate only our closed vocabulary; wallet/password errors stay local.
      const message = error instanceof Error ? error.message : '';
      if (/^TUSDC_SIGNING_SESSION_(?:CLOSED|ABORTED|EXPIRED|BUSY|REQUEST_DENIED|UNLOCK_FAILED|SIGN_FAILED)$/.test(message)) throw Error(message);
      throw fail('CLOSED');
    } finally { busy = false; }
  };
  return Object.freeze({ sign, close: () => close() });
}
