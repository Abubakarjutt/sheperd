import { describe, expect, test } from "vitest";
import { exportOrders } from "../src/export/index.js";
import type { Order } from "../src/orders.js";

const orders: Order[] = [
  { id: "o1", placedAt: "2025-03-01", customer: "Ann, Lee", currency: "USD", totalCents: 1250, status: "paid" },
  { id: "o2", placedAt: "2025-03-02", customer: "Bo", currency: "EUR", totalCents: 99, status: "open" },
];

describe("exportOrders csv", () => {
  test("header and rows", () => {
    expect(exportOrders(orders).split("\n")).toEqual([
      "id,placed_at,customer,currency,total,status",
      'o1,2025-03-01,"Ann, Lee",USD,12.50,paid',
      "o2,2025-03-02,Bo,EUR,0.99,open",
    ]);
  });
});
