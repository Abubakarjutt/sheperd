import { type Product, parseRow } from "./row.js";

export interface ProductRepo {
  save(product: Product): Promise<void>;
}

/** Strict import: the first invalid row rejects the whole call. Returns the number saved. */
export async function importProducts(rows: string[][], repo: ProductRepo): Promise<number> {
  let saved = 0;
  for (const row of rows) {
    await repo.save(parseRow(row));
    saved++;
  }
  return saved;
}
