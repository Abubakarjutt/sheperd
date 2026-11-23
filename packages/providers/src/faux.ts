import { RewireError } from "@rewire/core";
import type { ChatRequest, ChatResponse, Provider, StopReason, ToolCall } from "./types.js";

export type ScriptedTurn = { text?: string; toolCalls?: ToolCall[]; stopReason?: StopReason };
export type ScriptEntry = ScriptedTurn | ((req: ChatRequest) => ScriptedTurn);

export const text = (s: string): ScriptedTurn => ({ text: s });
/** A tool-call turn; ids are assigned by the provider (call_1, call_2, ...). */
export const call = (name: string, args: object): ScriptedTurn => ({
  toolCalls: [{ id: "", name, arguments: args as Record<string, unknown> }],
});

export class FauxProvider implements Provider {
  readonly requests: ChatRequest[] = [];
  private readonly script: ScriptEntry[];
  private nextCallId = 1;
  private index = 0;

  constructor(script: ScriptEntry[]) {
    this.script = [...script];
  }

  get callCount(): number {
    return this.requests.length;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const { signal: _signal, ...rest } = req;
    this.requests.push(structuredClone(rest) as ChatRequest);
    const entry = this.script[this.index++];
    if (entry === undefined) {
      throw new RewireError(
        "faux_script_exhausted",
        `faux script exhausted after ${this.script.length} turns`,
      );
    }
    const turn = typeof entry === "function" ? entry(req) : entry;
    const toolCalls = (turn.toolCalls ?? []).map((c) => ({
      ...c,
      id: c.id !== "" ? c.id : `call_${this.nextCallId++}`,
    }));
    return {
      message: { text: turn.text ?? "", toolCalls },
      stopReason: turn.stopReason ?? (toolCalls.length > 0 ? "tool_use" : "end"),
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}
