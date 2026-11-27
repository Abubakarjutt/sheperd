import { describe, expect, test } from "vitest";
import { USER_AGENT, type WebFetchFn, type WebRequestInit, webFetch } from "../src/fetch.js";
import type { Resolver } from "../src/ssrf.js";

const PUBLIC = "93.184.216.34";

/** Every name resolves to the public test address unless listed. */
const resolver =
  (map: Record<string, string[]> = {}): Resolver =>
  async (host) =>
    (map[host] ?? [PUBLIC]).map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));

type Call = { url: string; init: WebRequestInit };

function fake(responses: Record<string, () => Response>): { fetchFn: WebFetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: WebFetchFn = async (url, init) => {
    calls.push({ url, init });
    const r = responses[url];
    if (r === undefined) throw new Error(`unexpected fetch ${url}`);
    return r();
  };
  return { fetchFn, calls };
}

const html =
  (body: string, headers: Record<string, string> = {}) =>
  () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", ...headers },
    });

describe("webFetch request", () => {
  test("a direct GET with a fixed User-Agent, manual redirects and a pinned dispatcher", async () => {
    const { fetchFn, calls } = fake({ "https://example.com/": html("<p>hi</p>") });
    const r = await webFetch("https://example.com/", { fetchFn, resolve: resolver() });
    expect(r).toEqual({
      url: "https://example.com/",
      status: 200,
      contentType: "text/html",
      text: "hi",
      truncated: false,
    });
    expect(calls).toHaveLength(1);
    const init = calls[0]?.init;
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(init?.headers).toEqual({ "user-agent": USER_AGENT, accept: expect.any(String) });
    expect(USER_AGENT).toMatch(/^rewire\/\S+$/);
    expect(init?.dispatcher).toBeDefined();
  });

  test("HTML keeps link targets", async () => {
    const { fetchFn } = fake({
      "https://example.com/a": html('<p>Read <a href="/b">more</a></p>'),
    });
    const r = await webFetch("https://example.com/a", { fetchFn, resolve: resolver() });
    expect(r.text).toBe("Read more (https://example.com/b)");
  });

  test("JSON and plain text pass through; a non-2xx status is returned, not thrown", async () => {
    const { fetchFn } = fake({
      "https://example.com/j": () =>
        new Response('{"a":1}', { headers: { "content-type": "application/vnd.api+json" } }),
      "https://example.com/missing": () =>
        new Response("not here", { status: 404, headers: { "content-type": "text/plain" } }),
    });
    const j = await webFetch("https://example.com/j", { fetchFn, resolve: resolver() });
    expect(j.text).toBe('{"a":1}');
    const m = await webFetch("https://example.com/missing", { fetchFn, resolve: resolver() });
    expect(m).toMatchObject({ status: 404, text: "not here" });
  });

  test("a non-text type is refused, naming the type", async () => {
    const { fetchFn } = fake({
      "https://example.com/x.png": () =>
        new Response("\x89PNG", { headers: { "content-type": "image/png" } }),
      "https://example.com/none": () => new Response("??"),
    });
    await expect(
      webFetch("https://example.com/x.png", { fetchFn, resolve: resolver() }),
    ).rejects.toThrow(/image\/png/);
    const noType = fake({
      "https://example.com/none": () => {
        const r = new Response("??");
        r.headers.delete("content-type");
        return r;
      },
    });
    await expect(
      webFetch("https://example.com/none", { fetchFn: noType.fetchFn, resolve: resolver() }),
    ).rejects.toThrow(/no content type/);
  });

  test("a non-UTF-8 charset is decoded", async () => {
    const { fetchFn } = fake({
      "https://example.com/l1": () =>
        new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
          headers: { "content-type": "text/plain; charset=iso-8859-1" },
        }),
    });
    const r = await webFetch("https://example.com/l1", { fetchFn, resolve: resolver() });
    expect(r.text).toBe("café");
  });
});

