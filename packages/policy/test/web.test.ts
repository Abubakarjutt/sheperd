import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_POLICY,
  loadPolicy,
  mergeTightenOnly,
  type Policy,
  webHostRefusal,
  webOffReason,
} from "../src/index.js";

async function repoWith(toml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rewire-policy-web-"));
  await mkdir(join(dir, ".rewire"));
  await writeFile(join(dir, ".rewire", "policy.toml"), toml);
  return dir;
}

const withWeb = (web: Policy["web"]): Policy => ({ ...structuredClone(DEFAULT_POLICY), web });

describe("[web] defaults", () => {
  test("web is on, with no domain rules", () => {
    expect(DEFAULT_POLICY.web).toEqual({ enabled: true, denyDomains: [] });
    expect(webHostRefusal(DEFAULT_POLICY.web, "example.com")).toBeUndefined();
  });
});

describe("[web] in .rewire/policy.toml", () => {
  test("enabled = false turns web off", async () => {
    const p = await loadPolicy(await repoWith("[web]\nenabled = false\n"));
    expect(p.web.enabled).toBe(false);
  });

  test("deny_domains and allow_domains load, lowercased and without trailing dots", async () => {
    const p = await loadPolicy(
      await repoWith(
        '[web]\ndeny_domains = ["Evil.Example."]\nallow_domains = ["docs.python.org", "MDN.io"]\n',
      ),
    );
    expect(p.web).toEqual({
      enabled: true,
      denyDomains: ["evil.example"],
      allowDomains: ["docs.python.org", "mdn.io"],
    });
  });

  test.each([
    ['[web]\nenabled = "no"\n'],
    ['[web]\ndeny_domains = ["https://evil.example"]\n'],
    ['[web]\ndeny_domains = ["evil.example/path"]\n'],
    ['[web]\nallow_domains = ["*.example.com"]\n'],
    ['[web]\nallow_domains = ["example.com:443"]\n'],
    ['[web]\nallow_domains = [""]\n'],
    ['[web]\nallow_domains = ["exa mple.com"]\n'],
    ["[web]\nallowDomains = []\n"],
    ["[web]\nextra = 1\n"],
  ])("invalid [web] is policy_invalid: %s", async (toml) => {
    await expect(loadPolicy(await repoWith(toml))).rejects.toMatchObject({
      code: "policy_invalid",
    });
  });
});

