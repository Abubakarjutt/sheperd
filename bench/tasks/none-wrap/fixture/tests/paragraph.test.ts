import { expect, test } from "vitest";
import { wrapParagraphs } from "../src/text/paragraph.js";

test("wrapParagraphs keeps paragraph breaks", () => {
  expect(wrapParagraphs("one two three\n\nfour", 8)).toBe("one two\nthree\n\nfour");
});
