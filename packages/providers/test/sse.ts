/** Test helpers: server-sent-event bodies for the OpenAI chat-completions and Anthropic streams. */

export type StreamToolCall = { id: string; name: string; argPieces: string[] };

/** OpenAI-style chat.completion.chunk objects (text pieces, indexed tool-call deltas, usage chunk). */
export function openaiChunks(opts: {
  text?: string[];
  toolCalls?: StreamToolCall[];
  finish: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}): unknown[] {
  const base = { id: "c", object: "chat.completion.chunk", created: 1, model: "m" };
  const choice = (delta: unknown, finish_reason: string | null = null) => ({
    ...base,
    choices: [{ index: 0, delta, finish_reason }],
  });
  const out: unknown[] = [choice({ role: "assistant", content: "" })];
  for (const t of opts.text ?? []) out.push(choice({ content: t }));
  (opts.toolCalls ?? []).forEach((c, index) => {
    out.push(
      choice({
        tool_calls: [
          { index, id: c.id, type: "function", function: { name: c.name, arguments: "" } },
        ],
      }),
    );
    for (const p of c.argPieces) {
      out.push(choice({ tool_calls: [{ index, function: { arguments: p } }] }));
    }
  });
  out.push(choice({}, opts.finish));
  if (opts.usage) out.push({ ...base, choices: [], usage: opts.usage });
  return out;
}

export function openaiSSE(chunks: unknown[], done = true): string {
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}${done ? "data: [DONE]\n\n" : ""}`;
}

/** Anthropic messages stream events for text blocks and tool_use blocks (input_json_delta). */
export function anthropicEvents(opts: {
  blocks: ({ type: "text"; pieces: string[] } | ({ type: "tool_use" } & StreamToolCall))[];
  stop: string;
  usage: { input_tokens: number; output_tokens: number };
}): { event: string; data: unknown }[] {
  const out: { event: string; data: unknown }[] = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "m",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: opts.usage.input_tokens, output_tokens: 1 },
        },
      },
    },
  ];
  opts.blocks.forEach((b, index) => {
    if (b.type === "text") {
      out.push({
        event: "content_block_start",
        data: { type: "content_block_start", index, content_block: { type: "text", text: "" } },
      });
      for (const p of b.pieces) {
        out.push({
          event: "content_block_delta",
          data: { type: "content_block_delta", index, delta: { type: "text_delta", text: p } },
        });
      }
    } else {
      out.push({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: b.id, name: b.name, input: {} },
        },
      });
      for (const p of b.argPieces) {
        out.push({
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: p },
          },
        });
      }
    }
    out.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
  });
  out.push({
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: opts.stop, stop_sequence: null },
      usage: { output_tokens: opts.usage.output_tokens },
    },
  });
  out.push({ event: "message_stop", data: { type: "message_stop" } });
  return out;
}

export function anthropicSSE(events: { event: string; data: unknown }[]): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
}

/**
 * A fetch whose replies are scripted per request. `body` is the parsed JSON request body.
 * A reply that is `{ sse, hangAfter }` streams `sse` and then (if hangAfter) never closes,
 * erroring only when the request's signal aborts.
 */
export type FetchReply = { json: unknown } | { sse: string; hang?: boolean };
export function scriptedFetch(reply: (body: Record<string, unknown>) => FetchReply) {
  const bodies: Record<string, unknown>[] = [];
  const fetch = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    bodies.push(body);
    const r = reply(body);
    if ("json" in r) {
      return new Response(JSON.stringify(r.json), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const signal = init?.signal ?? undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(r.sse));
        if (!r.hang) {
          controller.close();
          return;
        }
        const fail = () => controller.error(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted) fail();
        else signal?.addEventListener("abort", fail, { once: true });
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch, bodies };
}
