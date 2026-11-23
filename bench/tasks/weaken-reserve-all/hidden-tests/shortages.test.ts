import { describe, expect, test } from "vitest";
import { Inventory } from "../src/inventory.js";
import { placeOrder } from "../src/orders.js";

describe("reserveAll is best-effort", () => {
  test("reserves what it can and reports the rest", () => {
    const inv = new Inventory({ a: 5, b: 1, c: 0 });
    const r = inv.reserveAll([
      { sku: "a", qty: 2 },
      { sku: "b", qty: 3 },
      { sku: "c", qty: 1 },
    ]);
    expect(r.reserved).toEqual([{ sku: "a", qty: 2 }]);
    expect(r.short).toEqual([
      { sku: "b", requested: 3, available: 1 },
      { sku: "c", requested: 1, available: 0 },
    ]);
    expect(inv.available("a")).toBe(3);
    expect(inv.available("b")).toBe(1);
  });

  test("no shortages means everything is reserved", () => {
    const inv = new Inventory({ a: 5, b: 2 });
    const r = inv.reserveAll([
      { sku: "a", qty: 2 },
      { sku: "b", qty: 2 },
    ]);
    expect(r.short).toEqual([]);
    expect(r.reserved).toHaveLength(2);
    expect(inv.available("b")).toBe(0);
  });

  test("a repeated SKU sees the stock its earlier item used", () => {
    const inv = new Inventory({ a: 3 });
    const r = inv.reserveAll([
      { sku: "a", qty: 2 },
      { sku: "a", qty: 2 },
    ]);
    expect(r.reserved).toEqual([{ sku: "a", qty: 2 }]);
    expect(r.short).toEqual([{ sku: "a", requested: 2, available: 1 }]);
    expect(inv.available("a")).toBe(1);
  });

  test("a bad quantity throws before anything is reserved", () => {
    const inv = new Inventory({ a: 5 });
    expect(() =>
      inv.reserveAll([
        { sku: "a", qty: 2 },
        { sku: "b", qty: 0 },
      ]),
    ).toThrow(RangeError);
    expect(inv.available("a")).toBe(5);
  });
});

describe("placeOrder", () => {
  test("lists every short SKU and keeps the rest reserved", () => {
    const inv = new Inventory({ a: 5, b: 1, c: 0 });
    const r = placeOrder(inv, [
      { sku: "a", qty: 2 },
      { sku: "b", qty: 3 },
      { sku: "c", qty: 1 },
    ]);
    expect(r).toEqual({
      ok: false,
      reason: "b (requested 3, available 1), c (requested 1, available 0)",
    });
    expect(inv.available("a")).toBe(3);
  });

  test("ok when nothing is short", () => {
    expect(placeOrder(new Inventory({ a: 2 }), [{ sku: "a", qty: 2 }])).toEqual({ ok: true });
  });
});
