import { describe, expect, test } from "vitest";
import { TokenStore } from "../src/auth/store.js";

describe("TokenStore", () => {
  test("take consumes the row", () => {
    const s = new TokenStore();
    s.put("k", { userId: "u", expiresAt: 5 });
    expect(s.take("k")).toEqual({ userId: "u", expiresAt: 5 });
    expect(s.take("k")).toBeUndefined();
    expect(s.keys()).toEqual([]);
  });
});
