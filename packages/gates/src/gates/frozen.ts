import { lstat, realpath } from "node:fs/promises";
import { join, normalize, relative } from "node:path";
import { verifyFrozen } from "../frozen.js";
import type { Gate } from "../types.js";
import { configDrift } from "./drift.js";
import { changedTestFiles, GateExec, realRootOf, testGlobFiles } from "./shared.js";

export const frozenTestsGate: Gate = {
  name: "frozen-tests",
  category: "fake_verification",
  async run(ctx) {
    if (!ctx.manifest) {
      return { status: "error", summary: "no frozen test manifest", details: null };
    }
    const manifest = ctx.manifest;
    const g = new GateExec(ctx);
    const problems: Record<string, unknown> = {};

    const frozen = await verifyFrozen(ctx.worktree, manifest);
    if (!frozen.ok) problems.frozenMismatches = frozen.mismatches;

    let changed: string[];
    let inGlobs: string[];
    let drift: Awaited<ReturnType<typeof configDrift>>;
    try {
      changed = await changedTestFiles(ctx, g);
      inGlobs = await testGlobFiles(ctx, g);
      drift = await configDrift(ctx, g);
    } catch (e) {
      return {
        status: "error",
        summary: `cannot compare tests against ${ctx.baseRef}: ${e instanceof Error ? e.message : String(e)}`,
        details: null,
      };
    }

    const frozenPaths = new Set(manifest.files.map((f) => normalize(f.path)));
    const preexisting = changed.filter((p) => !frozenPaths.has(normalize(p)));
    if (preexisting.length > 0) problems.modifiedPreexistingTests = preexisting;

    // A symlink under the test globs must resolve to another file under the test globs;
    // otherwise the implementer controls what the "frozen" tests read.
    const allowed = new Set(inGlobs.map((p) => normalize(p)));
    const realRoot = await realRootOf(ctx);
    const escaping: Array<{ path: string; target: string }> = [];
    for (const p of inGlobs) {
      const abs = join(ctx.worktree, p);
      let isLink = false;
      try {
        isLink = (await lstat(abs)).isSymbolicLink();
      } catch {
        continue; // deleted: reported through the baseRef diff
      }
      if (!isLink) continue;
      let target: string;
      try {
        target = relative(realRoot, await realpath(abs));
      } catch {
        escaping.push({ path: p, target: "(unresolvable)" });
        continue;
      }
      if (!allowed.has(normalize(target))) {
        escaping.push({ path: p, target });
      }
    }
    if (escaping.length > 0) problems.symlinksOutsideTests = escaping;

    if (drift.length > 0) problems.configDrift = drift;

    if (Object.keys(problems).length > 0) {
      const parts = Object.keys(problems).map((k) => k.replace(/([A-Z])/g, " $1").toLowerCase());
      return {
        status: "fail",
        summary: `frozen tests violated: ${parts.join(", ")}`,
        details: problems,
      };
    }
    return {
      status: "pass",
      summary: `${manifest.files.length} frozen test file(s) intact`,
      details: null,
    };
  },
};
