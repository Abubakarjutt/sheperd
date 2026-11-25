// Design adapted from pi-mono packages/agent/src/agent-loop.ts — MIT License, © 2025 Mario Zechner
import { RewireError } from "@rewire/core";
import type { ChatMessage, ChatResponse, ToolCall } from "@rewire/providers";
import type { AgentTool, RunAgentOptions, RunAgentResult, ToolResult } from "./types.js";

const MAX_RESULT_BYTES = 64 * 1024;
const NO_TEXT = "(no text)";
const NO_CALL_NUDGE =
  "You indicated a tool call but none was received. Re-issue it, or answer without tools.";

function truncate(content: string): string {
  const buf = Buffer.from(content, "utf8");
  if (buf.length <= MAX_RESULT_BYTES) return content;
  const head = buf.subarray(0, MAX_RESULT_BYTES).toString("utf8");
  return `${head}\n[truncated ${buf.length - MAX_RESULT_BYTES} bytes]`;
}

function missingRequired(tool: AgentTool, args: Record<string, unknown>): string[] {
  const required = tool.spec.inputSchema.required;
  if (!Array.isArray(required)) return [];
  return required.filter((k): k is string => typeof k === "string" && !(k in args));
}

function describe(v: unknown): string {
  let out: string | undefined;
  try {
    out = JSON.stringify(v);
  } catch {}
  if (out === undefined) {
    try {
      out = String(v);
    } catch {
      out = "<unprintable decision>";
    }
  }
  return out.length > 200 ? `${out.slice(0, 200)}...` : out;
}

async function runTool(
  call: ToolCall,
  tools: AgentTool[],
  hooks: RunAgentOptions["hooks"],
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  try {
    const tool = tools.find((t) => t.spec.name === call.name);
    let result: ToolResult;
    if (tool === undefined) {
      result = {
        content: `Unknown tool "${call.name}". Available: ${tools.map((t) => t.spec.name).join(", ")}`,
        isError: true,
      };
    } else {
      const missing = missingRequired(tool, call.arguments);
      const blocked = await hooks?.beforeToolCall?.(call);
      if (blocked?.block) {
        result = { content: blocked.reason, isError: true };
      } else if (missing.length > 0) {
        result = {
          content: `Invalid arguments for tool "${call.name}": missing required ${missing.join(", ")}`,
          isError: true,
        };
      } else {
        result = await tool.execute(call.arguments, signal);
      }
    }
    const replaced = await hooks?.afterToolCall?.(call, result);
    return replaced ?? result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { content: `Tool ${call.name} failed: ${message}`, isError: true };
  }
}

function validateHistory(history: ChatMessage[]): void {
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m?.role !== "assistant" || !m.toolCalls || m.toolCalls.length === 0) continue;
    const answered = new Set<string>();
    for (let j = i + 1; j < history.length && history[j]?.role === "tool"; j++) {
      const id = history[j]?.toolCallId;
      if (id !== undefined) answered.add(id);
    }
    const missing = m.toolCalls.filter((c) => !answered.has(c.id));
    if (missing.length > 0) {
      throw new RewireError(
        "loop_history_invalid",
        `history has tool calls without tool results: ${missing.map((c) => c.name).join(", ")}`,
      );
    }
  }
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const { provider, tools, hooks, signal } = opts;
  const history = opts.history ?? [];
  validateHistory(history);
  const messages: ChatMessage[] = [...history, { role: "user", content: opts.prompt }];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let turns = 0;
  let lastText = "";

  const finish = (endedBy: RunAgentResult["endedBy"], error?: RewireError): RunAgentResult => ({
    messages,
    turns,
    usage,
    lastText,
    endedBy,
    ...(error ? { error } : {}),
  });
  const fail = (e: unknown, code: string): RunAgentResult => {
    if (e instanceof RewireError) return finish("error", e);
    const msg = e instanceof Error ? e.message : String(e);
    return finish("error", new RewireError(code, msg));
  };

  while (true) {
    if (signal?.aborted) return finish("aborted");
    if (turns >= opts.maxTurns) return finish("max_turns");

    let res: ChatResponse;
    turns++;
    try {
      res = await provider.chat({
        model: opts.model,
        system: opts.system,
        messages: [...messages],
        tools: tools.map((t) => t.spec),
        maxTokens: opts.maxTokens ?? 8192,
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      if (signal?.aborted || (e instanceof RewireError && e.code === "provider_aborted")) {
        return finish("aborted");
      }
      return fail(e, "loop_provider_error");
    }
    if (signal?.aborted) return finish("aborted");

    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    if (res.stopReason === "error") {
      return finish(
        "error",
        new RewireError("loop_provider_error", "provider returned stopReason error"),
      );
    }

    const { text, toolCalls } = res.message;
    lastText = text;
    const assistant: ChatMessage = {
      role: "assistant",
      content: text === "" && toolCalls.length === 0 ? NO_TEXT : text,
    };
    if (toolCalls.length > 0) assistant.toolCalls = toolCalls;
    messages.push(assistant);

    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        let result: ToolResult;
        if (signal?.aborted) {
          result = {
            content: `Tool call "${call.name}" was not executed: run aborted.`,
            isError: true,
          };
        } else if (res.stopReason === "length") {
          result = {
            content: `Tool call "${call.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
            isError: true,
          };
        } else {
          result = await runTool(call, tools, hooks, signal);
        }
        const content = truncate(result.content);
        messages.push({ role: "tool", content, toolCallId: call.id });
        const argsJson = JSON.stringify(call.arguments) ?? "";
        opts.emit({
          type: "tool_call",
          runId: opts.runId,
          ts: new Date().toISOString(),
          stage: opts.stage,
          tool: call.name,
          isError: result.isError,
          summary: `${call.name} ${argsJson.slice(0, 200)}`,
        });
      }
      continue;
    }

    if (res.stopReason === "tool_use") {
      messages.push({ role: "user", content: NO_CALL_NUDGE });
      continue;
    }

    if (hooks?.finishTurn) {
      let decision: Awaited<ReturnType<NonNullable<typeof hooks.finishTurn>>>;
      try {
        decision = await hooks.finishTurn({ messages, turns, lastText });
      } catch (e) {
        return fail(e, "loop_hook_error");
      }
      const d: unknown = decision;
      let action: unknown;
      let inject: unknown;
      try {
        action = (d as { action?: unknown } | null | undefined)?.action;
        inject = (d as { inject?: unknown } | null | undefined)?.inject;
      } catch (e) {
        return fail(e, "loop_hook_error");
      }
      if (action === "continue" && typeof inject === "string" && inject !== "") {
        messages.push({ role: "user", content: inject });
        continue;
      }
      if (action !== "end") {
        return finish(
          "error",
          new RewireError(
            "loop_hook_error",
            `finishTurn returned an invalid decision: ${describe(d)}`,
          ),
        );
      }
    }
    return finish("model");
  }
}
