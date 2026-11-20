import type { AgentTool } from "@rewire/loop";
import type { SandboxClient } from "@rewire/sandbox";
import { errorResult, fail, intArg, ok, strArg, type ToolContext } from "./util.js";

export const READ_LINE_CAP = 2000;

export function readTool(client: SandboxClient, ctx: ToolContext): AgentTool {
  return {
    spec: {
      name: "read",
      description: `Read a text file (path relative to the worktree root). Output is capped at ${READ_LINE_CAP} lines; use offset (1-based line) and limit to page.`,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "integer", description: "1-based first line" },
          limit: { type: "integer", description: "max lines" },
        },
        required: ["path"],
      },
    },
    async execute(args) {
      const path = strArg(args, "path");
      if (path === undefined) return fail("path is required");
      try {
        const text = await client.read(path);
        if (text.includes("\0")) return ok("binary file, not shown");
        const lines = text.split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        const offset = Math.max(1, intArg(args, "offset") ?? 1);
        const limit = Math.min(READ_LINE_CAP, Math.max(1, intArg(args, "limit") ?? READ_LINE_CAP));
        const window = lines.slice(offset - 1, offset - 1 + limit);
        const remaining = Math.max(0, lines.length - (offset - 1 + window.length));
        let out = window.join("\n");
        if (remaining > 0) out += `\n[truncated: ${remaining} more lines]`;
        return ok(out);
      } catch (e) {
        return errorResult(e, ctx);
      }
    },
  };
}