describe("[web] layering only tightens", () => {
  test("a layer can turn web off; a later layer cannot turn it back on", () => {
    const off = mergeTightenOnly(DEFAULT_POLICY, { web: { enabled: false } });
    expect(off.web.enabled).toBe(false);
    expect(mergeTightenOnly(off, {}).web.enabled).toBe(false);
    expect(mergeTightenOnly(off, { web: { enabled: false } }).web.enabled).toBe(false);
    expect(() => mergeTightenOnly(off, { web: { enabled: true } })).toThrow(/web.enabled/);
    try {
      mergeTightenOnly(off, { web: { enabled: true } });
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: "policy_loosening" });
    }
    // Restating "on" over an "on" base is not a loosening.
    expect(mergeTightenOnly(DEFAULT_POLICY, { web: { enabled: true } }).web.enabled).toBe(true);
  });

  test("deny_domains is the union of the layers", () => {
    const a = mergeTightenOnly(DEFAULT_POLICY, { web: { denyDomains: ["a.example"] } });
    const b = mergeTightenOnly(a, { web: { denyDomains: ["b.example", "a.example"] } });
    expect(b.web.denyDomains).toEqual(["a.example", "b.example"]);
    // An empty list never removes the base's entries.
    expect(mergeTightenOnly(b, { web: { denyDomains: [] } }).web.denyDomains).toEqual([
      "a.example",
      "b.example",
    ]);
  });

  test("allow_domains: the first layer that sets it restricts; later layers intersect", () => {
    const org = mergeTightenOnly(DEFAULT_POLICY, {
      web: { allowDomains: ["python.org", "mdn.io"] },
    });
    expect(org.web.allowDomains).toEqual(["python.org", "mdn.io"]);
    // A repo layer that names a domain outside the org list cannot widen it.
    const repo = mergeTightenOnly(org, {
      web: { allowDomains: ["docs.python.org", "evil.example"] },
    });
    expect(repo.web.allowDomains).toEqual(["docs.python.org"]);
    expect(webHostRefusal(repo.web, "evil.example")).toMatch(/allow_domains/);
    expect(webHostRefusal(repo.web, "mdn.io")).toMatch(/allow_domains/);
    expect(webHostRefusal(repo.web, "docs.python.org")).toBeUndefined();
    // A broader entry under a narrower base keeps the narrower one.
    const back = mergeTightenOnly(repo, { web: { allowDomains: ["python.org"] } });
    expect(back.web.allowDomains).toEqual(["docs.python.org"]);
    // Nothing in common: nothing is allowed.
    const none = mergeTightenOnly(org, { web: { allowDomains: ["other.example"] } });
    expect(none.web.allowDomains).toEqual([]);
    expect(webHostRefusal(none.web, "python.org")).toMatch(/allow_domains/);
    // A layer that does not set it keeps the restriction.
    expect(mergeTightenOnly(repo, {}).web.allowDomains).toEqual(["docs.python.org"]);
  });

  test("a repo policy.toml cannot re-enable web over a base that disabled it", async () => {
    const repo = await repoWith("[web]\nenabled = true\n");
    // loadPolicy layers over the built-in default (on), so restating true is fine there.
    expect((await loadPolicy(repo)).web.enabled).toBe(true);
    const base = mergeTightenOnly(DEFAULT_POLICY, { web: { enabled: false } });
    expect(() => mergeTightenOnly(base, { web: { enabled: true } })).toThrow();
  });
});

describe("webHostRefusal", () => {
  test("deny_domains matches the domain and its subdomains, never a lookalike", () => {
    const web = withWeb({ enabled: true, denyDomains: ["evil.example"] }).web;
    expect(webHostRefusal(web, "evil.example")).toMatch(/deny_domains.*evil\.example/);
    expect(webHostRefusal(web, "a.b.evil.example")).toMatch(/deny_domains/);
    expect(webHostRefusal(web, "notevil.example")).toBeUndefined();
    expect(webHostRefusal(web, "evil.example.org")).toBeUndefined();
  });

  test("host case and trailing dots do not matter", () => {
    const web = withWeb({ enabled: true, denyDomains: ["evil.example"] }).web;
    expect(webHostRefusal(web, "EVIL.Example.")).toMatch(/deny_domains/);
  });

  test("deny wins over allow", () => {
    const web = withWeb({
      enabled: true,
      denyDomains: ["bad.python.org"],
      allowDomains: ["python.org"],
    }).web;
    expect(webHostRefusal(web, "docs.python.org")).toBeUndefined();
    expect(webHostRefusal(web, "bad.python.org")).toMatch(/deny_domains/);
    expect(webHostRefusal(web, "example.com")).toMatch(/not in \[web\] allow_domains/);
  });

  test("web off refuses every host", () => {
    expect(webHostRefusal(withWeb({ enabled: false, denyDomains: [] }).web, "a.com")).toMatch(
      /enabled = false/,
    );
  });
});

describe("webOffReason", () => {
  test("off, or an empty allow list, gives the reason; otherwise none", () => {
    expect(webOffReason(DEFAULT_POLICY)).toBeUndefined();
    expect(webOffReason(withWeb({ enabled: false, denyDomains: [] }))).toMatch(/enabled = false/);
    expect(webOffReason(withWeb({ enabled: true, denyDomains: [], allowDomains: [] }).web)).toMatch(
      /allow_domains is empty/,
    );
    expect(
      webOffReason(withWeb({ enabled: true, denyDomains: [], allowDomains: ["a.example"] })),
    ).toBeUndefined();
  });
});
