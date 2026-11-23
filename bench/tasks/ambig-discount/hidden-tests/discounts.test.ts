import { describe, expect, test } from "vitest";
import { checkoutTotalCents } from "../src/cart.js";
import type { Customer } from "../src/customers.js";

const cart = { items: [{ sku: "a", name: "A", unitCents: 1000, qty: 3 }] };
const customer = (tier: Customer["tier"]): Customer => ({
  id: "c",
  email: "c@example.test",
  tier,
  ordersPlaced: 0,
});

describe("checkoutTotalCents", () => {
  test("standard customers pay the subtotal", () => {
    expect(checkoutTotalCents(cart, customer("standard"))).toBe(3000);
  });

  test("silver gets 5% off", () => {
    expect(checkoutTotalCents(cart, customer("silver"))).toBe(2850);
  });

  test("gold gets 10% off", () => {
    expect(checkoutTotalCents(cart, customer("gold"))).toBe(2700);
  });

  test("the tier discount applies before the coupon", () => {
    expect(checkoutTotalCents({ ...cart, couponCode: "WELCOME10" }, customer("gold"))).toBe(2430);
  });

  test("discounts round down to whole cents", () => {
    const odd = { items: [{ sku: "a", name: "A", unitCents: 999, qty: 1 }] };
    expect(checkoutTotalCents(odd, customer("silver"))).toBe(950);
  });
});
