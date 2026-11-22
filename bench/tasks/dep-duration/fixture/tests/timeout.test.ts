import { expect, test } from "vitest";
import { describeTimeout } from "../src/time/timeout.js";

test("describeTimeout", () => {
  expect(describeTimeout(undefined)).toBe("timeout: 30s");
  expect(describeTimeout(120_000)).toBe("timeout: 2m");
});
