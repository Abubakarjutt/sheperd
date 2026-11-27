import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { WebError } from "./error.js";

/** One resolved address. */
export type ResolvedAddress = { address: string; family: 4 | 6 };

/** Resolves a host name to every address it has (injectable so tests never touch DNS). */
export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

/** `dns.promises.lookup` with `all: true`: what the OS resolver would connect to. */
export const defaultResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));

type Range = { base: number; bits: number; label: string };

const v4 = (s: string): number | undefined => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (m === null) return undefined;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return undefined;
  return (
    (((parts[0] ?? 0) << 24) |
      ((parts[1] ?? 0) << 16) |
      ((parts[2] ?? 0) << 8) |
      (parts[3] ?? 0)) >>>
    0
  );
};

const range = (cidr: string, label: string): Range => {
  const [ip, bits] = cidr.split("/");
  return { base: v4(ip ?? "") ?? 0, bits: Number(bits), label };
};

/** Blocked IPv4 ranges, most specific label first where they nest. */
const V4_BLOCKED: readonly Range[] = [
  range("0.0.0.0/8", "unspecified"),
  range("10.0.0.0/8", "private"),
  range("100.64.0.0/10", "CGNAT"),
  range("127.0.0.0/8", "loopback"),
  range("169.254.0.0/16", "link-local (cloud metadata)"),
  range("172.16.0.0/12", "private"),
  range("192.0.0.0/24", "reserved"),
  range("192.168.0.0/16", "private"),
  range("198.18.0.0/15", "reserved"),
  range("224.0.0.0/4", "multicast"),
  range("240.0.0.0/4", "reserved"),
];

const inRange = (ip: number, r: Range): boolean =>
  r.bits === 0 ? true : ip >>> (32 - r.bits) === r.base >>> (32 - r.bits);

function blockedV4(ip: number): string | undefined {
  return V4_BLOCKED.find((r) => inRange(ip, r))?.label;
}

/** The eight 16-bit groups of an IPv6 address, or undefined when it is not one. */
function v6Groups(s: string): number[] | undefined {
  let text = s;
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (tail?.[1] !== undefined) {
    const n = v4(tail[1]);
    if (n === undefined) return undefined;
    text = `${text.slice(0, tail.index)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (h: string): number[] | undefined => {
    if (h === "") return [];
    const out: number[] = [];
    for (const g of h.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return undefined;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (head === undefined || rest === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const fill = 8 - head.length - rest.length;
  if (fill < 1) return undefined;
  return [...head, ...new Array<number>(fill).fill(0), ...rest];
}

const embeddedV4 = (g: number[]): number => (((g[6] ?? 0) << 16) | (g[7] ?? 0)) >>> 0;

function blockedV6(g: number[]): string | undefined {
  const [a = 0, b = 0] = g;
  const zeroUpTo = (n: number): boolean => g.slice(0, n).every((x) => x === 0);
  if (zeroUpTo(8)) return "unspecified";
  if (zeroUpTo(7) && g[7] === 1) return "loopback";
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4 inside.
  if (zeroUpTo(5) && (g[5] === 0xffff || g[5] === 0)) {
    return blockedV4(embeddedV4(g)) ?? (g[5] === 0 ? "reserved" : undefined);
  }
  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) also carry an IPv4 that may be internal.
  if (a === 0x64 && b === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return blockedV4(embeddedV4(g));
  }
  if (a === 0x2002) return blockedV4((((g[1] ?? 0) << 16) | (g[2] ?? 0)) >>> 0);
  if ((a & 0xfe00) === 0xfc00) return "private (unique local)";
  if ((a & 0xffc0) === 0xfe80) return "link-local";
  if ((a & 0xffc0) === 0xfec0) return "site-local";
  if ((a & 0xff00) === 0xff00) return "multicast";
  if (a === 0x100 && g.slice(1, 4).every((x) => x === 0)) return "reserved (discard)";
  return undefined;
}

/** Why `addr` (an IPv4 or IPv6 address, brackets allowed) must not be fetched, or undefined. */
export function blockedAddress(addr: string): string | undefined {
  const s = addr.startsWith("[") && addr.endsWith("]") ? addr.slice(1, -1) : addr;
  const n = v4(s);
  if (n !== undefined) return blockedV4(n);
  const g = s.includes(":") ? v6Groups(s) : undefined;
  if (g !== undefined) return blockedV6(g);
  return "not an IP address";
}

/** Why the host name itself must not be fetched (local-only names), or undefined. */
export function blockedHostName(host: string): string | undefined {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return "a localhost name";
  if (h.endsWith(".local")) return "a .local (mDNS) name";
  if (h.endsWith(".internal")) return "an .internal name";
  return undefined;
}

/**
 * Vet `hostname` (a WHATWG `URL.hostname`, so numeric IPv4 forms like `0x7f000001` are already
 * normalised to dotted quads): refuse local-only names, then resolve and refuse when ANY address
 * is in a blocked range. Returns the address to connect to (pin it: see `pinnedLookup`).
 */
export async function vetHost(hostname: string, resolve: Resolver): Promise<ResolvedAddress> {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const literal = isIP(bare.split("%")[0] ?? "");
  if (literal !== 0) {
    const why = blockedAddress(bare);
    if (why !== undefined) throw new WebError(`refused: ${hostname} is a ${why} address`);
    return { address: bare, family: literal === 6 ? 6 : 4 };
  }
  const name = blockedHostName(bare);
  if (name !== undefined) throw new WebError(`refused: ${hostname} is ${name}`);
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(bare);
  } catch (e) {
    throw new WebError(`cannot resolve ${hostname}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const first = addresses[0];
  if (first === undefined) throw new WebError(`refused: ${hostname} does not resolve`);
  for (const a of addresses) {
    const why = blockedAddress(a.address);
    if (why !== undefined) {
      throw new WebError(`refused: ${hostname} resolves to ${a.address}, a ${why} address`);
    }
  }
  return first;
}

/**
 * A `net.connect` `lookup` that answers with the vetted address whatever name it is asked for,
 * so a second DNS answer (rebinding) can never change where the socket goes. Handles both
 * callback shapes: `(err, address, family)` and, with `all: true`, `(err, [{address, family}])`.
 */
export function pinnedLookup(pin: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      (callback as unknown as (e: null, a: ResolvedAddress[]) => void)(null, [
        { address: pin.address, family: pin.family },
      ]);
    } else {
      callback(null, pin.address, pin.family);
    }
  };
}
