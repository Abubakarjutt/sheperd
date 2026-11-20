import type { AgentTool } from "@rewire/loop";
import type { SandboxClient } from "@rewire/sandbox";
import { missingRg } from "./grep.js";
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

export function findTool(
  client: SandboxClient,
  rg: string | undefined,
  ctx: ToolContext,
): AgentTool {
  return {
    spec: {
      name: "find",
      description: "List files matching a glob (e.g. **/*.ts), relative to the worktree root.",
      inputSchema: {
        type: "object",
        properties: { glob: { type: "string" } },
        required: ["glob"],
      },
    },
    async execute(args) {
      if (rg === undefined) return missingRg("find")(args);
      const glob = strArg(args, "glob");
      if (glob === undefined || glob === "") return fail("glob is required");
      const problem = relativePathProblem(glob.replace(/^!/, ""));
      if (problem) return fail(problem.replace("path", "glob"));
      try {
        const r = await client.exec([rg, "--files", "--color", "never", "-g", glob], {
          timeoutMs: RG_TIMEOUT_MS,
        });
        if (r.exitCode === 1 || (r.exitCode === 0 && r.stdout.trim() === ""))
          return ok("no matches");
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
