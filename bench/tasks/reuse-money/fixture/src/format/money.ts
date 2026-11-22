const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

/**
 * Formats an integer amount of minor units (cents) for display: symbol, thousands separators,
 * two decimals, and a leading "-" for negative amounts. Unknown currencies print their code.
 */
export function formatCents(cents: number, currency = "USD"): string {
  if (!Number.isInteger(cents)) throw new RangeError(`cents must be an integer, got ${cents}`);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = String(abs % 100).padStart(2, "0");
  const prefix = SYMBOLS[currency] ?? `${currency} `;
  return `${sign}${prefix}${whole}.${frac}`;
}
