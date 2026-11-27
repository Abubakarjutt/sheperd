// Task 6: the pure logic behind the `/` command menu and the `@` file picker.
import { describe, expect, it } from "vitest";
import { menuItems, menuQuery, menuWindow } from "../src/command-menu.js";
import { allowedInRun, COMMAND_HELP, HELP, parseCommand } from "../src/commands.js";
import { atToken, insertPath, rankFiles, splitPath } from "../src/file-picker.js";
import { initialInput, reduceInput } from "../src/input-state.js";

const names = (q: string, inRun = false) => menuItems(q, inRun).map((c) => c.name);

describe("command menu", () => {
  it("opens only for one line that starts with / and has no space yet", () => {
    expect(menuQuery("/")).toBe("");
    expect(menuQuery("/ru")).toBe("ru");
    expect(menuQuery("/run ")).toBeUndefined();
    expect(menuQuery("/run x")).toBeUndefined();
    expect(menuQuery("//etc")).toBeUndefined();
    expect(menuQuery("hi /run")).toBeUndefined();
    expect(menuQuery("/ru\nx")).toBeUndefined();
    expect(menuQuery("")).toBeUndefined();
  });

  it("filters by prefix first, then by substring", () => {
    expect(names("ru")).toEqual(["run"]);
    expect(names("s")).toEqual(["skills", "skip", "checkpoints", "resume"]);
    expect(names("e")[0]).toBe("exit");
    expect(names("e")).toContain("resume");
    expect(names("zz")).toEqual([]);
    expect(names("RU")).toEqual(["run"]);
  });

  it("lists every command for a bare slash, in table order", () => {
    expect(names("")).toEqual(COMMAND_HELP.map((c) => c.name));
  });

  it("lists only the commands allowed in a run while one is active", () => {
    const inRun = names("", true);
    expect(inRun.sort()).toEqual(["checkpoints", "context", "help", "model", "skills", "skip"]);
    for (const n of inRun) {
      const cmd = parseCommand(`/${n}`);
      expect(cmd && allowedInRun(cmd)).toBe(true);
    }
    expect(names("ru", true)).toEqual([]);
    // /compact is idle-only: not listed in a run, and refused there.
    expect(names("comp", true)).toEqual([]);
    expect(names("comp")).toEqual(["compact"]);
    expect(allowedInRun({ kind: "compact" })).toBe(false);
  });

  it("windows 8 rows around the selection", () => {
    expect(menuWindow(10, 0)).toBe(0);
    expect(menuWindow(10, 7)).toBe(0);
    expect(menuWindow(10, 9)).toBe(2);
    expect(menuWindow(3, 2)).toBe(0);
  });

  it("/help is built from the same table", () => {
    for (const c of COMMAND_HELP) {
      expect(HELP).toContain(`/${c.name}`);
      expect(HELP).toContain(c.description);
    }
  });
});

describe("file picker", () => {
  it("opens on an @ token at the start or after whitespace, not inside a word", () => {
    expect(atToken("@src")).toEqual({ start: 0, query: "src" });
    expect(atToken("look at @src/ma")).toEqual({ start: 8, query: "src/ma" });
    expect(atToken("x\n@a")).toEqual({ start: 2, query: "a" });
    expect(atToken("@")).toEqual({ start: 0, query: "" });
    expect(atToken("a@b")).toBeUndefined();
    expect(atToken("mail me at a@b.com")).toBeUndefined();
    expect(atToken("@src ")).toBeUndefined();
    expect(atToken("")).toBeUndefined();
  });

  it("matches case-insensitive subsequences", () => {
    const files = ["src/math.ts", "README.md", "lib/x.js"];
    expect(rankFiles(files, "smt")).toEqual(["src/math.ts"]);
    expect(rankFiles(files, "READ")).toEqual(["README.md"]);
    expect(rankFiles(files, "readme")).toEqual(["README.md"]);
    expect(rankFiles(files, "zq")).toEqual([]);
  });

  it("ranks basename prefix, then path prefix, then the shortest path", () => {
    const files = [
      "deep/nested/dir/xmath.ts", // subsequence only
      "test/math.test.ts", // basename prefix, longer
      "src/math.ts", // basename prefix, shorter
      "mat/other.ts", // path prefix only
      "m/a/t/h.ts", // subsequence only, shorter
    ];
    expect(rankFiles(files, "mat")).toEqual([
      "src/math.ts",
      "test/math.test.ts",
      "mat/other.ts",
      "m/a/t/h.ts",
      "deep/nested/dir/xmath.ts",
    ]);
  });

  it("shows at most 8 matches", () => {
    const files = Array.from({ length: 30 }, (_, i) => `f${i}.ts`);
    expect(rankFiles(files, "f")).toHaveLength(8);
    expect(rankFiles(files, "")).toHaveLength(8);
  });

  it("replaces the token with @path and a space; quotes paths with spaces", () => {
    const v = "see @src/ma";
    const t = atToken(v);
    if (!t) throw new Error("no token");
    expect(insertPath(v, t, "src/math.ts")).toBe("see @src/math.ts ");
    expect(insertPath(v, t, "my dir/a b.ts")).toBe('see @"my dir/a b.ts" ');
    expect(insertPath(v, t, 'say "hi".ts')).toBe('see @"say \\"hi\\".ts" ');
    expect(insertPath(v, t, "a\\b.ts")).toBe('see @"a\\\\b.ts" ');
  });

  it("splits a path into its directory and basename", () => {
    expect(splitPath("src/a/math.ts")).toEqual(["src/a/", "math.ts"]);
    expect(splitPath("README.md")).toEqual(["", "README.md"]);
  });
});

describe("reduceInput set", () => {
  it("replaces the value and leaves history browsing", () => {
    const r = reduceInput(
      { ...initialInput, value: "/ru", cursor: 0, history: ["a"] },
      {
        type: "set",
        value: "/run ",
      },
    );
    expect(r.state.value).toBe("/run ");
    expect(r.state.cursor).toBeUndefined();
    expect(r.submitted).toBeUndefined();
  });
});
