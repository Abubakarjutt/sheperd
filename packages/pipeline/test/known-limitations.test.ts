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

  it("is listed verbatim (modulo capitalisation) in the README", async () => {
    const readme = await readFile(new URL("../../../README.md", import.meta.url), "utf8");
    const lower = readme.replace(/\s+/g, " ").toLowerCase();
    for (const l of KNOWN_LIMITATIONS) {
      const head = l.replace(/\s+/g, " ").toLowerCase();
      expect(lower.includes(head), `README is missing: ${l.slice(0, 60)}`).toBe(true);
    }
  });
});
