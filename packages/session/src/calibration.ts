import { RewireError } from "@rewire/core";
import { TokenEstimator } from "@rewire/providers";

/**
 * Needle-retrieval probes for `rewire calibrate`: a long deterministic document with planted
 * facts, a question about them, and a scorer. Pure: no I/O.
 */

/** The shortest probe; also the first planned length. */
export const MIN_PROBE_LENGTH = 8192;
/** A length passes at this score (of 5) or more. */
export const PASS_SCORE = 4;
export const MAX_SCORE = 5;
/** Output tokens a probe reply may use. */
export const PROBE_MAX_TOKENS = 200;
/** Share of the window the largest probe may fill. */
export const PROBE_WINDOW_SHARE = 0.95;

export type ProbeAnswers = { codes: Record<string, string>; room: number };
export type PlantedFact = {
  kind: "code" | "reports_to" | "office";
  sentence: string;
  /** Fraction of the document before the fact. */
  depth: number;
};
export type Probe = { system: string; user: string; answers: ProbeAnswers; planted: PlantedFact[] };

/** mulberry32: a small seeded PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const int = (r: Rand, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

const SUBJECTS = [
  "The committee",
  "A small crew",
  "The night shift",
  "Our auditor",
  "The ferry operator",
  "A visiting engineer",
  "The archivist",
  "The regional office",
  "A volunteer group",
  "The harbour master",
  "The survey team",
  "An apprentice",
  "The quarry foreman",
  "The weather station",
  "A local baker",
  "The council",
  "The lighthouse keeper",
  "A delivery driver",
  "The orchard cooperative",
  "The museum guide",
] as const;
const VERBS = [
  "inspected",
  "repainted",
  "catalogued",
  "measured",
  "relocated",
  "repaired",
  "photographed",
  "described",
  "weighed",
  "sorted",
  "replaced",
  "reviewed",
  "cleaned",
  "mapped",
  "tested",
  "restored",
  "counted",
  "sketched",
  "labelled",
  "dismantled",
] as const;
const ADJECTIVES = [
  "rusty",
  "narrow",
  "freshly painted",
  "crooked",
  "ancient",
  "noisy",
  "spare",
  "damp",
  "wooden",
  "brass",
  "faded",
  "heavy",
  "temporary",
  "broken",
  "polished",
  "tiny",
  "oversized",
  "borrowed",
] as const;
const OBJECTS = [
  "pump housing",
  "signal lamp",
  "stone bridge",
  "ledger",
  "water tank",
  "fence line",
  "boat ramp",
  "grain silo",
  "bell tower",
  "tram shelter",
  "drainage ditch",
  "garden wall",
  "loading crane",
  "telegraph pole",
  "boiler",
  "mill wheel",
  "rain gauge",
  "staircase",
] as const;
const PLACES = [
  "near the old market",
  "behind the station",
  "by the north pier",
  "at the edge of town",
  "beside the canal",
  "on the upper terrace",
  "under the viaduct",
  "past the cemetery",
  "along the river path",
  "inside the depot",
  "next to the school",
  "below the ridge",
] as const;
const CLAUSES = [
  "although it rained most of the afternoon",
  "which took longer than planned",
  "before the inspectors arrived",
  "after a short delay",
  "while traffic was diverted",
  "and nobody complained",
  "despite the cold wind",
  "as the schedule required",
  "with help from two neighbours",
  "and noted a few minor issues",
] as const;
const LEVELS = ["INFO", "INFO", "INFO", "DEBUG", "WARN", "ERROR"] as const;
const SERVICES = [
  "scheduler",
  "ingest",
  "billing",
  "auth-proxy",
  "cache",
  "indexer",
  "mailer",
  "gateway",
  "exporter",
  "thumbnailer",
] as const;
const LOG_MESSAGES = [
  (r: Rand) => `job ${int(r, 1000, 99999)} finished in ${int(r, 2, 9000)}ms`,
  (r: Rand) => `queue depth ${int(r, 0, 500)} (limit ${int(r, 500, 2000)})`,
  (r: Rand) => `retrying request ${int(r, 1, 9)}/${int(r, 3, 9)} after ${int(r, 10, 900)}ms`,
  (r: Rand) => `flushed ${int(r, 1, 4096)} records to segment ${int(r, 1, 300)}`,
  (r: Rand) => `connection pool at ${int(r, 1, 64)}/${int(r, 64, 128)}`,
  (r: Rand) => `cache hit ratio ${int(r, 10, 99)}.${int(r, 0, 9)}% over ${int(r, 1, 60)}m`,
  (r: Rand) => `worker ${int(r, 1, 32)} heartbeat lag ${int(r, 0, 5000)}ms`,
] as const;
const IDENTS = [
  "total",
  "buffer",
  "offset",
  "count",
  "cursor",
  "limit",
  "index",
  "result",
  "payload",
  "chunk",
  "width",
  "height",
  "retries",
  "delay",
  "header",
  "token",
  "weight",
  "score",
] as const;
const FUNCS = [
  "parse",
  "merge",
  "clamp",
  "encode",
  "resolve",
  "flatten",
  "measure",
  "normalize",
  "split",
  "compact",
  "render",
  "validate",
] as const;

function proseLine(r: Rand): string {
  return `${pick(r, SUBJECTS)} ${pick(r, VERBS)} the ${pick(r, ADJECTIVES)} ${pick(r, OBJECTS)} ${pick(r, PLACES)} on day ${int(r, 1, 365)}, ${pick(r, CLAUSES)}.`;
}

function codeLine(r: Rand): string {
  const a = pick(r, IDENTS);
  const b = pick(r, IDENTS);
  const f = pick(r, FUNCS);
  const n = int(r, 0, 9999);
  switch (int(r, 0, 4)) {
    case 0:
      return `  const ${a}${n} = ${f}(${b}, ${int(r, 0, 999)});`;
    case 1:
      return `  if (${a} > ${n}) return ${f}(${b});`;
    case 2:
      return `function ${f}${n}(${a}, ${b}) {`;
    case 3:
      return `  ${a}.${f}(${b}[${n % 64}], ${int(r, 0, 99)});`;
    default:
      return `  let ${b}${n} = ${a} * ${int(r, 2, 97)} + ${int(r, 0, 999)};`;
  }
}

/** Seeded filler: blocks of prose sentences, log lines and code-like lines. */
function* filler(r: Rand): Generator<string> {
  let clock = Date.UTC(2026, 0, 1) + int(r, 0, 1e9) * 1000;
  for (;;) {
    const mode = int(r, 0, 2);
    const n = int(r, 3, 8);
    for (let i = 0; i < n; i++) {
      if (mode === 0) yield proseLine(r);
      else if (mode === 1) {
        clock += int(r, 1, 600) * 1000;
        const ts = new Date(clock).toISOString().replace(/\.\d{3}Z$/, "Z");
        yield `${ts} ${pick(r, LEVELS)} ${pick(r, SERVICES)}: ${pick(r, LOG_MESSAGES)(r)}`;
      } else yield codeLine(r);
    }
    yield "";
  }
}

