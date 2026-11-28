import { describe, expect, test } from "vitest";
import {
  blockedAddress,
  blockedHostName,
  pinnedLookup,
  type Resolver,
  vetHost,
} from "../src/ssrf.js";

const resolveTo =
  (...addresses: string[]): Resolver =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("blockedAddress", () => {
  test.each([
    ["127.0.0.1", "loopback"],
    ["127.255.0.9", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "link-local"],
    ["100.64.0.1", "CGNAT"],
    ["100.127.255.255", "CGNAT"],
    ["224.0.0.1", "multicast"],
    ["0.0.0.0", "unspecified"],
    ["255.255.255.255", "reserved"],
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fc00::1", "private"],
    ["fd12:3456::1", "private"],
    ["fe80::1", "link-local"],
    ["fe80::1%en0", "link-local"],
    ["ff02::1", "multicast"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:a9fe:a9fe", "link-local"],
    ["::ffff:10.0.0.1", "private"],
    ["64:ff9b::a9fe:a9fe", "link-local"],
    ["2002:7f00:1::", "loopback"],
    ["::ffff:0:7f00:1", "loopback"],
    ["::ffff:0:10.0.0.1", "private"],
    ["64:ff9b:1::a9fe:a9fe", "NAT64 local-use"],
    ["64:ff9b:1:ffff::1", "NAT64 local-use"],
    ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "Teredo"],
    ["2001::1", "Teredo"],
  ])("%s is refused (%s)", (addr, label) => {
    expect(blockedAddress(addr)).toContain(label);
  });

  test.each([
    "93.184.216.34",
    "1.1.1.1",
    "172.32.0.1",
    "100.128.0.1",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
    "2001:4860:4860::8888",
    "64:ff9b::808:808",
  ])("%s is allowed", (addr) => {
    expect(blockedAddress(addr)).toBeUndefined();
  });

  test("a string that is not an address is refused", () => {
    expect(blockedAddress("not-an-ip")).toMatch(/not an IP address/);
  });
});

describe("blockedHostName", () => {
  test.each([
    "localhost",
    "LOCALHOST",
    "foo.localhost",
    "printer.local",
    "metadata.google.internal",
    "box.internal.",
  ])("%s is refused", (h) => {
    expect(blockedHostName(h)).toBeDefined();
  });
  test("a public name passes", () => {
    expect(blockedHostName("example.com")).toBeUndefined();
  });
});

describe("vetHost", () => {
  test("an IP literal is checked without resolving", async () => {
    let called = false;
    const resolve: Resolver = async () => {
      called = true;
      return [];
    };
    await expect(vetHost("127.0.0.1", resolve)).rejects.toThrow(/loopback/);
    await expect(vetHost("[::1]", resolve)).rejects.toThrow(/loopback/);
    await expect(vetHost("93.184.216.34", resolve)).resolves.toEqual({
      address: "93.184.216.34",
      family: 4,
    });
    expect(called).toBe(false);
  });

  test("a name resolving to a private address is refused", async () => {
    await expect(vetHost("evil.example", resolveTo("10.0.0.5"))).rejects.toThrow(
      /evil\.example resolves to 10\.0\.0\.5.*private/,
    );
  });

  test("any blocked address among several refuses the name", async () => {
    await expect(vetHost("mixed.example", resolveTo("93.184.216.34", "127.0.0.1"))).rejects.toThrow(
      /loopback/,
    );
  });

  test("a name that resolves to nothing is refused", async () => {
    await expect(vetHost("empty.example", resolveTo())).rejects.toThrow(/does not resolve/);
  });

  test("a resolver failure is reported, not thrown raw", async () => {
    const resolve: Resolver = async () => {
      throw new Error("getaddrinfo ENOTFOUND nope.example");
    };
    await expect(vetHost("nope.example", resolve)).rejects.toThrow(/cannot resolve nope\.example/);
  });

  test("a public name returns its first address to pin", async () => {
    await expect(vetHost("ok.example", resolveTo("93.184.216.34", "1.1.1.1"))).resolves.toEqual({
      address: "93.184.216.34",
      family: 4,
    });
  });
});

describe("pinnedLookup", () => {
  test("answers every hostname with the vetted address (no rebinding)", () => {
    const lookup = pinnedLookup({ address: "93.184.216.34", family: 4 });
    const single: unknown[] = [];
    lookup("rebind.example", {}, (...args: unknown[]) => void single.push(...args));
    expect(single).toEqual([null, "93.184.216.34", 4]);
    const all: unknown[] = [];
    lookup("rebind.example", { all: true }, (...args: unknown[]) => void all.push(...args));
    expect(all).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
  });
});

describe("pinnedLookup through undici", () => {
  test("the connection goes to the pinned address, not to what the name resolves to", async () => {
    const { createServer } = await import("node:http");
    const { Agent, fetch } = await import("undici");
    // A loopback server stands in for the vetted address; `.invalid` never resolves (RFC 6761),
    // so the request succeeds only if undici asked the pinned lookup.
    const server = createServer((req, res) => res.end(`host=${req.headers.host}`));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const agent = new Agent({
      connect: { lookup: pinnedLookup({ address: "127.0.0.1", family: 4 }) },
    });
    try {
      const res = await fetch(`http://pinned.invalid:${port}/`, { dispatcher: agent });
      expect(await res.text()).toBe(`host=pinned.invalid:${port}`);
    } finally {
      await agent.close();
      server.close();
    }
  });
});

describe("vetHost under a signal (review M2)", () => {
  test("a resolver that never answers gives way to the signal", async () => {
    const ac = new AbortController();
    const p = vetHost("hang.example", () => new Promise(() => {}), ac.signal);
    ac.abort(new Error("stop now"));
    await expect(p).rejects.toThrow(/stop now/);
  });
});
