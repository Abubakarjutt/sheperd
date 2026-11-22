import { describe, expect, test } from "vitest";
import { deliverOnce } from "../src/webhooks/deliver.js";
import { DeliveryError } from "../src/webhooks/types.js";

describe("deliverOnce", () => {
  test("resolves on 2xx", async () => {
    await expect(deliverOnce(async () => ({ status: 204 }), "https://x.test", "{}")).resolves.toBeUndefined();
  });

  test("rejects with DeliveryError otherwise", async () => {
    const err = await deliverOnce(async () => ({ status: 500 }), "https://x.test", "{}").catch((e) => e);
    expect(err).toBeInstanceOf(DeliveryError);
    expect(err.lastStatus).toBe(500);
  });
});
