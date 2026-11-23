import { describe, expect, test } from "vitest";
import { call, FauxProvider, text } from "../src/index.js";

const base = { model: "m", system: "s", maxTokens: 10 };

describe("FauxProvider", () => {
  test("plays script, records requests, deterministic call ids", async () => {
    const faux = new FauxProvider([text("hi"), call("read", { p: 1 }), call("write", {})]);
    const r1 = await faux.chat({ ...base, messages: [{ role: "user", content: "a" }] });
    expect(r1.message.text).toBe("hi");
    expect(r1.stopReason).toBe("end");
    expect(r1.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    const r2 = await faux.chat({ ...base, messages: [] });
    expect(r2.stopReason).toBe("tool_use");
    expect(r2.message.toolCalls).toEqual([{ id: "call_1", name: "read", arguments: { p: 1 } }]);
    const r3 = await faux.chat({ ...base, messages: [] });
    expect(r3.message.toolCalls[0]?.id).toBe("call_2");
    expect(faux.callCount).toBe(3);
    expect(faux.requests).toHaveLength(3);
  });
  test("deep-copies messages so later mutation does not rewrite history", async () => {
    const faux = new FauxProvider([text("x")]);
    const messages = [{ role: "user" as const, content: "orig" }];
    await faux.chat({ ...base, messages });
    const [first] = messages;
    if (first) first.content = "mutated";
    messages.push({ role: "user", content: "more" });
    expect(faux.requests[0]?.messages).toEqual([{ role: "user", content: "orig" }]);
  });
  test("function entries receive the request", async () => {
    const faux = new FauxProvider([(req) => text(`got ${req.messages.length}`)]);
    const r = await faux.chat({ ...base, messages: [{ role: "user", content: "a" }] });
    expect(r.message.text).toBe("got 1");
  });
  test("explicit stopReason honored", async () => {
    const faux = new FauxProvider([{ text: "cut", stopReason: "length" }]);
    expect((await faux.chat({ ...base, messages: [] })).stopReason).toBe("length");
  });
  test("faux_script_exhausted", async () => {
    const faux = new FauxProvider([text("only")]);
    await faux.chat({ ...base, messages: [] });
    await expect(faux.chat({ ...base, messages: [] })).rejects.toMatchObject({
      code: "faux_script_exhausted",
    });
  });
});
