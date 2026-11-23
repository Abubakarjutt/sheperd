import { couponDiscountCents } from "./coupons.js";

export type CartItem = { sku: string; name: string; unitCents: number; qty: number };
export type Cart = { items: CartItem[]; couponCode?: string };

export function subtotalCents(cart: Cart): number {
  return cart.items.reduce((sum, i) => sum + i.unitCents * i.qty, 0);
}

export function totalCents(cart: Cart): number {
  return subtotalCents(cart) - couponDiscountCents(cart);
}
