import type { AgentTool } from "@rewire/loop";
import type { SandboxClient } from "@rewire/sandbox";
import { errorResult, fail, ok, protectedMessage, strArg, type ToolContext } from "./util.js";

export function writeTool(client: SandboxClient, ctx: ToolContext): AgentTool {
  return {
    spec: {
      name: "write",
      description: "Create or overwrite a file (path relative to the worktree root).",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    async execute(args) {
      const path = strArg(args, "path");
      const content = strArg(args, "content");
      if (path === undefined || content === undefined) return fail("path and content are required");
      try {
        // checkPath gives the exact deny message; client.write enforces regardless.
        const c = await client.checkPath("write", path);
        if (!c.allowed) return fail(protectedMessage(c.canonical, c.rule, ctx.stage));
        await client.write(path, content);
        return ok(`wrote ${content.length} chars to ${path}`);
      } catch (e) {
        return errorResult(e, ctx);
      }
    },
  };
}
