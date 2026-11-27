import type { ChatSession } from "@rewire/session";

/**
 * The `/model` picker's view of the session routing. Structural copies of the pipeline's `Role`,
 * `ModelRef` and `RoleRouting` (this package does not depend on the pipeline or the providers):
 * the CLI's `RoutingControl` satisfies them.
 */
export const ROUTING_ROLES = [
  "spec",
  "test-writer",
  "implementer",
  "reviewer",
  "verifier",
] as const;
export type RoutingRole = (typeof ROUTING_ROLES)[number];
export type RoutingModel = { provider: string; model: string };
export type RoutingView = Record<RoutingRole, RoutingModel> & {
  independence: "cross-family" | "same-family";
};
/** `session`: picked this session; `file`: models.toml `[roles]`; `auto`: automatic routing. */
export type RoutingSource = "session" | "file" | "auto";

/**
 * The outcome of a pick. A refusal (`ok: false`) changed nothing: routing, providers and the
 * chat session are as they were. An applied pick that changed the chat model (`spec`) carries
 * `session`: the current conversation resumed (same session id, or a fresh session when it had
 * no completed turn yet) on the new model. The TUI must install it as its session, disposing
 * the old one, the way `/resume` swaps sessions; nothing else does.
 */
export type RoutingPick =
  | { ok: true; routing: RoutingView; note: string; session?: ChatSession }
  | { ok: false; reason: string };

/** What the `/model` picker drives (handed in by the CLI as `routingControl`). */
export type RoutingControlDep = {
  current(): RoutingView;
  available(): readonly RoutingModel[];
  source(role: RoutingRole): RoutingSource;
  /** The model family (`modelFamily`), for display. */
  family(ref: RoutingModel): string;
  /**
   * Apply a pick; `ref` undefined is the "default" pick (drops the session override). Refused
   * while a gated run or a chat turn is active. Call it only when the app is idle (inside the
   * app's exclusive section, so no turn, compaction or session swap starts meanwhile).
   */
  set(role: RoutingRole, ref: RoutingModel | undefined): RoutingPick | Promise<RoutingPick>;
};

/** The routing as text, one `role: provider:model` line per role, then the independence. */
export function routingLines(r: RoutingView): string {
  const lines = ROUTING_ROLES.map((role) => `${role}: ${r[role].provider}:${r[role].model}`);
  lines.push(`independence: ${r.independence}`);
  return lines.join("\n");
}
