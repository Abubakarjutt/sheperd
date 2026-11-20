import { RewireError, RunEvent } from "@rewire/core";
import type { ChatRequest, ChatResponse, Provider } from "@rewire/providers";
import { call, FauxProvider, text } from "@rewire/providers";
import { describe, expect, test, vi } from "vitest";
import { type AgentTool, type LoopHooks, runAgent } from "../src/index.js";

const mkTool = (name: string, content = "ok", required: string[] = []) => {
  const execute = vi.fn(async (args: Record<string, unknown>) => ({
    content: name === "echo" ? String(args.value) : content,
    isError: false,
  }));
  const tool: AgentTool = {
    spec: {
      name,
      description: name,
      inputSchema: { type: "object", required },
    },
    execute,
  };
  return { tool, execute };
};

const base = (provider: Provider, tools: AgentTool[], extra: object = {}) => ({
  provider,
  model: "m",
  system: "sys",
  prompt: "go",
  tools,
  maxTurns: 10,
  emit: () => {},
  runId: "r1",
  stage: "impl",
  ...extra,
});

describe("runAgent", () => {
  test("executes tool calls and feeds results back", async () => {
    const faux = new FauxProvider([call("echo", { value: "a" }), text("done")]);
    const echo = mkTool("echo");
    const res = await runAgent(base(faux, [echo.tool]));
    expect(echo.execute).toHaveBeenCalledTimes(1);
    expect(faux.requests[1]?.messages.some((m) => m.role === "tool" && m.content === "a")).toBe(
      true,
    );
    expect(res.endedBy).toBe("model");
    expect(res.lastText).toBe("done");
    expect(res.turns).toBe(2);
  });

  test("truncated message tool calls are not executed", async () => {
    const faux = new FauxProvider([
      { toolCalls: [{ id: "", name: "write", arguments: { p: 1 } }], stopReason: "length" },
      text("ok"),
    ]);
    const write = mkTool("write");
    await runAgent(base(faux, [write.tool]));
    expect(write.execute).not.toHaveBeenCalled();
    const toolMsg = faux.requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe(
      'Tool call "write" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.',
    );
  });

  test("beforeToolCall block returns error result without executing", async () => {
    const faux = new FauxProvider([call("write", {}), text("ok")]);
    const write = mkTool("write");
    const hooks: LoopHooks = {
      beforeToolCall: async () => ({ block: true, reason: "nope" }),
    };
    await runAgent(base(faux, [write.tool], { hooks }));
    expect(write.execute).not.toHaveBeenCalled();
    expect(faux.requests[1]?.messages.find((m) => m.role === "tool")?.content).toContain("nope");
  });

  test("afterToolCall can replace the result", async () => {
    const faux = new FauxProvider([call("write", {}), text("ok")]);
    const write = mkTool("write");
    const hooks: LoopHooks = {
      afterToolCall: async () => ({ content: "replaced", isError: false }),
    };
    await runAgent(base(faux, [write.tool], { hooks }));
    expect(faux.requests[1]?.messages.find((m) => m.role === "tool")?.content).toBe("replaced");
  });

  test("finishTurn continue injects message and loops until end", async () => {
    const faux = new FauxProvider([text("a"), text("b")]);
    let n = 0;
    const hooks: LoopHooks = {
      finishTurn: async () =>
        n++ === 0 ? { action: "continue", inject: "gates failed: X" } : { action: "end" },
    };
    const res = await runAgent(base(faux, [], { hooks }));
    const last = faux.requests[1]?.messages.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toContain("gates failed: X");
    expect(res.turns).toBe(2);
    expect(res.endedBy).toBe("model");
  });

  test("stops at maxTurns with endedBy max_turns", async () => {
    const faux = new FauxProvider([call("echo", { value: "a" }), call("echo", { value: "b" })]);
    const echo = mkTool("echo");
    const res = await runAgent(base(faux, [echo.tool], { maxTurns: 2 }));
    expect(res.endedBy).toBe("max_turns");
    expect(res.turns).toBe(2);
    expect(faux.callCount).toBe(2);
  });

  test("unknown tool yields error result listing available tools", async () => {
    const faux = new FauxProvider([call("nope", {}), text("ok")]);
    const echo = mkTool("echo");
    const other = mkTool("other");
    await runAgent(base(faux, [echo.tool, other.tool]));
    const msg = faux.requests[1]?.messages.find((m) => m.role === "tool");
    expect(msg?.content).toBe('Unknown tool "nope". Available: echo, other');
  });

  test("missing required key yields error result without executing", async () => {
    const faux = new FauxProvider([call("write", { a: 1 }), text("ok")]);
    const write = mkTool("write", "ok", ["path"]);
    await runAgent(base(faux, [write.tool]));
    expect(write.execute).not.toHaveBeenCalled();
    expect(faux.requests[1]?.messages.find((m) => m.role === "tool")?.content).toContain("path");
  });

  test("a throwing tool becomes an error result and the loop continues", async () => {
    const faux = new FauxProvider([call("boom", {}), text("ok")]);
    const boom: AgentTool = {
      spec: { name: "boom", description: "", inputSchema: {} },
      execute: async () => {
        throw new Error("kaput");
      },
    };
    const res = await runAgent(base(faux, [boom]));
    expect(faux.requests[1]?.messages.find((m) => m.role === "tool")?.content).toBe(
      "Tool boom failed: kaput",
    );
    expect(res.endedBy).toBe("model");
  });

  test("stopReason tool_use with no calls injects a nudge and counts a turn", async () => {
    const faux = new FauxProvider([{ text: "hmm", stopReason: "tool_use" }, text("fine")]);
    const res = await runAgent(base(faux, []));
    const last = faux.requests[1]?.messages.at(-1);
    expect(last).toEqual({
      role: "user",
      content:
        "You indicated a tool call but none was received. Re-issue it, or answer without tools.",
    });
    expect(res.turns).toBe(2);
    expect(res.endedBy).toBe("model");
  });

  test("tool calls with stopReason end are still executed", async () => {
    const faux = new FauxProvider([
      { toolCalls: [{ id: "", name: "echo", arguments: { value: "z" } }], stopReason: "end" },
      text("done"),
    ]);
    const echo = mkTool("echo");
    await runAgent(base(faux, [echo.tool]));
    expect(echo.execute).toHaveBeenCalledTimes(1);
  });

  test("provider error gives endedBy error with the error attached", async () => {
    const provider: Provider = {
      chat: async () => {
        throw new RewireError("provider_error", "bad");
      },
    };
    const res = await runAgent(base(provider, []));
    expect(res.endedBy).toBe("error");
    expect(res.error?.code).toBe("provider_error");
  });

  test("non-RewireError throw is wrapped in loop_provider_error", async () => {
    const provider: Provider = {
      chat: async () => {
        throw new Error("weird");
      },
    };
    const res = await runAgent(base(provider, []));
    expect(res.endedBy).toBe("error");
    expect(res.error?.code).toBe("loop_provider_error");
  });

  test("stopReason error gives endedBy error", async () => {
    const provider: Provider = {
      chat: async (): Promise<ChatResponse> => ({
        message: { text: "", toolCalls: [] },
        stopReason: "error",
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    };
    const res = await runAgent(base(provider, []));
    expect(res.endedBy).toBe("error");
    expect(res.error).toBeInstanceOf(RewireError);
  });

  test("abort before the call gives endedBy aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const faux = new FauxProvider([text("x")]);
    const res = await runAgent(base(faux, [], { signal: ac.signal }));
    expect(res.endedBy).toBe("aborted");
    expect(faux.callCount).toBe(0);
  });

  test("provider_aborted gives endedBy aborted", async () => {
    const provider: Provider = {
      chat: async () => {
        throw new RewireError("provider_aborted", "aborted");
      },
    };
    const res = await runAgent(base(provider, []));
    expect(res.endedBy).toBe("aborted");
    expect(res.error).toBeUndefined();
  });

  test("abort during a tool stops remaining tools and the loop", async () => {
    const ac = new AbortController();
    const faux = new FauxProvider([
      {
        toolCalls: [
          { id: "", name: "a", arguments: {} },
          { id: "", name: "b", arguments: {} },
        ],
      },
      text("never"),
    ]);
    const a = mkTool("a");
    a.execute.mockImplementation(async () => {
      ac.abort();
      return { content: "ok", isError: false };
    });
    const b = mkTool("b");
    const res = await runAgent(base(faux, [a.tool, b.tool], { signal: ac.signal }));
    expect(res.endedBy).toBe("aborted");
    expect(b.execute).not.toHaveBeenCalled();
    expect(faux.callCount).toBe(1);
  });

  test("tool results over 64 KiB are truncated with a marker", async () => {
    const faux = new FauxProvider([call("big", {}), text("ok")]);
    const big = mkTool("big", "x".repeat(65536 + 100));
    await runAgent(base(faux, [big.tool]));
    const content = faux.requests[1]?.messages.find((m) => m.role === "tool")?.content ?? "";
    expect(content.startsWith("x".repeat(65536))).toBe(true);
    expect(content.endsWith("[truncated 100 bytes]")).toBe(true);
    expect(content.length).toBeLessThan(65536 + 60);
  });

  test("usage is summed across calls", async () => {
    let i = 0;
    const provider: Provider = {
      chat: async (_req: ChatRequest): Promise<ChatResponse> => {
        i++;
        return {
          message: {
            text: i === 1 ? "" : "done",
            toolCalls: i === 1 ? [{ id: "c1", name: "echo", arguments: { value: "a" } }] : [],
          },
          stopReason: i === 1 ? "tool_use" : "end",
          usage: { inputTokens: 10 * i, outputTokens: i },
        };
      },
    };
    const res = await runAgent(base(provider, [mkTool("echo").tool]));
    expect(res.usage).toEqual({ inputTokens: 30, outputTokens: 3 });
  });

  test("tool_call events validate against RunEvent with name + 200 char args summary", async () => {
    const events: RunEvent[] = [];
    const faux = new FauxProvider([call("echo", { value: "v".repeat(500) }), text("ok")]);
    await runAgent(base(faux, [mkTool("echo").tool], { emit: (e: RunEvent) => events.push(e) }));
    expect(events).toHaveLength(1);
    const parsed = RunEvent.parse(events[0]);
    expect(parsed.type).toBe("tool_call");
    if (parsed.type === "tool_call") {
      expect(parsed.tool).toBe("echo");
      expect(parsed.isError).toBe(false);
      expect(parsed.summary.startsWith("echo ")).toBe(true);
      expect(parsed.summary.length).toBe("echo ".length + 200);
      expect(parsed.stage).toBe("impl");
      expect(parsed.runId).toBe("r1");
    }
  });

  test("never appends an empty assistant message", async () => {
    const faux = new FauxProvider([{ text: "", stopReason: "end" }]);
    const res = await runAgent(base(faux, []));
    const asst = res.messages.filter((m) => m.role === "assistant");
    expect(asst.every((m) => m.content !== "" || (m.toolCalls?.length ?? 0) > 0)).toBe(true);
  });

  describe("finishTurn fails closed", () => {
    const run = (decision: () => Promise<unknown>) =>
      runAgent(
        base(new FauxProvider([text("a"), text("b")]), [], {
          hooks: { finishTurn: decision as NonNullable<LoopHooks["finishTurn"]> },
        }),
      );
    test("unknown action gives error loop_hook_error", async () => {
      const res = await run(async () => ({ action: "fail" }));
      expect(res.endedBy).toBe("error");
      expect(res.error?.code).toBe("loop_hook_error");
    });
    test("undefined decision gives error without rejecting", async () => {
      const res = await run(async () => undefined);
      expect(res.endedBy).toBe("error");
      expect(res.error?.code).toBe("loop_hook_error");
    });
    test("continue with missing or empty inject gives error", async () => {
      for (const d of [{ action: "continue" }, { action: "continue", inject: "" }]) {
        const res = await run(async () => d);
        expect(res.endedBy).toBe("error");
        expect(res.error?.code).toBe("loop_hook_error");
      }
    });
    test("throwing finishTurn gives loop_hook_error", async () => {
      const res = await run(async () => {
        throw new Error("hook broke");
      });
      expect(res.endedBy).toBe("error");
      expect(res.error?.code).toBe("loop_hook_error");
    });
  });
});
