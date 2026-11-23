import type { Order } from "../orders.js";

const HEADER = ["id", "placed_at", "customer", "currency", "total", "status"];

function cell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** The legacy flat CSV: one row per order. `total` is the raw minor-unit amount (cents), as the ledger import reads it. */
export function exportOrdersCsv(orders: Order[]): string {
  const rows = orders.map((o) =>
    [o.id, o.placedAt, o.customer, o.currency, String(o.totalCents), o.status]
      .map(cell)
      .join(","),
  );
  return [HEADER.join(","), ...rows].join("\n");
}
