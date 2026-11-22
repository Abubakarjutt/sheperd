import { describe, expect, test } from "vitest";
import { subtotalCents, totalCents } from "../src/cart.js";

const cart = {
  items: [
    { sku: "a", name: "A", unitCents: 1000, qty: 2 },
    { sku: "b", name: "B", unitCents: 550, qty: 1 },
  ],
};

describe("cart", () => {
  test("subtotal", () => {
    expect(subtotalCents(cart)).toBe(2550);
  });

  test("a coupon takes a percentage off", () => {
    expect(totalCents({ ...cart, couponCode: "WELCOME10" })).toBe(2295);
  });

  test("unknown coupons are ignored", () => {
    expect(totalCents({ ...cart, couponCode: "NOPE" })).toBe(2550);
  });
});
