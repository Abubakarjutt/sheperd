import type { RunEvent } from "@rewire/core";
import type { AgentTool } from "@rewire/loop";
import { type SkillSet, skillIndex, skillTool } from "@rewire/skills";

type Author = { system: (base: string) => string; tools: AgentTool[] };

// One skill tool per stage per run (per set): retries and fix rounds reuse it, so a skill is
// reported once per stage however often the stage's agent is restarted.
const memo = new WeakMap<SkillSet, Map<string, Author>>();

/**
 * Skills for an author-stage agent: the index section for its system prompt and a `skill` tool
 * (memoised per set, run and stage). With no set, nothing is added and the stage is
 * byte-identical to a run without skills. review and verify never call this.
 */
export function authorSkills(
  set: SkillSet | undefined,
  stage: string,
  runId: string,
  emit: (e: RunEvent) => void,
): Author {
  if (set === undefined) return { system: (base) => base, tools: [] };
  const byKey = memo.get(set) ?? new Map<string, Author>();
  memo.set(set, byKey);
  const key = `${runId}\0${stage}`;
  const hit = byKey.get(key);
  if (hit) return hit;
  const send = (name: string, source: "user" | "repo", sha256: string): void =>
    emit({
      type: "skill_loaded",
      runId,
      ts: new Date().toISOString(),
      stage,
      name,
      source,
      sha256,
    });
  const made: Author = {
    system: (base) => `${base}\n\n${skillIndex(set)}`,
    tools: [
      skillTool(set, (s) => {
        send(s.name, s.source, s.sha256);
      }),
    ],
  };
  byKey.set(key, made);
  return made;
}

/** Release a finished run's tools (and the event log they close over). */
export function endRunSkills(set: SkillSet | undefined, runId: string): void {
  const byKey = set && memo.get(set);
  if (!byKey) return;
  for (const k of [...byKey.keys()]) if (k.startsWith(`${runId}\0`)) byKey.delete(k);
}

/** @internal test seam: number of memoised stage entries for a run. */
export function skillMemoSize(set: SkillSet, runId: string): number {
  return [...(memo.get(set)?.keys() ?? [])].filter((k) => k.startsWith(`${runId}\0`)).length;
}
