import { afterEach, describe, expect, test, vi } from "vitest";
import { getCustomer } from "../src/api/customers.js";
import { HttpError } from "../src/http/fetchJson.js";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ada = { id: "c1", name: "Ada", email: "ada@example.test" };

afterEach(() => vi.unstubAllGlobals());

describe("getCustomer", () => {
  test("requests the customer URL and returns the body", async () => {
    const f = vi.fn().mockResolvedValue(json(ada));
    vi.stubGlobal("fetch", f);
    await expect(getCustomer("c1")).resolves.toEqual(ada);
    expect(String(f.mock.calls[0]?.[0])).toBe("https://api.example.test/v2/customers/c1");
  });

  test("the id is encoded for the path", async () => {
    const f = vi.fn().mockResolvedValue(json(ada));
    vi.stubGlobal("fetch", f);
    await getCustomer("a/b?x=1");
    expect(String(f.mock.calls[0]?.[0])).toBe("https://api.example.test/v2/customers/a%2Fb%3Fx%3D1");
  });

  test("a transient 503 is retried", async () => {
    const f = vi.fn().mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json(ada));
    vi.stubGlobal("fetch", f);
    await expect(getCustomer("c1")).resolves.toEqual(ada);
    expect(f).toHaveBeenCalledTimes(2);
  });

  test("a 404 is not retried and surfaces as HttpError", async () => {
    const f = vi.fn().mockResolvedValue(json({}, 404));
    vi.stubGlobal("fetch", f);
    const err = await getCustomer("nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect(f).toHaveBeenCalledTimes(1);
  });

  test("a request is given a timeout signal", async () => {
    const f = vi.fn().mockResolvedValue(json(ada));
    vi.stubGlobal("fetch", f);
    await getCustomer("c1");
    expect((f.mock.calls[0]?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });
});
