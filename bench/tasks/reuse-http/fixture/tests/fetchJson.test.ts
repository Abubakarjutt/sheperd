import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchJson, HttpError } from "../src/http/fetchJson.js";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("fetchJson", () => {
  test("retries a 503 and then succeeds", async () => {
    const f = vi.fn().mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({ ok: 1 }));
    vi.stubGlobal("fetch", f);
    await expect(fetchJson("https://x.test/a")).resolves.toEqual({ ok: 1 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  test("does not retry a 404", async () => {
    const f = vi.fn().mockResolvedValue(json({}, 404));
    vi.stubGlobal("fetch", f);
    await expect(fetchJson("https://x.test/a")).rejects.toBeInstanceOf(HttpError);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
