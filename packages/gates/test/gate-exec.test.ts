import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY } from "@rewire/policy";
import type { ExecResult, SandboxClient } from "@rewire/sandbox";
import { profileFor, SandboxClient as RealClient } from "@rewire/sandbox";
import { describe, expect, test } from "vitest";
import { GateExec } from "../src/gates/shared.js";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "rewire-gexec-")));

function stub(): { client: SandboxClient; calls: string[][] } {
  const calls: string[][] = [];
  const client = {
    async exec(argv: string[]): Promise<ExecResult> {
      calls.push(argv);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false } as ExecResult;
    },
  } as unknown as SandboxClient;
  return { client, calls };
}

describe("GateExec never lets pnpm install dependencies", () => {
  test("every pnpm invocation gets --config.verify-deps-before-run=false before the subcommand", async () => {
    const { client, calls } = stub();
    const g = new GateExec({ worktree: "/w", client, deadline: Date.now() + 5000 });
    await g.exec(["pnpm", "exec", "vitest", "run"]);
    await g.exec(["/opt/bin/pnpm", "run", "lint"]);
    await g.exec(["node", "-e", "0"]);
    const env = ["/usr/bin/env", "pnpm_config_verify_deps_before_run=false"];
    expect(calls).toEqual([
      [...env, "pnpm", "--config.verify-deps-before-run=false", "exec", "vitest", "run"],
      [...env, "/opt/bin/pnpm", "--config.verify-deps-before-run=false", "run", "lint"],
      ["node", "-e", "0"],
    ]);
  });

  test("pnpm exec in a project with an uninstalled dependency does not attempt an install", async () => {
    const root = tmp();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "x",
        private: true,
        dependencies: { "is-number": "7.0.0" },
        scripts: { nested: "pnpm exec node -e \"process.stdout.write('ran-nested')\"" },
      }),
    );
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const client = new RealClient(profileFor("verify", root, DEFAULT_POLICY, tmp()));
    try {
      const g = new GateExec({ worktree: root, client, deadline: Date.now() + 60_000 });
      const r = await g.exec(["pnpm", "exec", "node", "-e", "process.stdout.write('ran')"]);
      expect(r.stdout).toBe("ran");
      expect(r.stderr).not.toMatch(/install/i);
      expect(r.exitCode).toBe(0);
      expect(existsSync(join(root, "node_modules"))).toBe(false);
      // A pnpm started by a script inherits the setting (a lint script calling pnpm again).
      const n = await g.exec(["pnpm", "run", "nested"]);
      expect(n.stdout).toContain("ran-nested");
      expect(n.stderr).not.toMatch(/install/i);
      expect(n.exitCode).toBe(0);
      expect(existsSync(join(root, "node_modules"))).toBe(false);
    } finally {
      client.dispose();
    }
  });
});
