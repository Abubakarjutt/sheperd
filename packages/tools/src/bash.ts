import { RewireError } from "@rewire/core";
import type { AgentTool } from "@rewire/loop";
import type { Policy } from "@rewire/policy";
import type { SandboxClient } from "@rewire/sandbox";
import { evaluateBashCommand } from "./commands.js";
import { capOutput, errorResult, fail, intArg, strArg, type ToolContext } from "./util.js";

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
/** Bounds for a model-chosen timeout (row 49): tools ignore the run's abort, so this caps a call. */
export const MIN_BASH_TIMEOUT_MS = 1_000;
export const MAX_BASH_TIMEOUT_MS = 600_000;
/** The shell is pinned to an absolute path (#25), never resolved through PATH. */
const SHELL = "/bin/sh";

export function bashTool(client: SandboxClient, policy: Policy, ctx: ToolContext): AgentTool {
  return {
    spec: {
      name: "bash",
      description:
        "Run a shell command inside the sandbox (cwd is the worktree root). Background processes are not allowed.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeoutMs: {
            type: "integer",
            description: `default ${DEFAULT_BASH_TIMEOUT_MS}, clamped to ${MIN_BASH_TIMEOUT_MS}..${MAX_BASH_TIMEOUT_MS}`,
          },
        },
        required: ["command"],
      },
    },
    async execute(args) {
      const command = strArg(args, "command");
      if (command === undefined) return fail("command is required");
      const timeoutMs = Math.min(
        MAX_BASH_TIMEOUT_MS,
        Math.max(MIN_BASH_TIMEOUT_MS, intArg(args, "timeoutMs") ?? DEFAULT_BASH_TIMEOUT_MS),
      );
      // Advisory pre-check for a clear message; the sandbox is the boundary (#21).
      const verdict = evaluateBashCommand(policy, command);
      if (verdict.forbidden) return fail(`command not allowed: ${verdict.message}`);
      try {
        const r = await client.exec([SHELL, "-c", command], { timeoutMs });
        const parts: string[] = [];
        if (r.stdout) parts.push(`stdout:\n${r.stdout.replace(/\n$/, "")}`);
        if (r.stderr) parts.push(`stderr:\n${r.stderr.replace(/\n$/, "")}`);
        if (r.timedOut) parts.push(`timed out after ${timeoutMs}ms`);
        parts.push(`exit code ${r.exitCode}`);
        return { content: capOutput(parts.join("\n")), isError: r.exitCode !== 0 };
      } catch (e) {
        if (e instanceof RewireError && e.code === "sandbox_escape") {
          return fail(
            `background processes are not allowed: a process outlived the command and the run was killed (${e.message}). The action did not complete cleanly.`,
          );
        }
        return errorResult(e, ctx);
      }
    },
  };
}
