import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { ConfigError } from "../src/config/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfg-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (text: string): string => {
  const p = join(dir, "config.json");
  writeFileSync(p, text);
  return p;
};

describe("loadConfig", () => {
  test("reads a valid file and fills defaults", () => {
    expect(loadConfig(write('{"port": 9000}'))).toEqual({
      port: 9000,
      host: "127.0.0.1",
      logLevel: "info",
    });
  });

  test("invalid JSON is a ConfigError naming the path", () => {
    const p = write("{nope");
    expect(() => loadConfig(p)).toThrow(ConfigError);
    expect(() => loadConfig(p)).toThrow(p);
  });

  test("validation failures are ConfigErrors", () => {
    expect(() => loadConfig(write('{"port": "80"}'))).toThrow(/port/);
  });
});
