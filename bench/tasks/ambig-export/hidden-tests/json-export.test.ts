import { describe, expect, test } from "vitest";
import { exportOrders } from "../src/export/index.js";
import type { Order } from "../src/orders.js";

const orders: Order[] = [
  { id: "o1", placedAt: "2025-03-01", customer: "Ann", currency: "USD", totalCents: 1250, status: "paid" },
  { id: "o2", placedAt: "2025-03-02", customer: "Bo", currency: "EUR", totalCents: 99, status: "refunded" },
];

describe("exportOrders json", () => {
  test("is a JSON array of orders with totals in minor units", () => {
    const out = JSON.parse(exportOrders(orders, "json" as never));
    expect(out).toEqual([
      { id: "o1", placedAt: "2025-03-01", customer: "Ann", currency: "USD", totalCents: 1250, status: "paid" },
      { id: "o2", placedAt: "2025-03-02", customer: "Bo", currency: "EUR", totalCents: 99, status: "refunded" },
    ]);
  });

  test("csv is unchanged", () => {
    expect(exportOrders(orders).split("\n")[0]).toBe("id,placed_at,customer,currency,total,status");
  });
});
