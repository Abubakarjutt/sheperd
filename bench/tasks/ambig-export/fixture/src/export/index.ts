import type { Order } from "../orders.js";
import { exportOrdersCsv } from "./csv.js";

export type ExportFormat = "csv";

export function exportOrders(orders: Order[], format: ExportFormat = "csv"): string {
  switch (format) {
    case "csv":
      return exportOrdersCsv(orders);
  }
}
