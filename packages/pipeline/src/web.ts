import type { RunEvent } from "@rewire/core";
import type { AgentTool } from "@rewire/loop";
import type { Policy } from "@rewire/policy";
import { createWebTools, WEB_NOTICE, type WebAccess, webToolsOn } from "@rewire/tools";

type AuthorWeb = { on: boolean; system: (base: string) => string; tools: AgentTool[] };

/**
 * Web tools for an author-stage agent (spec and implementer only; never the test-writer,
 * reviewers or verifier): `web_search` and `web_fetch` reporting each call as a `web_request`
 * event, and the web notice for the system prompt. Without access, or with web off in policy,
 * nothing is added and the stage is byte-identical to a run without web.
 */
export function authorWeb(
  web: WebAccess | undefined,
  policy: Policy,
  stage: string,
  runId: string,
  emit: (e: RunEvent) => void,
): AuthorWeb {
  if (!webToolsOn(policy, web)) return { on: false, system: (base) => base, tools: [] };
  return {
    on: true,
    system: (base) => `${base}\n\n${WEB_NOTICE}`,
    tools: createWebTools({
      ...web,
      policy,
      onRequest: (r) =>
        emit({ type: "web_request", runId, ts: new Date().toISOString(), stage, ...r }),
    }),
  };
}
