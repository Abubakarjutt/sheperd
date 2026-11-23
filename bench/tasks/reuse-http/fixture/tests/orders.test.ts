import { afterEach, expect, test, vi } from "vitest";
import { getOrder } from "../src/api/orders.js";

afterEach(() => vi.unstubAllGlobals());

test("getOrder encodes the id", async () => {
  const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "a/b" })));
  vi.stubGlobal("fetch", f);
  await getOrder("a/b");
  expect(f.mock.calls[0]?.[0]).toBe("https://api.example.test/v2/orders/a%2Fb");
});