describe("webFetch URL checks", () => {
  const never: WebFetchFn = async () => {
    throw new Error("must not fetch");
  };
  test.each([
    ["ftp://example.com/", /only http and https/],
    ["file:///etc/passwd", /only http and https/],
    ["not a url", /not a valid URL/],
    ["https://user:pw@example.com/", /credentials/],
    [`https://example.com/${"a".repeat(2049)}`, /2048/],
    ["https://example.com/?key=sk-ant-api03-abcdefghijklmnop", /secret/],
    ["https://example.com/?key=sk%2Dant%2Dabcdefghijklmnop", /secret/],
  ])("%s is refused", async (url, why) => {
    await expect(webFetch(url, { fetchFn: never, resolve: resolver() })).rejects.toThrow(why);
  });

  test("a policy refusal names the rule and nothing is fetched", async () => {
    await expect(
      webFetch("https://blocked.example/", {
        fetchFn: never,
        resolve: resolver(),
        isAllowed: (host) =>
          host === "blocked.example" ? "deny_domains: blocked.example" : undefined,
      }),
    ).rejects.toThrow(/deny_domains: blocked\.example/);
  });
});

describe("webFetch SSRF (review focus 1)", () => {
  const never: WebFetchFn = async () => {
    throw new Error("must not fetch");
  };
  test.each([
    ["http://127.0.0.1:11434", /loopback/],
    ["http://169.254.169.254/latest/meta-data", /link-local/],
    ["http://[::1]/", /loopback/],
    ["http://[::ffff:127.0.0.1]/", /loopback/],
    ["http://0x7f000001/", /loopback/],
    ["http://2130706433/", /loopback/],
    ["http://0177.0.0.1/", /loopback/],
    ["http://127.1/", /loopback/],
    ["http://10.0.0.1/", /private/],
    ["http://localhost:3000/", /localhost/],
    ["http://printer.local/", /\.local/],
    ["http://metadata.google.internal/", /\.internal/],
  ])("%s is refused", async (url, why) => {
    await expect(webFetch(url, { fetchFn: never, resolve: resolver() })).rejects.toThrow(why);
  });

  test("a DNS name that resolves to a private IP is refused", async () => {
    await expect(
      webFetch("https://internal.example.com/", {
        fetchFn: never,
        resolve: resolver({ "internal.example.com": ["192.168.0.10"] }),
      }),
    ).rejects.toThrow(/resolves to 192\.168\.0\.10/);
  });

  test("a public host that redirects to a private one is refused at the hop", async () => {
    const { fetchFn, calls } = fake({
      "https://public.example/": () =>
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }),
    });
    await expect(
      webFetch("https://public.example/", { fetchFn, resolve: resolver() }),
    ).rejects.toThrow(/link-local/);
    expect(calls.map((c) => c.url)).toEqual(["https://public.example/"]);
  });

  test("a redirect to a name that resolves privately is refused (each hop is re-resolved)", async () => {
    const { fetchFn } = fake({
      "https://public.example/": () =>
        new Response(null, { status: 301, headers: { location: "https://sneaky.example/x" } }),
    });
    await expect(
      webFetch("https://public.example/", {
        fetchFn,
        resolve: resolver({ "sneaky.example": ["10.9.9.9"] }),
      }),
    ).rejects.toThrow(/sneaky\.example resolves to 10\.9\.9\.9/);
  });

  test("relative redirects are followed, re-checked by policy, and the final URL is reported", async () => {
    const seen: string[] = [];
    const { fetchFn, calls } = fake({
      "https://a.example/start": () =>
        new Response(null, { status: 307, headers: { location: "/next" } }),
      "https://a.example/next": () =>
        new Response(null, { status: 308, headers: { location: "https://b.example/end" } }),
      "https://b.example/end": () =>
        new Response("done", { headers: { "content-type": "text/plain" } }),
    });
    const r = await webFetch("https://a.example/start", {
      fetchFn,
      resolve: resolver(),
      isAllowed: (h) => {
        seen.push(h);
        return undefined;
      },
    });
    expect(r).toMatchObject({ url: "https://b.example/end", text: "done" });
    expect(calls).toHaveLength(3);
    expect(seen).toEqual(["a.example", "a.example", "b.example"]);
  });

  test("a redirect that the policy refuses stops there", async () => {
    const { fetchFn } = fake({
      "https://a.example/": () =>
        new Response(null, { status: 302, headers: { location: "https://denied.example/" } }),
    });
    await expect(
      webFetch("https://a.example/", {
        fetchFn,
        resolve: resolver(),
        isAllowed: (h) => (h === "denied.example" ? "deny_domains" : undefined),
      }),
    ).rejects.toThrow(/deny_domains/);
  });

  test("a redirect to a URL carrying a secret is refused", async () => {
    const { fetchFn } = fake({
      "https://a.example/": () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://b.example/?t=ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
        }),
    });
    await expect(webFetch("https://a.example/", { fetchFn, resolve: resolver() })).rejects.toThrow(
      /secret/,
    );
  });

  test("more than 5 redirects is refused", async () => {
    const responses: Record<string, () => Response> = {};
    for (let i = 0; i < 7; i++) {
      responses[`https://loop.example/${i}`] = () =>
        new Response(null, { status: 302, headers: { location: `/${i + 1}` } });
    }
    const { fetchFn, calls } = fake(responses);
    await expect(
      webFetch("https://loop.example/0", { fetchFn, resolve: resolver() }),
    ).rejects.toThrow(/more than 5 redirects/);
    expect(calls).toHaveLength(6);
  });
});

