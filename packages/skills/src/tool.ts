import { fenceUntrusted } from "@rewire/core";
import type { AgentTool, ToolResult } from "@rewire/loop";
import type { Skill } from "./discover.js";
import { safeName } from "./hash.js";
import { invocable, type SkillSet } from "./snapshot.js";

const MAX_LISTED = 200;

const fail = (content: string): ToolResult => ({ content, isError: true });

function nameList(names: string[]): string {
  const shown = names.slice(0, MAX_LISTED).join(", ");
  return names.length > MAX_LISTED ? `${shown} (+${names.length - MAX_LISTED} more)` : shown;
}

/**
 * The on-demand `skill` tool. A skill is materialized once per set (see `createSkillSet`); this
 * tool instance calls `onLoad` the first time IT loads each skill.
 */
export function skillTool(set: SkillSet, onLoad: (s: Skill) => void): AgentTool {
  // Reported per tool instance, so each stage that builds its own tool records what it used.
  const reported = new Set<string>();
  return {
    spec: {
      name: "skill",
      description:
        "Load a skill by name: returns its instructions and the directory holding its bundled files. Use the names in the skills index.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "skill name from the index" } },
        required: ["name"],
      },
    },
    async execute(args) {
      const name = typeof args.name === "string" ? args.name : "";
      const names = invocable(set.skills).map((s) => s.name);
      if (!names.includes(name)) {
        return fail(`unknown skill. Available skills: ${nameList(names) || "(none)"}`);
      }
      try {
        const loaded = await set.load(name);
        if (!reported.has(name)) {
          reported.add(name);
          try {
            onLoad(loaded.skill);
          } catch {
            // an observer must not break the load
          }
        }
        const s = loaded.skill;
        const lines = [`Skill "${s.name}" (source: ${s.source}).`];
        if (loaded.dir !== undefined) {
          lines.push(`Bundled files (read-only copy) are in: ${loaded.dir}`);
          const shown = loaded.files.slice(0, MAX_LISTED).map((f) => `- ${safeName(f.path)}`);
          if (loaded.files.length > MAX_LISTED) {
            shown.push(`(+${loaded.files.length - MAX_LISTED} more files)`);
          }
          lines.push("Files:", ...shown);
        } else {
          lines.push(`bundled files unavailable: ${loaded.unavailable ?? "not materialized"}`);
        }
        lines.push("", fenceUntrusted("untrusted_skill", loaded.body));
        return { content: lines.join("\n"), isError: false };
      } catch (e) {
        const code = e && typeof e === "object" && "code" in e ? String(e.code) : "skill_invalid";
        const msg = e instanceof Error ? e.message : "cannot load skill";
        return fail(`${code}: ${msg}`);
      }
    },
  };
}