const FIRST = [
  "Ines",
  "Tomas",
  "Marta",
  "Kofi",
  "Lena",
  "Arjun",
  "Sofia",
  "Dmitri",
  "Yara",
  "Emil",
  "Noor",
  "Bruno",
  "Hana",
  "Oskar",
  "Priya",
  "Mateo",
  "Freya",
  "Kenji",
  "Amara",
  "Luca",
] as const;
const LAST = [
  "Okafor",
  "Brandt",
  "Lindqvist",
  "Moreau",
  "Tanaka",
  "Haddad",
  "Novak",
  "Castillo",
  "Ferreira",
  "Kowalski",
  "Mensah",
  "Larsen",
  "Varga",
  "Duarte",
  "Ishikawa",
  "Byrne",
  "Achterberg",
  "Rossi",
] as const;
const CODE_WORDS = [
  "amber",
  "falcon",
  "cobalt",
  "juniper",
  "quartz",
  "harbor",
  "saffron",
  "tundra",
  "velvet",
  "orchid",
  "granite",
  "meadow",
  "pewter",
  "lagoon",
  "ember",
  "willow",
] as const;

const CODE_DEPTHS = [0.1, 0.3, 0.5, 0.5, 0.7, 0.9] as const;
const REPORTS_DEPTH = 0.2;
const OFFICE_DEPTH = 0.8;

