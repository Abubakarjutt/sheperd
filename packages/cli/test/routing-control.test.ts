import { RewireError } from "@rewire/core";
import type { RoleRouting } from "@rewire/pipeline";
import { FauxProvider, type ModelRef, type Provider } from "@rewire/providers";
import { describe, expect, test } from "vitest";
import { RoutingControl } from "../src/routing-control.js";

const qwen: ModelRef = { provider: "ollama", model: "qwen2.5-coder:7b" };
const qwen3: ModelRef = { provider: "ollama", model: "qwen3:8b" };
const llama: ModelRef = { provider: "ollama", model: "llama3.1:8b" };
const gemma: ModelRef = { provider: "ollama", model: "gemma3:4b" };

const ok = (): Provider => new FauxProvider([]);

function control(
  available: ModelRef[],
  fileOverrides: Partial<Record<string, ModelRef>> = {},
  providers: (ref: ModelRef) => Provider = ok,
) {
  return new RoutingControl({ available, fileOverrides, providers });
}

const show = (r: ModelRef) => `${r.provider}:${r.model}`;

describe("RoutingControl", () => {
  test("starts at resolveRouting(available, file overrides); sources say where each role comes from", () => {
    const c = control([qwen, llama, qwen3], { "test-writer": qwen3 });
    expect(show(c.current().spec)).toBe(show(qwen));
    expect(show(c.current()["test-writer"])).toBe(show(qwen3));
    expect(show(c.current().reviewer)).toBe(show(llama));
    expect(c.source("test-writer")).toBe("file");
    expect(c.source("spec")).toBe("auto");
    expect(c.available().map(show)).toEqual([qwen, llama, qwen3].map(show));
  });

  test("an applied pick changes that role, its source becomes session, and the note names it", () => {
    const c = control([qwen, llama, qwen3]);
    const pick = c.set("spec", qwen3);
    expect(pick.ok).toBe(true);
    if (!pick.ok) return;
    expect(show(pick.routing.spec)).toBe(show(qwen3));
    expect(show(c.current().spec)).toBe(show(qwen3));
    expect(c.source("spec")).toBe("session");
    expect(pick.note).toContain(show(qwen3));
    expect(pick.note).not.toContain("same-family");
  });

  test("a reviewer of the implementer's family is refused while another family exists; nothing changes", () => {
    const c = control([qwen, llama, qwen3]);
    const before = c.current();
    const fired: RoleRouting[] = [];
    c.onChange((r) => fired.push(r));
    const pick = c.set("reviewer", qwen3);
    expect(pick.ok).toBe(false);
    if (pick.ok) return;
    expect(pick.reason).toContain("qwen");
    expect(pick.reason).toContain("llama");
    expect(c.current()).toEqual(before);
    expect(c.source("reviewer")).toBe("auto");
    expect(fired).toEqual([]);
  });

  test("a verifier of the implementer's family is refused too", () => {
    const c = control([qwen, llama, qwen3]);
    const pick = c.set("verifier", qwen3);
    expect(pick.ok).toBe(false);
  });

  test("with a single family, a same-family pick applies and the note says same-family", () => {
    const c = control([qwen, qwen3]);
    const pick = c.set("reviewer", qwen3);
    expect(pick.ok).toBe(true);
    if (!pick.ok) return;
    expect(pick.note).toContain("same-family");
    expect(pick.routing.independence).toBe("same-family");
  });

  test("an implementer change that makes an explicit reviewer override same-family is refused", () => {
    const c = control([qwen, llama, qwen3, gemma], { reviewer: llama });
    const before = c.current();
    const pick = c.set("implementer", { provider: "ollama", model: "llama3.1:8b" });
    expect(pick.ok).toBe(false);
    if (pick.ok) return;
    expect(pick.reason).toContain("llama");
    expect(c.current()).toEqual(before);
    expect(c.source("implementer")).toBe("auto");
  });

  test("a default pick clears the session override: back to the file's override, or automatic", () => {
    const c = control([qwen, llama, qwen3], { "test-writer": qwen3 });
    expect(c.set("test-writer", llama).ok).toBe(true);
    expect(c.source("test-writer")).toBe("session");
    const back = c.set("test-writer", undefined);
    expect(back.ok).toBe(true);
    expect(c.source("test-writer")).toBe("file");
    expect(show(c.current()["test-writer"])).toBe(show(qwen3));

    expect(c.set("spec", llama).ok).toBe(true);
    expect(c.set("spec", undefined).ok).toBe(true);
    expect(c.source("spec")).toBe("auto");
    expect(show(c.current().spec)).toBe(show(qwen));
  });

  test("a model that is not available is refused", () => {
    const c = control([qwen, llama]);
    const pick = c.set("spec", gemma);
    expect(pick.ok).toBe(false);
    expect(c.source("spec")).toBe("auto");
  });

  test("a provider that cannot be created is refused with its message; routing unchanged", () => {
    const c = control([qwen, llama, qwen3], {}, (ref) => {
      if (ref.model === qwen3.model) {
        throw new RewireError("provider_auth_missing", "qwen3 needs QWEN_KEY");
      }
      return new FauxProvider([]);
    });
    const before = c.current();
    const fired: RoleRouting[] = [];
    c.onChange((r) => fired.push(r));
    const pick = c.set("spec", qwen3);
    expect(pick).toEqual({ ok: false, reason: "qwen3 needs QWEN_KEY" });
    expect(c.current()).toEqual(before);
    expect(c.source("spec")).toBe("auto");
    expect(fired).toEqual([]);
  });

  test("onChange fires only on applied picks, and its unsubscribe works", () => {
    const c = control([qwen, llama, qwen3]);
    const fired: string[] = [];
    const off = c.onChange((r) => fired.push(show(r.spec)));
    c.set("reviewer", qwen3); // refused
    c.set("spec", qwen3);
    expect(fired).toEqual([show(qwen3)]);
    off();
    c.set("spec", llama);
    expect(fired).toEqual([show(qwen3)]);
  });

  test("current() is a snapshot: a later pick never changes a routing already handed out", () => {
    const c = control([qwen, llama, qwen3]);
    const held = c.current();
    c.set("implementer", qwen3);
    expect(show(held.implementer)).toBe(show(qwen));
    expect(show(c.current().implementer)).toBe(show(qwen3));
  });

  test("plan validates without changing anything; commit applies it and fires onChange once", () => {
    const c = control([qwen, llama, qwen3]);
    const before = c.current();
    const fired: string[] = [];
    c.onChange((r) => fired.push(show(r.spec)));
    const plan = c.plan("spec", qwen3);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(show(plan.routing.spec)).toBe(show(qwen3));
    expect(c.current()).toBe(before);
    expect(c.source("spec")).toBe("auto");
    expect(fired).toEqual([]);
    const pick = plan.commit();
    expect(pick.ok).toBe(true);
    expect(show(c.current().spec)).toBe(show(qwen3));
    expect(c.source("spec")).toBe("session");
    expect(fired).toEqual([show(qwen3)]);
  });

  test("a refused plan is the same refusal set returns", () => {
    const c = control([qwen, llama, qwen3]);
    expect(c.plan("reviewer", qwen3).ok).toBe(false);
  });

  test("a plan whose base changed meanwhile is not committed", () => {
    const c = control([qwen, llama, qwen3]);
    const plan = c.plan("spec", qwen3);
    expect(c.set("test-writer", llama).ok).toBe(true);
    if (!plan.ok) throw new Error("plan refused");
    const late = plan.commit();
    expect(late.ok).toBe(false);
    expect(show(c.current().spec)).toBe(show(qwen));
  });

  test("a default pick back to the models file's routing is allowed even when it is same-family", () => {
    // The file pairs the reviewer with the implementer's family on purpose.
    const c = control([qwen, llama, qwen3], { reviewer: qwen3 });
    expect(c.set("reviewer", llama).ok).toBe(true);
    const back = c.set("reviewer", undefined);
    expect(back.ok).toBe(true);
    expect(show(c.current().reviewer)).toBe(show(qwen3));
    expect(c.source("reviewer")).toBe("file");
    // A new same-family pairing is still refused.
    expect(c.set("verifier", qwen).ok).toBe(false);
  });

  test("a throwing onChange listener does not turn an applied pick into a throw", () => {
    const c = control([qwen, llama, qwen3]);
    const fired: string[] = [];
    c.onChange(() => {
      throw new Error("listener bug");
    });
    c.onChange((r) => fired.push(show(r.spec)));
    const pick = c.set("spec", qwen3);
    expect(pick.ok).toBe(true);
    expect(fired).toEqual([show(qwen3)]);
  });
});
