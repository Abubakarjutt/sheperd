import type { RunEvent } from "@rewire/core";
import type { AgentTool } from "@rewire/loop";
import { type SkillSet, skillIndex, skillTool } from "@rewire/skills";

/**
 * Skills for ONE author-stage agent: the index section for its system prompt and a fresh `skill`
 * tool (one per stage, so each stage records what it loaded). With no set, nothing is added and
 * the stage is byte-identical to a run without skills. review and verify never call this.
 */
export function authorSkills(
  set: SkillSet | undefined,
  stage: string,
  runId: string,
  emit: (e: RunEvent) => void,
): { system: (base: string) => string; tools: AgentTool[] } {
  if (set === undefined) return { system: (base) => base, tools: [] };
  return {
    system: (base) => `${base}\n\n${skillIndex(set)}`,
    tools: [
      skillTool(set, (s) => {
        if (s.sha256 === undefined) return;
        emit({
          type: "skill_loaded",
          runId,
          ts: new Date().toISOString(),
          stage,
          name: s.name,
          source: s.source,
          sha256: s.sha256,
        });
      }),
    ],
  };
}
