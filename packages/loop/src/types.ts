// Design adapted from pi-mono packages/agent/src/agent-loop.ts — MIT License, © 2025 Mario Zechner
import type { RewireError, RunEvent } from "@rewire/core";
import type { ChatMessage, Provider, ToolCall, ToolSpec, Usage } from "@rewire/providers";

export type ToolResult = { content: string; isError: boolean };

export type AgentTool = {
  spec: ToolSpec;
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
};

export type LoopState = { messages: ChatMessage[]; turns: number; lastText: string };

export type LoopHooks = {
  beforeToolCall?(call: ToolCall): Promise<{ block: true; reason: string } | undefined>;
  afterToolCall?(call: ToolCall, result: ToolResult): Promise<ToolResult | undefined>;
  finishTurn?(
    state: LoopState,
  ): Promise<{ action: "end" } | { action: "continue"; inject: string }>;
};

export type RunAgentOptions = {
  provider: Provider;
  model: string;
  system: string;
  prompt: string;
  /** Prior conversation; the loop continues from it. Must not end in a dangling tool call. */
  history?: ChatMessage[];
  tools: AgentTool[];
  hooks?: LoopHooks;
  maxTurns: number;
  /** Default 8192. */
  maxTokens?: number;
  emit: (e: RunEvent) => void;
  runId: string;
  stage: string;
  signal?: AbortSignal;
};

export type RunAgentResult = {
  messages: ChatMessage[];
  turns: number;
  usage: Usage;
  lastText: string;
  endedBy: "model" | "max_turns" | "aborted" | "error";
  /** Present only when endedBy is "error". */
  error?: RewireError;
};
