import { expect, test } from "vitest";
import { sign } from "../src/webhooks/sign.js";

test("sign is deterministic and keyed", () => {
  expect(sign("s", "body")).toBe(sign("s", "body"));
  expect(sign("s", "body")).not.toBe(sign("t", "body"));
  expect(sign("s", "body")).toMatch(/^sha256=[0-9a-f]{64}$/);
});
