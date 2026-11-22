import { describe, expect, test } from "vitest";
import { importProducts, type ProductRepo } from "../src/import/products.js";
import { RowError } from "../src/import/row.js";
import type { Product } from "../src/import/row.js";

const memoryRepo = (): ProductRepo & { saved: Product[] } => {
  const saved: Product[] = [];
  return {
    saved,
    async save(p) {
      saved.push(p);
    },
  };
};

describe("importProducts", () => {
  test("saves every valid row", async () => {
    const repo = memoryRepo();
    const n = await importProducts([["AB-1", "Widget", "12.50"], ["AB-2", " Gadget ", "3"]], repo);
    expect(n).toBe(2);
    expect(repo.saved).toEqual([
      { sku: "AB-1", name: "Widget", priceCents: 1250 },
      { sku: "AB-2", name: "Gadget", priceCents: 300 },
    ]);
  });

  test("the first bad row rejects the call", async () => {
    const repo = memoryRepo();
    await expect(importProducts([["AB-1", "W", "1"], ["x", "W", "1"]], repo)).rejects.toBeInstanceOf(
      RowError,
    );
    expect(repo.saved).toHaveLength(1);
  });
});
