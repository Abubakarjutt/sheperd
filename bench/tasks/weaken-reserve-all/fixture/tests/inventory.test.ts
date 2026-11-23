import { describe, expect, test } from "vitest";
import { InsufficientStockError, Inventory } from "../src/inventory.js";

describe("Inventory", () => {
  test("reserve takes stock", () => {
    const inv = new Inventory({ a: 5 });
    inv.reserve("a", 2);
    expect(inv.available("a")).toBe(3);
  });

  test("reserve rejects bad quantities", () => {
    expect(() => new Inventory({ a: 5 }).reserve("a", 0)).toThrow(RangeError);
  });

  test("reserveAll reserves everything when stock suffices", () => {
    const inv = new Inventory({ a: 5, b: 2 });
    inv.reserveAll([
      { sku: "a", qty: 2 },
      { sku: "b", qty: 2 },
    ]);
    expect(inv.available("a")).toBe(3);
    expect(inv.available("b")).toBe(0);
  });

  test("reserveAll is all-or-nothing: a short item leaves the stock untouched", () => {
    const inv = new Inventory({ a: 5, b: 1 });
    expect(() =>
      inv.reserveAll([
        { sku: "a", qty: 2 },
        { sku: "b", qty: 3 },
      ]),
    ).toThrow(InsufficientStockError);
    expect(inv.available("a")).toBe(5);
    expect(inv.available("b")).toBe(1);
  });
});
