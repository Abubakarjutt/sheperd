import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { KNOWN_LIMITATIONS } from "../src/orchestrator.js";

describe("KNOWN_LIMITATIONS", () => {
  it("includes the four limitations the plan requires in every evidence report", () => {
    const all = KNOWN_LIMITATIONS.join("\n");
    expect(all).toMatch(/audit gate uses a registry network exception/);
    expect(all).toMatch(/full network access during that gate, because bwrap has no domain/);
    expect(all).toMatch(/test-writer isolation from implementation bodies is prompt-level/);
    expect(all).toMatch(/disputes escalate to the human; automated adjudication is deferred/);
    expect(all).toMatch(/TypeScript only.*pack_undetected/);
  });

  it("names the Linux creation gap and the fast-detaching process residual (C1/R7, I4/R8)", () => {
    const all = KNOWN_LIMITATIONS.join("\n");
    expect(all).toMatch(/OS layer doesn't block creation on Linux; the protected-paths gate does/);
    expect(all).toMatch(/detaches from the sandbox faster than one poll interval/);
  });

  it("every README 'Stated in every report' bullet is a KNOWN_LIMITATIONS entry (row 114)", async () => {
    const readme = await readFile(new URL("../../../README.md", import.meta.url), "utf8");
    const start = readme.indexOf("Stated in every report");
    const end = readme.indexOf("Also known:", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const bullets = readme
      .slice(start, end)
      .split(/\n- /)
      .slice(1)
      .map((b) => b.replace(/\s+/g, " ").trim().replace(/\.$/, "").toLowerCase());
    const known = new Set(KNOWN_LIMITATIONS.map((l) => l.replace(/\s+/g, " ").toLowerCase()));
    // The one conditional line, added only for same-family routing.
    const conditional = (b: string) => b.includes("`independence: same-family`");
    for (const b of bullets) {
      if (conditional(b)) continue;
      expect(known.has(b), `README bullet is not in KNOWN_LIMITATIONS: ${b.slice(0, 80)}`).toBe(
        true,
      );
    }
    expect(bullets.filter((b) => !conditional(b))).toHaveLength(KNOWN_LIMITATIONS.length);
  });

  it("is listed verbatim (modulo capitalisation) in the README", async () => {
    const readme = await readFile(new URL("../../../README.md", import.meta.url), "utf8");
    const lower = readme.replace(/\s+/g, " ").toLowerCase();
    for (const l of KNOWN_LIMITATIONS) {
      const head = l.replace(/\s+/g, " ").toLowerCase();
      expect(lower.includes(head), `README is missing: ${l.slice(0, 60)}`).toBe(true);
    }
  });
});
