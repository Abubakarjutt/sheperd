import { describe, expect, it } from "vitest";
import { COMMAND_HELP, DEFAULT_CHECKPOINTS, literalText, parseCommand } from "../src/commands.js";

describe("parseCommand", () => {
  it("is undefined for plain text and for a // escape", () => {
    expect(parseCommand("hello")).toBeUndefined();
    expect(parseCommand("//run x")).toBeUndefined();
    expect(literalText("//run x")).toBe("/run x");
    expect(literalText("hello")).toBe("hello");
  });

  it("/checkpoints contract commit returns that set", () => {
    const c = parseCommand("/checkpoints contract commit");
    expect(c).toEqual({ kind: "checkpoints", set: new Set(["contract", "commit"]) });
  });

  it("/checkpoints off returns the empty set", () => {
    expect(parseCommand("/checkpoints off")).toEqual({ kind: "checkpoints", set: new Set() });
  });

  it("/checkpoints with no args shows the set; an unknown kind is an error", () => {
    expect(parseCommand("/checkpoints")).toEqual({ kind: "checkpoints" });
    const bad = parseCommand("/checkpoints contract bogus");
    expect(bad?.kind).toBe("error");
    expect(bad && "message" in bad ? bad.message : "").toContain("bogus");
    expect(parseCommand("/checkpoints off tests")?.kind).toBe("error");
  });

  it("the default checkpoints are contract and tests", () => {
    expect(DEFAULT_CHECKPOINTS).toEqual(new Set(["contract", "tests"]));
  });

  it("/run with no task is an error message; /run <task> carries the task", () => {
    expect(parseCommand("/run")).toEqual({ kind: "error", message: "usage: /run <task>" });
    expect(parseCommand("/run   ")).toEqual({ kind: "error", message: "usage: /run <task>" });
    expect(parseCommand("/run add a --json flag\nto the cli")).toEqual({
      kind: "run",
      task: "add a --json flag\nto the cli",
    });
  });

  it("parses the remaining commands", () => {
    expect(parseCommand("/skills")).toEqual({ kind: "skills" });
    expect(parseCommand("/model")).toEqual({ kind: "model" });
    expect(parseCommand("/models")).toEqual({ kind: "model" });
    expect(parseCommand("/resume")).toEqual({ kind: "resume" });
    expect(parseCommand("/resume abc")).toEqual({ kind: "resume", id: "abc" });
    expect(parseCommand("/clear")).toEqual({ kind: "clear" });
    expect(parseCommand("/doctor")).toEqual({ kind: "doctor" });
    expect(parseCommand("/help")).toEqual({ kind: "help" });
    expect(parseCommand("/exit")).toEqual({ kind: "exit" });
    expect(parseCommand("/skip")).toEqual({ kind: "skip" });
  });

  it("an unknown command is reported, not sent", () => {
    expect(parseCommand("/frob x")).toEqual({ kind: "unknown", name: "/frob" });
    expect(parseCommand("/")).toEqual({ kind: "unknown", name: "/" });
  });
});

describe("command table", () => {
  it("/model is described as choosing the model for each role", () => {
    expect(COMMAND_HELP.find((c) => c.name === "model")?.description).toBe(
      "choose the model for each role",
    );
  });
});