const SYSTEM =
  "You are taking a reading test. Answer only from the document in the user message. Reply with only the JSON object asked for, no other text.";

/**
 * A prompt of about `targetTokens` (by `estimator`): seeded filler with 6 access codes planted
 * at 10/30/50/50/70/90% depth and a 2-hop pair (who reports to whom at 20%, the manager's office
 * at 80%). The question asks for 4 codes and the manager's room, as JSON.
 */
export function buildProbe(
  targetTokens: number,
  seed: number,
  estimator: TokenEstimator = new TokenEstimator(),
): Probe {
  if (!(Number.isFinite(targetTokens) && targetTokens >= MIN_PROBE_LENGTH)) {
    throw new RewireError(
      "calibration_failed",
      `a probe needs at least ${MIN_PROBE_LENGTH} tokens (asked for ${targetTokens})`,
    );
  }
  const r = prng(seed);
  // Distinct names: 6 code holders and the 2-hop pair.
  const names = new Set<string>();
  while (names.size < 8) names.add(`${pick(r, FIRST)} ${pick(r, LAST)}`);
  const [a, b, ...holders] = [...names] as [string, string, ...string[]];
  const codes = holders.map((name) => ({
    name,
    code: `${pick(r, CODE_WORDS)}-${int(r, 1000, 9999)}`,
  }));
  const room = int(r, 100, 999);
  const planted: PlantedFact[] = [
    ...codes.map((c, i) => ({
      kind: "code" as const,
      sentence: `The access code for ${c.name} is ${c.code}.`,
      depth: CODE_DEPTHS[i] as number,
    })),
    { kind: "reports_to", sentence: `${a} reports to ${b}.`, depth: REPORTS_DEPTH },
    { kind: "office", sentence: `${b}'s office is room ${room}.`, depth: OFFICE_DEPTH },
  ];
  // 4 of the 6 codes, chosen by the seed, asked in document order.
  const order = codes.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [order[i], order[j]] = [order[j] as number, order[i] as number];
  }
  const asked = order
    .slice(0, 4)
    .sort((x, y) => x - y)
    .map((i) => codes[i] as { name: string; code: string });
  const answers: ProbeAnswers = {
    codes: Object.fromEntries(asked.map((c) => [c.name, c.code])),
    room,
  };
  const questions = [
    ...asked.map((c, i) => `${i + 1}. What is the access code for ${c.name}?`),
    `5. ${a} reports to a manager: which room is ${a}'s manager in?`,
  ];
  const shape = `{"codes": {${asked.map((c) => `"${c.name}": "<code>"`).join(", ")}}, "room": <number>}`;
  const tail = `\n</document>\n\nUsing only the document above, answer:\n${questions.join("\n")}\n\nReply with only this JSON object, nothing else:\n${shape}`;
  const head = "<document>\n";

  // Size the filler: the frame's tokens, then chars until the estimate reaches the target.
  const factChars = planted.reduce((n, f) => n + f.sentence.length + 1, 0);
  const frame = estimator.estimate(SYSTEM, [{ role: "user", content: head + tail }]);
  const charsPerToken = 4 / estimator.ratio;
  const budget = Math.max(0, Math.floor((targetTokens - frame) * charsPerToken) - factChars);
  const lines: string[] = [];
  let chars = 0;
  for (const line of filler(r)) {
    if (chars + line.length + 1 > budget) break;
    lines.push(line);
    chars += line.length + 1;
  }
  // Insert each fact at its depth (by characters), deepest first so earlier offsets hold.
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) {
    starts.push(at);
    at += l.length + 1;
  }
  const lineAt = (depth: number): number => {
    const target = depth * at;
    let i = 0;
    while (i < starts.length && (starts[i] as number) < target) i++;
    return i;
  };
  const inserts = planted.map((f, i) => ({ f, i, line: lineAt(f.depth) }));
  inserts.sort((x, y) => y.line - x.line || y.i - x.i);
  for (const { f, line } of inserts) lines.splice(line, 0, f.sentence);
  const user = `${head}${lines.join("\n")}${tail}`;
  return { system: SYSTEM, user, answers, planted };
}

