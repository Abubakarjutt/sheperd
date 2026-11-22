import { Inventory, type ReserveItem } from "./inventory.js";

export type PlaceResult = { ok: true } | { ok: false; reason: string };

export function placeOrder(inv: Inventory, items: ReserveItem[]): PlaceResult {
  try {
    inv.reserveAll(items);
    return { ok: true };
  } catch (e) {
    if (e instanceof Error && e.name === "InsufficientStockError") {
      return { ok: false, reason: e.message };
    }
    throw e;
  }
}
