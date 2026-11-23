import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fileStem, uniqueStem } from "../run.js";

describe("result file names", () => {
  test("the stem carries seconds", () => {
    expect(fileStem(new Date(2026, 10, 22, 9, 5, 7))).toBe("2026-11-22T090507");
  });
  test("an existing file gets a -N suffix instead of being overwritten", () => {
    const dir = mkdtempSync(join(tmpdir(), "stem-"));
    expect(uniqueStem(dir, "a")).toBe("a");
    writeFileSync(join(dir, "a.json"), "{}");
    expect(uniqueStem(dir, "a")).toBe("a-2");
    writeFileSync(join(dir, "a-2.json"), "{}");
    expect(uniqueStem(dir, "a")).toBe("a-3");
  });
});
