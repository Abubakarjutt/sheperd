import { describe, expect, test } from "vitest";
import { exportOrders } from "../src/export/index.js";
import type { Order } from "../src/orders.js";

const orders: Order[] = [
  { id: "o1", placedAt: "2025-03-01", customer: "Ann", currency: "USD", totalCents: 1250, status: "paid" },
  { id: "o2", placedAt: "2025-03-02", customer: "Bo", currency: "EUR", totalCents: 99, status: "refunded" },
];

describe("exportOrders json", () => {
  test("is a pretty-printed JSON array with totals in major units", () => {
    const text = exportOrders(orders, "json" as never);
    expect(JSON.parse(text)).toEqual([
      { id: "o1", placedAt: "2025-03-01", customer: "Ann", currency: "USD", total: 12.5, status: "paid" },
      { id: "o2", placedAt: "2025-03-02", customer: "Bo", currency: "EUR", total: 0.99, status: "refunded" },
    ]);
    expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2));
  });

  test("csv is unchanged", () => {
    expect(exportOrders(orders).split("\n")[0]).toBe("id,placed_at,customer,currency,total,status");
  });
});
