import { MarketDataError } from './contracts.js';

// Numeric JSON tokens never pass through a JavaScript Number. Strings and numbers
// remain distinguishable so a provider cannot silently change its schema.
export class JsonNumber { constructor(readonly lexeme: string) {} }
export function parseExactJson(text: string): unknown {
  let i = 0;
  const bad = (): never => { throw new MarketDataError('INVALID_RESPONSE'); };
  const ws = () => { while (/[\x20\t\r\n]/.test(text[i] ?? '\0')) i++; };
  const string = (): string => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') { try { return JSON.parse(text.slice(start, i)) as string; } catch { return bad(); } }
    }
    return bad();
  };
  const value = (depth: number): unknown => {
    if (depth > 32) return bad();
    ws(); const c = text[i];
    if (c === '"') return string();
    if (c === '{') {
      i++; ws(); const out: Record<string, unknown> = Object.create(null);
      if (text[i] === '}') { i++; return out; }
      while (i < text.length) {
        ws(); if (text[i] !== '"') return bad();
        const key = string(); if (Object.prototype.hasOwnProperty.call(out, key)) return bad();
        ws(); if (text[i++] !== ':') return bad(); out[key] = value(depth + 1); ws();
        const next = text[i++]; if (next === '}') return out; if (next !== ',') return bad();
      }
      return bad();
    }
    if (c === '[') {
      i++; ws(); const out: unknown[] = [];
      if (text[i] === ']') { i++; return out; }
      while (i < text.length) { out.push(value(depth + 1)); ws(); const next = text[i++]; if (next === ']') return out; if (next !== ',') return bad(); }
      return bad();
    }
    for (const [literal, v] of [['true', true], ['false', false], ['null', null]] as const) if (text.startsWith(literal, i)) { i += literal.length; return v; }
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!token || token[0].length > 100) return bad();
    i += token[0].length; return new JsonNumber(token[0]);
  };
  const result = value(0); ws(); if (i !== text.length) return bad(); return result;
}
export function decimal(input: unknown, signed = false): string {
  if (!(input instanceof JsonNumber)) throw new MarketDataError('INVALID_RESPONSE');
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(input.lexeme);
  if (!m) throw new MarketDataError('INVALID_RESPONSE');
  const exponent = Number(m[4] ?? '0');
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 48) throw new MarketDataError('INVALID_RESPONSE');
  let digits = m[2] + (m[3] ?? ''); let point = m[2].length + exponent;
  if (point <= 0) { digits = '0'.repeat(1 - point) + digits; point = 1; }
  if (point >= digits.length) digits += '0'.repeat(point - digits.length);
  const whole = (digits.slice(0, point) || '0').replace(/^0+(?=\d)/, '');
  const fraction = digits.slice(point).replace(/0+$/, '');
  if (whole.length > 30 || fraction.length > 18 || (!signed && m[1] === '-' && (whole !== '0' || fraction))) throw new MarketDataError('INVALID_RESPONSE');
  const negative = m[1] === '-' && (whole !== '0' || fraction) ? '-' : '';
  return negative + whole + (fraction ? '.' + fraction : '');
}
export function scaled(value: string): bigint {
  const negative = value.startsWith('-'); const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return (BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'))) * (negative ? -1n : 1n);
}
export function integer(input: unknown): bigint {
  const s = decimal(input); if (s.includes('.')) throw new MarketDataError('INVALID_RESPONSE'); return BigInt(s);
}
export function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input instanceof JsonNumber) throw new MarketDataError('INVALID_RESPONSE');
  return input as Record<string, unknown>;
}
export function optionalDecimal(input: unknown, signed = false): string | null { return input == null ? null : decimal(input, signed); }
