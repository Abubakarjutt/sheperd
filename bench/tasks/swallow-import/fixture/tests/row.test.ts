import { describe, expect, test } from "vitest";
import { parseRow, RowError } from "../src/import/row.js";

describe("parseRow", () => {
  test("parses a good row", () => {
    expect(parseRow(["ABC-1", "Thing", "0.99"])).toEqual({
      sku: "ABC-1",
      name: "Thing",
      priceCents: 99,
    });
  });

  test.each([
    [["ABC-1", "Thing"], /3 columns/],
    [["a", "Thing", "1"], /bad sku/],
    [["ABC-1", " ", "1"], /name/],
    [["ABC-1", "Thing", "1.999"], /bad price/],
  ])("rejects %j", (row, message) => {
    expect(() => parseRow(row as string[])).toThrow(RowError);
    expect(() => parseRow(row as string[])).toThrow(message);
  });
});
