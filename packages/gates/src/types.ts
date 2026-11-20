import type { Contract, FrozenTestManifest, GateResult, SlopCategory } from "@rewire/core";
import type { TsPack } from "@rewire/pack-typescript";
import type { Policy } from "@rewire/policy";
import type { SandboxClient } from "@rewire/sandbox";

export type GateContext = {
  worktree: string;
  baseRef: string;
  client: SandboxClient;
  registryClient: SandboxClient;
  pack: TsPack;
  policy: Policy;
  manifest?: FrozenTestManifest;
  contract?: Contract;
  scratch: string;
  /** Run id stamped on emitted gate_result events. Defaults to "unknown". */
  runId?: string;
  /** Stage name stamped on emitted gate_result events. Defaults to "verify". */
  stage?: string;
  /**
   * Aborted when the gate times out. Gate implementations MUST honor it
   * (stop work, kill children): a gate that ignores it keeps running in the
   * background after the runner has already recorded it as an error.
   * When passed in by the caller and aborted, remaining gates are recorded
   * as errors ("aborted") without running.
   */
  signal?: AbortSignal;
};

export type GateOutput = Omit<GateResult, "durationMs" | "gate" | "category">;

export interface Gate {
  name: string;
  category: SlopCategory;
  run(ctx: GateContext): Promise<GateOutput>;
}
