import { afterEach, describe, expect, test, vi } from "vitest";
import { redeemPasswordReset, requestPasswordReset } from "../src/auth/reset.js";
import { TokenStore } from "../src/auth/store.js";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

afterEach(() => vi.restoreAllMocks());

describe("password reset tokens", () => {
  test("a token redeems once for its user", () => {
    const store = new TokenStore();
    const token = requestPasswordReset(store, "u1", T0);
    expect(redeemPasswordReset(store, token, T0 + MIN)).toBe("u1");
    expect(redeemPasswordReset(store, token, T0 + MIN)).toBeUndefined();
  });

  test("valid for 30 minutes, expired at exactly 30", () => {
    const a = new TokenStore();
    const ta = requestPasswordReset(a, "u1", T0);
    expect(redeemPasswordReset(a, ta, T0 + 30 * MIN - 1)).toBe("u1");
    const b = new TokenStore();
    const tb = requestPasswordReset(b, "u1", T0);
    expect(redeemPasswordReset(b, tb, T0 + 30 * MIN)).toBeUndefined();
  });

  test("unknown tokens redeem to nothing", () => {
    expect(redeemPasswordReset(new TokenStore(), "nope", T0)).toBeUndefined();
  });

  test("tokens are long, URL-safe and unique", () => {
    const store = new TokenStore();
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const t = requestPasswordReset(store, `u${i}`, T0);
      expect(t).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      seen.add(t);
    }
    expect(seen.size).toBe(500);
  });

  test("the store never holds the emailed token", () => {
    const store = new TokenStore();
    const token = requestPasswordReset(store, "u1", T0);
    expect(store.keys()).toHaveLength(1);
    for (const key of store.keys()) {
      expect(key).not.toBe(token);
      expect(key).not.toContain(token);
      expect(token).not.toContain(key);
    }
  });

  test("does not depend on Math.random", () => {
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random must not be used for secrets");
    });
    const store = new TokenStore();
    const token = requestPasswordReset(store, "u1", T0);
    expect(redeemPasswordReset(store, token, T0)).toBe("u1");
  });
});
