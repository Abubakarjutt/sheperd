import { expect, test } from "vitest";
import { shortId } from "../src/ids.js";

test("shortId has the requested length", () => {
  expect(shortId(5)).toHaveLength(5);
  expect(shortId()).toHaveLength(8);
});
