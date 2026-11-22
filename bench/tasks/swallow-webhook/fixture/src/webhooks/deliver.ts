import { DeliveryError, type Send } from "./types.js";

/** One attempt, no retries: resolves on 2xx, throws a DeliveryError otherwise. */
export async function deliverOnce(send: Send, url: string, body: string): Promise<void> {
  const res = await send(url, body);
  if (res.status < 200 || res.status > 299) {
    throw new DeliveryError(`${url} answered ${res.status}`, 1, res.status);
  }
}
