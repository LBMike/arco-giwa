import { MarketDataError } from './contracts.js';
import { decimal, parseExactJson } from './exact-json.js';
const invalid = (): never => { throw new MarketDataError('INVALID_RESPONSE'); };
/** Small RFC-4180 reader: quoted commas/newlines and doubled quotes, no coercion to JS numbers. */
function csv(input: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false; let closed = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) { if (c !== '"') cell += c; else if (input[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } continue; }
    if (c === '"') { if (cell || closed) return invalid(); quoted = true; }
    else if (c === ',') { row.push(cell); cell = ''; closed = false; }
    else if (c === '\r' || c === '\n') { if (c === '\r' && input[i + 1] === '\n') i++; row.push(cell); if (row.some(v => v)) rows.push(row); row = []; cell = ''; closed = false; }
    else { if (closed) return invalid(); cell += c; }
  }
  if (quoted) return invalid();
  row.push(cell); if (row.some(v => v)) rows.push(row);
  return rows;
}
export function issuerFundamentals(input: string, symbol: string, now: number) {
  if (!['DRAM', 'RAM'].includes(symbol) || input.length > 128 * 1024) return invalid();
  const rows = csv(input.replace(/^\uFEFF/, '')); const header = rows.shift();
  if (!header || new Set(header).size !== header.length) return invalid();
  const keys = ['Fund Ticker', 'CUSIP', 'Net Assets', 'Shares Outstanding', 'Rate Date'];
  if (keys.some(key => !header.includes(key))) return invalid();
  const matches = rows.filter(row => row[header.indexOf('Fund Ticker')] === symbol);
  if (matches.length !== 1 || matches[0].length !== header.length) return invalid();
  const value = (key: string) => matches[0][header.indexOf(key)];
  if (value('CUSIP') !== (symbol === 'DRAM' ? '77926X320' : '26923V415')) return invalid();
  const date = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value('Rate Date'));
  if (!date) return invalid();
  const asOf = `${date[3]}-${date[1]}-${date[2]}`; const ms = Date.parse(asOf);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== asOf || ms > now || now - ms > 7 * 86400000) return invalid();
  const amount = (key: string) => {
    const raw = value(key); if (!/^(0|[1-9]\d{0,29})(\.\d{1,18})?$/.test(raw)) return invalid();
    const normalized = decimal(parseExactJson(raw)); if (normalized === '0') return invalid(); return normalized;
  };
  return { aum: amount('Net Assets'), aumAsOf: asOf, sharesOutstanding: amount('Shares Outstanding'), issuerFundamentals: { source: symbol === 'DRAM' ? 'Roundhill' : 'REX Shares', sourceUrl: symbol === 'DRAM' ? 'https://www.roundhillinvestments.com/etf/dram/' : 'https://www.rexshares.com/ram/', asOf } };
}
