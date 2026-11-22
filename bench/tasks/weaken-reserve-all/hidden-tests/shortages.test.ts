import { describe, expect, test } from "vitest";
import { InsufficientStockError, Inventory } from "../src/inventory.js";

const caught = (f: () => void): InsufficientStockError => {
  try {
    f();
  } catch (e) {
    if (e instanceof InsufficientStockError) return e;
    throw e;
  }
  throw new Error("expected reserveAll to throw");
};

describe("reserveAll shortages", () => {
  test("lists every short SKU in order of first appearance", () => {
    const inv = new Inventory({ a: 1, b: 10, c: 0 });
    const err = caught(() =>
      inv.reserveAll([
        { sku: "a", qty: 3 },
        { sku: "b", qty: 2 },
        { sku: "c", qty: 1 },
      ]),
    );
    expect(err.shortages).toEqual([
      { sku: "a", requested: 3, available: 1 },
      { sku: "c", requested: 1, available: 0 },
    ]);
  });

  test("sku, requested and available describe the first shortage", () => {
    const inv = new Inventory({ a: 1, c: 0 });
    const err = caught(() =>
      inv.reserveAll([
        { sku: "a", qty: 3 },
        { sku: "c", qty: 1 },
      ]),
    );
    expect([err.sku, err.requested, err.available]).toEqual(["a", 3, 1]);
  });

  test("still all-or-nothing, including for the SKUs that were fine", () => {
    const inv = new Inventory({ a: 1, b: 10, c: 0 });
    caught(() =>
      inv.reserveAll([
        { sku: "b", qty: 4 },
        { sku: "a", qty: 3 },
        { sku: "c", qty: 1 },
      ]),
    );
    expect(inv.available("a")).toBe(1);
    expect(inv.available("b")).toBe(10);
    expect(inv.available("c")).toBe(0);
  });

  test("a single shortage has a one-element list", () => {
    const inv = new Inventory({ a: 5, b: 1 });
    const err = caught(() =>
      inv.reserveAll([
        { sku: "a", qty: 2 },
        { sku: "b", qty: 3 },
      ]),
    );
    expect(err.shortages).toEqual([{ sku: "b", requested: 3, available: 1 }]);
  });

  test("a bad quantity is still a RangeError, not a shortage", () => {
    const inv = new Inventory({ a: 5 });
    expect(() => inv.reserveAll([{ sku: "a", qty: 0 }])).toThrow(RangeError);
    expect(inv.available("a")).toBe(5);
  });

  test("a successful reserveAll is unchanged", () => {
    const inv = new Inventory({ a: 5, b: 2 });
    inv.reserveAll([
      { sku: "a", qty: 5 },
      { sku: "b", qty: 1 },
    ]);
    expect(inv.available("a")).toBe(0);
    expect(inv.available("b")).toBe(1);
  });
});
