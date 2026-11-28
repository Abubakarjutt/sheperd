// Design adapted from pi-mono packages/agent/src/agent-loop.ts — MIT License, © 2025 Mario Zechner
import type { RewireError, RunEvent } from "@rewire/core";
import type { ChatMessage, Provider, ToolCall, ToolSpec, Usage } from "@rewire/providers";

export type ToolResult = {
  content: string;
  isError: boolean;
  /**
   * Display-only lines for a UI's preview of this result, instead of the start of `content`
   * (e.g. the web tools' result titles). Never sent to the model; untrusted text, so a renderer
   * still sanitizes and redacts it.
   */
  preview?: string[];
};

export type AgentTool = {
  spec: ToolSpec;
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
  /**
   * What the `tool_call` event shows after the tool name, instead of the raw JSON arguments
   * (for a tool whose arguments may carry what must never be logged). A throwing hook shows
   * `[summary unavailable]`, never the arguments.
   */
  summary?(args: Record<string, unknown>): string;
  /**
   * Arguments to keep in the message history instead of the model's own, or undefined to keep
   * them (for a call whose arguments must never be stored or sent again, e.g. a refused secret).
   * The tool still runs with the real arguments. A throwing hook stores
   * `{ refused: "arguments unavailable" }`, never the arguments.
   */
  storedArguments?(args: Record<string, unknown>): Record<string, unknown> | undefined;
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
  /**
   * Streamed assistant text: passed to each model call as `ChatRequest.onDelta`, so the provider
   * streams. Raw model text (not redacted or sanitized). When unset, requests carry no `onDelta`
   * and are sent exactly as before. A throw from it fails the call (`provider_stream_callback_failed`).
   */
  onText?: (delta: string) => void;
  /** Called after each successful model call with that call's usage. A throw is ignored. */
  onUsage?: (usage: Usage) => void;
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
