import type { AgentTool } from "@rewire/loop";
import type { SandboxClient } from "@rewire/sandbox";
import {
  capOutput,
  errorResult,
  fail,
  ok,
  relativePathProblem,
  strArg,
  type ToolContext,
} from "./util.js";

const RG_TIMEOUT_MS = 30_000;

export function missingRg(name: string): AgentTool["execute"] {
  return async () =>
    fail(`${name} is unavailable: ripgrep (rg) was not found on PATH when the tools were created`);
}

export function grepTool(
  client: SandboxClient,
  rg: string | undefined,
  ctx: ToolContext,
): AgentTool {
  return {
    spec: {
      name: "grep",
      description:
        "Search file contents with ripgrep (regex). path is relative to the worktree root; glob filters files.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          glob: { type: "string" },
        },
        required: ["pattern"],
      },
    },
    async execute(args) {
      if (rg === undefined) return missingRg("grep")(args);
      const pattern = strArg(args, "pattern");
      if (pattern === undefined || pattern === "") return fail("pattern is required");
      const path = strArg(args, "path") ?? ".";
      const glob = strArg(args, "glob");
      const problem = relativePathProblem(path);
      if (problem) return fail(problem);
      // Separate argv elements, never a shell; `-e` and `--` stop option injection.
      const argv = [rg, "--line-number", "--no-heading", "--color", "never", "--max-count", "200"];
      if (glob) argv.push("-g", glob);
      argv.push("-e", pattern, "--", path);
      try {
        const r = await client.exec(argv, { timeoutMs: RG_TIMEOUT_MS });
        if (r.exitCode === 1) return ok("no matches");
        if (r.exitCode !== 0) {
          return fail(`rg failed (exit code ${r.exitCode}): ${(r.stderr || r.stdout).trim()}`);
        }
        return ok(capOutput(r.stdout.replace(/\n$/, "")));
      } catch (e) {
        return errorResult(e, ctx);
      }
    },
  };
}
