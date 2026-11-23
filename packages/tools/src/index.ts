import type { AgentTool } from "@rewire/loop";
import type { Policy } from "@rewire/policy";
import type { SandboxClient, StageName } from "@rewire/sandbox";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { findTool } from "./find.js";
import { grepTool } from "./grep.js";
import { readTool } from "./read.js";
import { resolveRg } from "./util.js";
import { writeTool } from "./write.js";

export type ToolName = "read" | "write" | "edit" | "bash" | "grep" | "find";

export type ToolsOptions = { policy: Policy; stage: StageName; allow: ToolName[] };

/**
 * Every filesystem/process action goes through the SandboxClient; the sandbox is the enforcement
 * boundary (#21). Checks inside tools exist only for fast, clear error messages. Tools never throw.
 */
export function createTools(client: SandboxClient, opts: ToolsOptions): AgentTool[] {
  const ctx = { stage: opts.stage };
  const rg = resolveRg(); // pinned once on the host (#25)
  const all: Record<ToolName, () => AgentTool> = {
    read: () => readTool(client, ctx),
    write: () => writeTool(client, ctx),
    edit: () => editTool(client, ctx),
    bash: () => bashTool(client, opts.policy, ctx),
    grep: () => grepTool(client, rg, ctx),
    find: () => findTool(client, rg, ctx),
  };
  return (Object.keys(all) as ToolName[])
    .filter((n) => opts.allow.includes(n))
    .map((n) => all[n]());
}

export { evaluateBashCommand } from "./commands.js";
