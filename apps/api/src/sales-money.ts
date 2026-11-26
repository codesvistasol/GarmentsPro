export function cents(value: { toFixed(places: number): string } | string) {
  const text = typeof value === 'string' ? value : value.toFixed(2);
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -amount : amount;
}

export function decimal(value: bigint) {
  const amount = value < 0n ? -value : value;
  const fraction = (amount % 100n).toString().padStart(2, '0');
  return (value < 0n ? '-' : '') + (amount / 100n).toString() + '.' + fraction;
}

// Allocate any rounding remainder across the full line, even across multiple postings.
export function allocate(total: bigint, ordered: number, alreadyPosted: number, quantity: number) {
  const cumulative = (units: number) => total * BigInt(units) / BigInt(ordered);
  return cumulative(alreadyPosted + quantity) - cumulative(alreadyPosted);
}
