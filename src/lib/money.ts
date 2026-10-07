// All money is stored as integer cents to avoid floating-point drift.
export type Cents = number;

/** Parse user input such as "12", "12.5", "$1,234.56", "-3.20" into cents. Returns null if invalid. */
export function parseCents(input: string): Cents | null {
  const s = input.trim().replace(/[$,\s]/g, '');
  const m = /^(-)?(\d+)(?:\.(\d{0,2}))?$/.exec(s) ?? /^(-)?()\.(\d{1,2})$/.exec(s);
  if (!m) return null;
  const whole = m[2] ? Number(m[2]) : 0;
  const frac = Number((m[3] ?? '').padEnd(2, '0'));
  const value = whole * 100 + frac;
  if (!Number.isSafeInteger(value)) return null;
  return m[1] ? -value : value;
}

/** "1234.5" style plain decimal, used in Beancount output. */
export function centsToDecimal(c: Cents): string {
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** "$1,234.50" for display. */
export function formatUSD(c: Cents): string {
  return usd.format(c / 100);
}
