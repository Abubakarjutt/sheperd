import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { ConfigError, DEFAULT_CONFIG } from "../src/config/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfg-"));
});
afterEach(() => {
  chmodSync(dir, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

const failure = (f: () => unknown): unknown => {
  try {
    f();
  } catch (e) {
    return e;
  }
  return undefined;
};

describe("loadConfig with a missing file", () => {
  test("returns the defaults", () => {
    expect(loadConfig(join(dir, "absent.json"))).toEqual(DEFAULT_CONFIG);
  });

  test("returns a copy, not the shared object", () => {
    const c = loadConfig(join(dir, "absent.json"));
    expect(c).not.toBe(DEFAULT_CONFIG);
    c.port = 1;
    expect(DEFAULT_CONFIG.port).toBe(8080);
  });

  test("a missing parent directory counts as a missing file", () => {
    expect(loadConfig(join(dir, "no", "such", "dir", "c.json"))).toEqual(DEFAULT_CONFIG);
  });

  test("a directory is not 'missing': it still fails, naming the path", () => {
    const p = join(dir, "sub");
    mkdirSync(p);
    const err = failure(() => loadConfig(p));
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toContain(p);
  });

  test("invalid JSON still fails with ConfigError and keeps the cause", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{nope");
    const err = failure(() => loadConfig(p));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).cause).toBeInstanceOf(SyntaxError);
  });

  test("an invalid value still fails with ConfigError", () => {
    const p = join(dir, "bad2.json");
    writeFileSync(p, '{"port": 0}');
    expect(failure(() => loadConfig(p))).toBeInstanceOf(ConfigError);
  });

  test("an unreadable file still fails", () => {
    if (process.getuid?.() === 0) return; // root can read anything
    const p = join(dir, "secret.json");
    writeFileSync(p, "{}");
    chmodSync(p, 0o000);
    const err = failure(() => loadConfig(p));
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toContain(p);
  });

  test("an existing valid file is unaffected", () => {
    const p = join(dir, "ok.json");
    writeFileSync(p, '{"port": 3000, "logLevel": "warn"}');
    expect(loadConfig(p)).toEqual({ port: 3000, host: "127.0.0.1", logLevel: "warn" });
  });
});
