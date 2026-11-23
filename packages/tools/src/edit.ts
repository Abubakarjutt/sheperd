import type { AgentTool } from "@rewire/loop";
import type { SandboxClient } from "@rewire/sandbox";
import { errorResult, fail, ok, protectedMessage, strArg, type ToolContext } from "./util.js";

export function editTool(client: SandboxClient, ctx: ToolContext): AgentTool {
  return {
    spec: {
      name: "edit",
      description:
        "Replace oldString with newString in a file. Fails if oldString is absent, or ambiguous without replaceAll.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldString: { type: "string" },
          newString: { type: "string" },
          replaceAll: { type: "boolean" },
        },
        required: ["path", "oldString", "newString"],
      },
    },
    async execute(args) {
      const path = strArg(args, "path");
      const oldString = strArg(args, "oldString");
      const newString = strArg(args, "newString");
      if (path === undefined || oldString === undefined || newString === undefined) {
        return fail("path, oldString and newString are required");
      }
      if (oldString === "") return fail("oldString must not be empty");
      try {
        const text = await client.read(path);
        if (text.includes("\0")) return fail("binary file, not editable");
        const parts = text.split(oldString);
        const count = parts.length - 1;
        if (count === 0) return fail("oldString not found");
        if (count > 1 && args.replaceAll !== true) {
          return fail(`oldString matches ${count} times; pass replaceAll or add context`);
        }
        const all = args.replaceAll === true;
        const next = all ? parts.join(newString) : text.replace(oldString, () => newString);
        const c = await client.checkPath("write", path);
        if (!c.allowed) return fail(protectedMessage(c.canonical, c.rule, ctx.stage));
        await client.write(path, next);
        const n = all ? count : 1;
        return ok(`edited ${path} (${n} replacement${n === 1 ? "" : "s"})`);
      } catch (e) {
        return errorResult(e, ctx);
      }
    },
  };
}
