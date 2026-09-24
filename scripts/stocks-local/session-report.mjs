// Shared by the local browser entry and its tests. Build a fresh allowlisted
// report; never serialize bootstrap credentials or the raw diagnostic response.
function requireValue(condition) { if (!condition) throw Error('LOCAL_SESSION_REPORT_INVALID'); }
function object(value) { requireValue(value && typeof value === 'object' && !Array.isArray(value)); return value; }
function text(value, pattern) { requireValue(typeof value === 'string' && pattern.test(value)); return value; }
const integer = value => text(value, /^(0|[1-9][0-9]{0,77})$/);
const identifier = value => text(value, /^[A-Za-z0-9:_-]{1,128}$/);
function quantity(value, decimals) {
  const raw = integer(value).padStart(decimals + 1, '0');
  const fraction = raw.slice(-decimals).replace(/0+$/, '');
  return raw.slice(0, -decimals) + (fraction ? `.${fraction}` : '');
}
function orders(value) {
  requireValue(Array.isArray(value) && value.length <= 100);
  const rows = [...value].map(entry => {
    const row = object(entry);
    return { id: identifier(row.id), state: text(row.state, /^[A-Z][A-Z_]{0,63}$/) };
  });
  requireValue(new Set(rows.map(row => row.id)).size === rows.length);
  return rows;
}

export function createLocalSessionReport(configValue, stateValue, capturedAt = new Date()) {
  const config = object(configValue), manifest = object(config.manifest), accounts = object(config.accounts);
  const state = object(stateValue), snapshot = object(state.snapshot);
  requireValue(config.ownerWorkspace === true && manifest.profile === 'DEMO_TESTNET' && manifest.chainId === 91342);
  requireValue(manifest.cashScale === 6 && manifest.quantityScale === 9);
  requireValue(['ARCO_TEST_USDC', 'ARCO_TEST_RLUSD'].includes(manifest.cashSymbol));
  requireValue(capturedAt instanceof Date && Number.isFinite(capturedAt.getTime()));
  const balances = {
    holderCash: integer(snapshot.holderCash), holderStock: integer(snapshot.holderStock),
    vaultCash: integer(snapshot.vaultCash), escrowStock: integer(snapshot.escrowStock), stockSupply: integer(snapshot.stockSupply),
  };
  return {
    schemaVersion: 1, kind: 'STOCKS_LOCAL_SESSION_SUMMARY', localTestOnly: true,
    capturedAt: capturedAt.toISOString(), restorableBackup: false,
    coverage: { account: 'A', latestOrdersPerSide: 100, fullHistory: false, atomicSnapshot: false,
      orderFields: ['id', 'state'], orderSort: 'CREATED_AT_DESC', amounts: 'EXACT_DECIMAL_STRINGS' },
    deployment: { id: identifier(manifest.deploymentId), chainId: 91342 },
    holder: text(accounts.holder, /^0x[0-9a-fA-F]{40}$/).toLowerCase(),
    chainObservation: { blockNumber: integer(snapshot.blockNumber), blockHash: text(snapshot.blockHash, /^0x[0-9a-f]{64}$/) },
    assets: { cash: manifest.cashSymbol, stock: 'NVDA', cashDecimals: 6, stockDecimals: 9 },
    balances: { holderCash: quantity(balances.holderCash, 6), holderStock: quantity(balances.holderStock, 9),
      vaultCash: quantity(balances.vaultCash, 6), escrowStock: quantity(balances.escrowStock, 9), stockSupply: quantity(balances.stockSupply, 9) },
    baseUnits: balances,
    orders: { buy: orders(snapshot.buyOrders), sell: orders(snapshot.sellOrders) },
    reconciliationStatus: text(snapshot.reconciliationStatus, /^[A-Z][A-Z_]{0,63}$/),
  };
}
