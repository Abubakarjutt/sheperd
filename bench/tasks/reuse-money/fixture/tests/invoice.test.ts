import { describe, expect, test } from "vitest";
import { invoiceTotalCents, renderTotalRow } from "../src/invoice.js";

const lines = [
  { sku: "w", name: "Widget", qty: 3, unitCents: 450 },
  { sku: "g", name: "Gadget", qty: 1, unitCents: 1000 },
];

describe("invoice", () => {
  test("total", () => {
    expect(invoiceTotalCents(lines)).toBe(2350);
  });

  test("total row", () => {
    expect(renderTotalRow(lines)).toBe("TOTAL $23.50");
  });
});
