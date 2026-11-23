import { expect, test } from "vitest";
import { padEnd } from "../src/text/pad.js";

test("padEnd counts characters, not code units", () => {
  expect(padEnd("👍", 3, ".")).toBe("👍..");
  expect(padEnd("abc", 2)).toBe("abc");
});
