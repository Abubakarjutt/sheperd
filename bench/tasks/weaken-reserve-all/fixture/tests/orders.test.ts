import { expect, test } from "vitest";
import { Inventory } from "../src/inventory.js";
import { placeOrder } from "../src/orders.js";

test("placeOrder reports a shortage instead of throwing", () => {
  const inv = new Inventory({ a: 1 });
  const r = placeOrder(inv, [{ sku: "a", qty: 2 }]);
  expect(r.ok).toBe(false);
});
