import { API_BASE } from "../config.js";
import { fetchJson } from "../http/fetchJson.js";

export type Order = { id: string; total: number; status: "open" | "paid" | "void" };

export function getOrder(id: string): Promise<Order> {
  return fetchJson<Order>(`${API_BASE}/orders/${encodeURIComponent(id)}`);
}

export function listOrders(customerId: string): Promise<Order[]> {
  return fetchJson<Order[]>(`${API_BASE}/orders?customer=${encodeURIComponent(customerId)}`, {
    retries: 1,
  });
}
