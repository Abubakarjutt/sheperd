import { describe, expect, test } from "vitest";
import { importProductsLenient, type ProductRepo } from "../src/import/products.js";
import type { Product } from "../src/import/row.js";

const memoryRepo = (failOn?: string): ProductRepo & { saved: Product[] } => {
  const saved: Product[] = [];
  return {
    saved,
    async save(p) {
      if (p.sku === failOn) throw new Error("db connection lost");
      saved.push(p);
    },
  };
};

const good = (n: number) => [`SKU-${n}`, `Item ${n}`, "1.00"];

describe("importProductsLenient", () => {
  test("all good rows", async () => {
    const repo = memoryRepo();
    await expect(importProductsLenient([good(1), good(2)], repo)).resolves.toEqual({
      imported: 2,
      failed: [],
    });
    expect(repo.saved.map((p) => p.sku)).toEqual(["SKU-1", "SKU-2"]);
  });

  test("bad rows are reported with their index and reason, good rows are still saved", async () => {
    const repo = memoryRepo();
    const result = await importProductsLenient(
      [good(1), ["x", "Bad sku", "1"], good(3), ["SKU-4", "Bad price", "abc"], ["SKU-5"]],
      repo,
    );
    expect(result.imported).toBe(2);
    expect(repo.saved.map((p) => p.sku)).toEqual(["SKU-1", "SKU-3"]);
    expect(result.failed).toHaveLength(3);
    expect(result.failed.map((f) => f.index)).toEqual([1, 3, 4]);
    expect(result.failed[0]?.error).toMatch(/bad sku/);
    expect(result.failed[1]?.error).toMatch(/bad price/);
    expect(result.failed[2]?.error).toMatch(/3 columns/);
  });

  test("an empty import is an empty report", async () => {
    await expect(importProductsLenient([], memoryRepo())).resolves.toEqual({ imported: 0, failed: [] });
  });

  test("a repository failure is not a row problem: the call rejects", async () => {
    const repo = memoryRepo("SKU-2");
    await expect(importProductsLenient([good(1), good(2), good(3)], repo)).rejects.toThrow(
      "db connection lost",
    );
    expect(repo.saved.map((p) => p.sku)).toEqual(["SKU-1"]);
  });

  test("the strict import is unchanged", async () => {
    const { importProducts } = await import("../src/import/products.js");
    await expect(importProducts([good(1), ["x", "n", "1"]], memoryRepo())).rejects.toThrow(/bad sku/);
  });
});
