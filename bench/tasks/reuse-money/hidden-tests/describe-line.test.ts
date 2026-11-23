import { describe, expect, test } from "vitest";
import { describeLine } from "../src/invoice.js";

describe("describeLine", () => {
  test("the documented example", () => {
    expect(describeLine({ sku: "w", name: "Widget", qty: 3, unitCents: 450 })).toBe(
      "3 × Widget @ $4.50 = $13.50",
    );
  });

  test("thousands separators on both amounts", () => {
    expect(describeLine({ sku: "g", name: "Gadget", qty: 2, unitCents: 123456 })).toBe(
      "2 × Gadget @ $1,234.56 = $2,469.12",
    );
  });

  test("currency symbol", () => {
    expect(describeLine({ sku: "g", name: "Gadget", qty: 1, unitCents: 250 }, "EUR")).toBe(
      "1 × Gadget @ €2.50 = €2.50",
    );
  });

  test("credit lines are negative", () => {
    expect(describeLine({ sku: "r", name: "Refund", qty: 2, unitCents: -500 })).toBe(
      "2 × Refund @ -$5.00 = -$10.00",
    );
  });

  test("small amounts keep two decimals", () => {
    expect(describeLine({ sku: "s", name: "Sticker", qty: 4, unitCents: 5 })).toBe(
      "4 × Sticker @ $0.05 = $0.20",
    );
  });
});
