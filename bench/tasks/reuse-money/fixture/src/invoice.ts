import { formatCents } from "./format/money.js";

export type Line = { sku: string; name: string; qty: number; unitCents: number };

export function lineTotalCents(line: Line): number {
  return line.qty * line.unitCents;
}

export function invoiceTotalCents(lines: Line[]): number {
  return lines.reduce((sum, l) => sum + lineTotalCents(l), 0);
}

export function renderTotalRow(lines: Line[], currency = "USD"): string {
  return `TOTAL ${formatCents(invoiceTotalCents(lines), currency)}`;
}
