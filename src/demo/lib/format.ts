// Formatting helpers for the Arco demo. Every value produced here is meant to
// be rendered in a monospace font (amounts / APY / token qty / addresses).

/** USD with thousands separators and 2 decimals, e.g. money(4321.78) => "$4,321.78". */
export function money(n: number): string {
  return (
    '$' +
    n.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  )
}

/** Token amount + symbol, e.g. token(1.2, 'aETH') => "1.2 aETH". */
export function token(n: number, sym: string): string {
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${sym}`
}

/** Percent with 2 decimals, e.g. pct(5.12) => "5.12%". */
export function pct(n: number): string {
  return n.toFixed(2) + '%'
}

/** Truncate a hash/address for display, e.g. "0x71C7…976F". */
export function shortAddr(addr: string, lead = 6, tail = 4): string {
  if (!addr) return ''
  if (addr.length <= lead + tail + 1) return addr
  return `${addr.slice(0, lead)}…${addr.slice(-tail)}`
}
