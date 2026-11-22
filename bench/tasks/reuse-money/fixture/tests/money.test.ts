import { describe, expect, test } from "vitest";
import { formatCents } from "../src/format/money.js";

describe("formatCents", () => {
  test("pads cents", () => {
    expect(formatCents(5)).toBe("$0.05");
  });

  test("adds thousands separators", () => {
    expect(formatCents(123456789)).toBe("$1,234,567.89");
  });

  test("negative amounts", () => {
    expect(formatCents(-1999)).toBe("-$19.99");
  });

  test("other currencies", () => {
    expect(formatCents(250, "EUR")).toBe("€2.50");
    expect(formatCents(250, "CHF")).toBe("CHF 2.50");
  });

  test("rejects fractional cents", () => {
    expect(() => formatCents(1.5)).toThrow(RangeError);
  });
});
