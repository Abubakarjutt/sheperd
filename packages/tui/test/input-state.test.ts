import { describe, expect, it } from "vitest";
import {
  type InputAction,
  type InputState,
  initialInput,
  reduceInput,
} from "../src/input-state.js";

const run = (actions: InputAction[], from: InputState = initialInput) => {
  let state = from;
  const submitted: string[] = [];
  for (const a of actions) {
    const r = reduceInput(state, a);
    state = r.state;
    if (r.submitted !== undefined) submitted.push(r.submitted);
  }
  return { state, submitted };
};
const type = (t: string): InputAction => ({ type: "insert", text: t });

describe("reduceInput", () => {
  it("submits typed text and clears the box", () => {
    const { state, submitted } = run([type("hi"), { type: "submit" }]);
    expect(submitted).toEqual(["hi"]);
    expect(state.value).toBe("");
  });
  it("does not submit blank text", () => {
    expect(run([type("  "), { type: "submit" }]).submitted).toEqual([]);
  });
  it("newline action and trailing backslash both add a line without submitting", () => {
    const a = run([type("a"), { type: "newline" }, type("b"), { type: "submit" }]);
    expect(a.submitted).toEqual(["a\nb"]);
    const b = run([type("a\\"), { type: "submit" }, type("b"), { type: "submit" }]);
    expect(b.submitted).toEqual(["a\nb"]);
  });
  it("backspace removes the last character", () => {
    expect(run([type("abc"), { type: "backspace" }]).state.value).toBe("ab");
  });
  it("up/down browse history and restore the draft", () => {
    const s = run([type("one"), { type: "submit" }, type("two"), { type: "submit" }]).state;
    const r = run([type("dr"), { type: "up" }, { type: "up" }, { type: "up" }], s);
    expect(r.state.value).toBe("one");
    const d = run([{ type: "down" }, { type: "down" }], r.state);
    expect(d.state.value).toBe("dr");
    expect(run([{ type: "down" }], d.state).state.value).toBe("dr");
  });
  it("up with no history is a no-op and consecutive duplicates are stored once", () => {
    expect(run([type("x"), { type: "up" }]).state.value).toBe("x");
    const s = run([type("a"), { type: "submit" }, type("a"), { type: "submit" }]).state;
    expect(s.history).toEqual(["a"]);
  });
});
