import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY, mergeTightenOnly } from "@rewire/policy";
import { defaultWebConfig } from "@rewire/web";
import { afterEach, describe, expect, test } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { webLine } from "../src/doctor-web.js";

const FAKE_KEY = "fake-key-Zq9XwV7uT5sR3pN1mL0k";
const dirs: string[] = [];
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "rewire-doctor-web-")));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NONE =
  "search: none — set OLLAMA_API_KEY, TAVILY_API_KEY or BRAVE_API_KEY, or [web] search in models.toml";

describe("webLine", () => {
  test("names the backend and the env var it found, never the key", () => {
    const l = webLine(defaultWebConfig(), { TAVILY_API_KEY: FAKE_KEY }, DEFAULT_POLICY);
    expect(l).toEqual({
      ok: true,
      detail: "search: tavily (TAVILY_API_KEY) · fetch: on · policy: on",
    });
    expect(JSON.stringify(l)).not.toContain(FAKE_KEY);
  });

  test("auto-selection order is ollama, tavily, brave", () => {
    const env = { BRAVE_API_KEY: FAKE_KEY, OLLAMA_API_KEY: FAKE_KEY, TAVILY_API_KEY: FAKE_KEY };
    expect(webLine(defaultWebConfig(), env, DEFAULT_POLICY).detail).toMatch(
      /^search: ollama \(OLLAMA_API_KEY\)/,
    );
  });

  test("no key: says what to set; fetch still works; a note, not a failure", () => {
    expect(webLine(defaultWebConfig(), { OLLAMA_API_KEY: "  " }, DEFAULT_POLICY)).toEqual({
      ok: false,
      detail: `${NONE} · fetch: on · policy: on`,
    });
  });

  test("an explicit backend without its key names that key", () => {
    const l = webLine({ ...defaultWebConfig(), search: "brave" }, {}, DEFAULT_POLICY);
    expect(l.ok).toBe(false);
    expect(l.detail).toMatch(
      /^search: none — set BRAVE_API_KEY \(models\.toml \[web\] search = "brave"\)/,
    );
  });

  test("SearXNG shows its host, never its path or a credential", () => {
    const l = webLine(
      { ...defaultWebConfig(), search: "searxng", searxngUrl: "https://search.example.org/sub" },
      {},
      DEFAULT_POLICY,
    );
    expect(l).toEqual({
      ok: true,
      detail: "search: searxng at search.example.org · fetch: on · policy: on",
    });
  });

  test("policy: allow-list and deny counts, and off with the reason", () => {
    const narrowed = mergeTightenOnly(DEFAULT_POLICY, {
      web: { allowDomains: ["python.org", "nodejs.org"], denyDomains: ["evil.example"] },
    });
    expect(webLine(defaultWebConfig(), { OLLAMA_API_KEY: FAKE_KEY }, narrowed).detail).toBe(
      "search: ollama (OLLAMA_API_KEY) · fetch: on · policy: on, allow_domains 2 sites, deny_domains 1",
    );
    const off = mergeTightenOnly(DEFAULT_POLICY, { web: { enabled: false } });
    expect(webLine(defaultWebConfig(), { OLLAMA_API_KEY: FAKE_KEY }, off)).toEqual({
      ok: false,
      detail: "off — web access is off ([web] enabled = false)",
    });
    const empty = mergeTightenOnly(DEFAULT_POLICY, { web: { allowDomains: [] } });
    expect(webLine(defaultWebConfig(), {}, empty).detail).toMatch(
      /^off — \[web\] allow_domains is empty/,
    );
  });
});

async function doctor(repo: string, models: string, env: NodeJS.ProcessEnv): Promise<string> {
  const out: string[] = [];
  await runDoctor(models, "darwin", {
    stdout: { write: (s: string) => out.push(s) } as unknown as NodeJS.WritableStream,
    env: { PATH: "", ...env },
    cwd: repo,
    sandboxLookup: { sourceRoot: null, packageRoot: tmp() },
  } as Parameters<typeof runDoctor>[2]);
  return out.join("");
}

describe("doctor: the web line", () => {
  test("reads models.toml [web] and the repo policy; never prints a key value", async () => {
    const repo = tmp();
    const models = join(repo, "models.toml");
    writeFileSync(
      models,
      `available = ["anthropic:claude-opus-5-5"]\n[web]\nsearch = "tavily"\nmax_results = 3\n`,
    );
    mkdirSync(join(repo, ".rewire"));
    writeFileSync(join(repo, ".rewire", "policy.toml"), `[web]\ndeny_domains = ["evil.example"]\n`);
    const out = await doctor(repo, models, {
      ANTHROPIC_API_KEY: FAKE_KEY,
      TAVILY_API_KEY: FAKE_KEY,
      OLLAMA_API_KEY: FAKE_KEY,
    });
    expect(out).toMatch(
      /^✓ web search: tavily \(TAVILY_API_KEY\) · fetch: on · policy: on, deny_domains 1$/m,
    );
    expect(out).not.toContain(FAKE_KEY);
  });

  test("no search key and web off are notes, not failures", async () => {
    const repo = tmp();
    const models = join(repo, "models.toml");
    writeFileSync(models, `available = ["anthropic:claude-opus-5-5"]\n`);
    const none = await doctor(repo, models, { ANTHROPIC_API_KEY: FAKE_KEY });
    expect(none).toContain(`! web — ${NONE} · fetch: on · policy: on\n`);
    mkdirSync(join(repo, ".rewire"));
    writeFileSync(join(repo, ".rewire", "policy.toml"), `[web]\nenabled = false\n`);
    const off = await doctor(repo, models, { ANTHROPIC_API_KEY: FAKE_KEY });
    expect(off).toContain("! web — off — web access is off ([web] enabled = false)\n");
    expect(off).not.toMatch(/^✗ web/m);
  });

  test("an invalid repo policy is a failure naming policy_invalid's message", async () => {
    const repo = tmp();
    const models = join(repo, "models.toml");
    writeFileSync(models, `available = ["anthropic:claude-opus-5-5"]\n`);
    mkdirSync(join(repo, ".rewire"));
    writeFileSync(join(repo, ".rewire", "policy.toml"), `[web]\nenabled = "yes"\n`);
    const out = await doctor(repo, models, { ANTHROPIC_API_KEY: FAKE_KEY });
    expect(out).toMatch(/^✗ policy — \.rewire\/policy\.toml: /m);
  });
});
