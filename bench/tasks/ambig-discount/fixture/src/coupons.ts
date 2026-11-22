import { type Cart, subtotalCents } from "./cart.js";

/** Percentage coupons the shop currently runs. */
export const COUPONS: Record<string, number> = { WELCOME10: 10, SPRING15: 15 };

export function couponDiscountCents(cart: Cart): number {
  const pct = cart.couponCode ? (COUPONS[cart.couponCode] ?? 0) : 0;
  return Math.floor((subtotalCents(cart) * pct) / 100);
}