describe("webFetch caps", () => {
  test("the body read stops at the byte cap and says it was truncated", async () => {
    const { fetchFn } = fake({
      "https://big.example/": () =>
        new Response("x".repeat(10_000), { headers: { "content-type": "text/plain" } }),
    });
    const r = await webFetch("https://big.example/", {
      fetchFn,
      resolve: resolver(),
      maxBytes: 1000,
    });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(1000);
  });

  test("the text output stops at the character cap", async () => {
    const { fetchFn } = fake({
      "https://big.example/": () =>
        new Response("y".repeat(200_000), { headers: { "content-type": "text/plain" } }),
    });
    const r = await webFetch("https://big.example/", { fetchFn, resolve: resolver() });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(100_000);
  });

  test("the defaults are 5 MB read and 100,000 characters", async () => {
    let served = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(0x7a);
    const { fetchFn } = fake({
      "https://huge.example/": () =>
        new Response(
          new ReadableStream({
            pull(c) {
              served++;
              if (served > 20) c.close();
              else c.enqueue(chunk);
            },
          }),
          { headers: { "content-type": "text/plain" } },
        ),
    });
    const r = await webFetch("https://huge.example/", { fetchFn, resolve: resolver() });
    expect(r.truncated).toBe(true);
    expect(served).toBeLessThanOrEqual(7);
  });

  test("a response that never arrives times out", async () => {
    const fetchFn: WebFetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    await expect(
      webFetch("https://slow.example/", { fetchFn, resolve: resolver(), timeoutMs: 50 }),
    ).rejects.toThrow(/timed out after/);
  });

  test("a body that stalls times out", async () => {
    const { fetchFn } = fake({
      "https://stall.example/": () =>
        new Response(new ReadableStream({ pull() {} }), {
          headers: { "content-type": "text/plain" },
        }),
    });
    await expect(
      webFetch("https://stall.example/", { fetchFn, resolve: resolver(), timeoutMs: 50 }),
    ).rejects.toThrow(/timed out after/);
  });

  test("the caller's abort is an abort, not a timeout", async () => {
    const ac = new AbortController();
    const fetchFn: WebFetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
        ac.abort();
      });
    await expect(
      webFetch("https://slow.example/", { fetchFn, resolve: resolver(), signal: ac.signal }),
    ).rejects.toThrow(/abort/i);
  });
});
