export type ReserveItem = { sku: string; qty: number };

export class InsufficientStockError extends Error {
  constructor(
    readonly sku: string,
    readonly requested: number,
    readonly available: number,
  ) {
    super(`insufficient stock for ${sku}: requested ${requested}, available ${available}`);
    this.name = "InsufficientStockError";
  }
}

export class Inventory {
  private readonly stock = new Map<string, number>();

  constructor(initial: Record<string, number> = {}) {
    for (const [sku, qty] of Object.entries(initial)) this.stock.set(sku, qty);
  }

  available(sku: string): number {
    return this.stock.get(sku) ?? 0;
  }

  reserve(sku: string, qty: number): void {
    if (!Number.isInteger(qty) || qty <= 0) throw new RangeError(`bad quantity: ${qty}`);
    const have = this.available(sku);
    if (qty > have) throw new InsufficientStockError(sku, qty, have);
    this.stock.set(sku, have - qty);
  }

  release(sku: string, qty: number): void {
    this.stock.set(sku, this.available(sku) + qty);
  }

  /** All-or-nothing: either every item is reserved or the stock is left exactly as it was. */
  reserveAll(items: ReserveItem[]): void {
    const done: ReserveItem[] = [];
    try {
      for (const item of items) {
        this.reserve(item.sku, item.qty);
        done.push(item);
      }
    } catch (e) {
      for (const d of done) this.release(d.sku, d.qty);
      throw e;
    }
  }
}