/** Every top-level balanced `{...}` in `s`, in order (string-aware). */
function balancedObjects(s: string): string[] {
  const out: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (depth > 0 && inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (depth > 0 && c === '"') inString = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" && depth > 0 && --depth === 0) out.push(s.slice(start, i + 1));
  }
  return out;
}

/**
 * The answer object in `s`: the JSON objects inside ``` fences, then every balanced `{...}`, in
 * that order. The first one with a `codes` or `room` key wins (so a stray `{}` in reasoning prose
 * before the answer does not hide it); otherwise the first object.
 */
function answerObject(s: string): Record<string, unknown> | undefined {
  const candidates: string[] = [];
  for (const m of s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (m[1] !== undefined) candidates.push(m[1]);
  }
  candidates.push(...balancedObjects(s));
  const objects: Record<string, unknown>[] = [];
  for (const c of candidates) {
    try {
      const v: unknown = JSON.parse(c.trim());
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        objects.push(v as Record<string, unknown>);
      }
    } catch {
      // try the next candidate
    }
  }
  return objects.find((o) => Object.hasOwn(o, "codes") || Object.hasOwn(o, "room")) ?? objects[0];
}

const norm = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase() : "");

/**
 * 0-5: one point per correct asked code and one for the room. Lenient on fences, surrounding
 * prose, case and whitespace; anything that is not a JSON object scores 0.
 */
export function score(reply: string, answers: ProbeAnswers): number {
  const obj = answerObject(reply) as { codes?: unknown; room?: unknown } | undefined;
  if (obj === undefined) return 0;
  let points = 0;
  if (obj.codes !== null && typeof obj.codes === "object" && !Array.isArray(obj.codes)) {
    const given = new Map<string, string>();
    for (const [k, v] of Object.entries(obj.codes)) given.set(norm(k), norm(v));
    for (const [name, code] of Object.entries(answers.codes)) {
      if (given.get(name.toLowerCase()) === code.toLowerCase()) points++;
    }
  }
  const room =
    typeof obj.room === "number"
      ? obj.room
      : typeof obj.room === "string" && /^\s*\d+\s*$/.test(obj.room)
        ? Number(obj.room)
        : Number.NaN;
  if (room === answers.room) points++;
  return points;
}

/** 8K, 16K, 32K, ... up to min(floor(0.95·window), max). */
export function planLengths(window: number, max: number = Number.POSITIVE_INFINITY): number[] {
  const cap = Math.min(Math.floor(PROBE_WINDOW_SHARE * window), max);
  const out: number[] = [];
  for (let len = MIN_PROBE_LENGTH; len <= cap; len *= 2) out.push(len);
  return out;
}

export type Decision = {
  /**
   * The largest length that passed with every shorter tested length passing. An errored length
   * (no score) breaks the run of passes: it was not measured.
   */
  effective?: number;
  /** Two consecutive scored lengths under PASS_SCORE (errors skipped): measure no further. */
  stop: boolean;
};

/** A length's outcome: a score, or an error (not a measurement: retried by the next run). */
export type ScoredOrError = { score?: number | undefined; error?: string | undefined };

export function decide(results: Record<number | string, ScoredOrError>): Decision {
  const lens = Object.keys(results)
    .map(Number)
    .sort((x, y) => x - y);
  const scoreOf = (l: number) => (results[l] as ScoredOrError).score;
  let effective: number | undefined;
  for (const l of lens) {
    const s = scoreOf(l);
    if (s === undefined || s < PASS_SCORE) break;
    effective = l;
  }
  const scored = lens.map(scoreOf).filter((s): s is number => s !== undefined);
  let stop = false;
  for (let i = 1; i < scored.length; i++) {
    if ((scored[i - 1] as number) < PASS_SCORE && (scored[i] as number) < PASS_SCORE) stop = true;
  }
  return effective !== undefined ? { effective, stop } : { stop };
}
