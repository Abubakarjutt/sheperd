import type { Order } from "../orders.js";

const HEADER = ["id", "placed_at", "customer", "currency", "total", "status"];

function cell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** The legacy flat CSV: one row per order, total in major units with two decimals. */
export function exportOrdersCsv(orders: Order[]): string {
  const rows = orders.map((o) =>
    [o.id, o.placedAt, o.customer, o.currency, (o.totalCents / 100).toFixed(2), o.status]
      .map(cell)
      .join(","),
  );
  return [HEADER.join(","), ...rows].join("\n");
}
