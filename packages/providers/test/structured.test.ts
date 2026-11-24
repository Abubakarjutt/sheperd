import { Contract, RewireError } from "@rewire/core";
import { describe, expect, test } from "vitest";
import { extractFirstJsonObject, FauxProvider, structured, text } from "../src/index.js";

const fauxRef = { provider: "faux", model: "t" } as const;
const req = { system: "sys", messages: [{ role: "user" as const, content: "go" }], maxTokens: 100 };
const valid = {
  id: "c1",
  title: "t",
  criteria: [{ id: "a", kind: "change", statement: "s" }],
  nonGoals: [],
  affectedAreas: [],
  openQuestions: [],
};

describe("structured", () => {
  test("structured_output_retries_once_then_throws", async () => {
    const faux = new FauxProvider([text("not json"), text('{"wrong":1}')]);
    await expect(structured(faux, fauxRef, Contract, req)).rejects.toMatchObject({
      code: "structured_output_invalid",
    });
    expect(faux.callCount).toBe(2);
  });
  test("succeeds on repair and repair prompt contains zod error", async () => {
    const faux = new FauxProvider([text('{"id":"x"}'), text(JSON.stringify(valid))]);
    const out = await structured(faux, fauxRef, Contract, req);
    expect(out).toEqual(valid);
    expect(faux.callCount).toBe(2);
    const second = faux.requests[1] ?? expect.fail("no second request");
    const last = second.messages.at(-1) ?? expect.fail("no messages");
    expect(last.role).toBe("user");
    expect(last.content).toContain("criteria");
    expect(second.messages.at(-2)).toMatchObject({
      role: "assistant",
      content: '{"id":"x"}',
    });
    expect(faux.requests[0]?.system).toContain("JSON");
    expect(faux.requests[0]?.system).toContain("criteria");
  });
  test("first-try success makes one call", async () => {
    const faux = new FauxProvider([text(`Here:\n${JSON.stringify(valid)}\nDone.`)]);
    expect(await structured(faux, fauxRef, Contract, req)).toEqual(valid);
    expect(faux.callCount).toBe(1);
  });
  test("stopReason length/error counts as failed attempt", async () => {
    const faux = new FauxProvider([
      { text: JSON.stringify(valid), stopReason: "length" },
      { text: JSON.stringify(valid), stopReason: "error" },
    ]);
    await expect(structured(faux, fauxRef, Contract, req)).rejects.toMatchObject({
      code: "structured_output_invalid",
    });
    expect(faux.callCount).toBe(2);
  });
});

describe("extractFirstJsonObject", () => {
  test("prose before and after", () => {
    expect(extractFirstJsonObject('sure! {"a":1} thanks')).toBe('{"a":1}');
  });
  test("nested braces", () => {
    expect(extractFirstJsonObject('x {"a":{"b":{"c":1}},"d":[{}]} y {"z":1}')).toBe(
      '{"a":{"b":{"c":1}},"d":[{}]}',
    );
  });
  test("braces inside strings", () => {
    expect(extractFirstJsonObject('{"a":"}{ not real","b":"{"} tail')).toBe(
      '{"a":"}{ not real","b":"{"}',
    );
  });
  test("escaped quotes", () => {
    expect(extractFirstJsonObject('{"a":"say \\"}\\" ok"} tail')).toBe('{"a":"say \\"}\\" ok"}');
  });
  test("no object", () => {
    expect(extractFirstJsonObject("no json here")).toBeUndefined();
    expect(extractFirstJsonObject('{"unterminated":1')).toBeUndefined();
  });
});

describe("structured abort", () => {
  test("provider_aborted propagates immediately without retry", async () => {
    let n = 0;
    const faux = new FauxProvider([
      () => {
        n++;
        throw new RewireError("provider_aborted", "aborted");
      },
      text("{}"),
    ]);
    await expect(structured(faux, fauxRef, Contract, req)).rejects.toMatchObject({
      code: "provider_aborted",
    });
    expect(n).toBe(1);
    expect(faux.callCount).toBe(1);
  });
});
