export type Product = { sku: string; name: string; priceCents: number };

export class RowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RowError";
  }
}

/** Parses one CSV-ish row `[sku, name, price]` where price is a decimal such as "12.50". */
export function parseRow(row: string[]): Product {
  const [sku, name, price] = row;
  if (row.length !== 3) throw new RowError(`expected 3 columns, got ${row.length}`);
  if (!sku || !/^[A-Z0-9-]{3,20}$/.test(sku)) throw new RowError(`bad sku: ${sku ?? ""}`);
  if (!name?.trim()) throw new RowError("name must not be empty");
  if (!price || !/^\d+(\.\d{1,2})?$/.test(price)) throw new RowError(`bad price: ${price ?? ""}`);
  return { sku, name: name.trim(), priceCents: Math.round(Number(price) * 100) };
}
