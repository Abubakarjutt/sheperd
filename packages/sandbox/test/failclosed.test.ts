import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY } from "@rewire/policy";
import { expect, test } from "vitest";
import { expandHome, findSandboxBinary, profileFor, SandboxClient } from "../src/index.js";
import { tmp } from "./helpers.js";

function fake(script: string): string {
  const p = join(tmp("rewire-fake-"), "bin");
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}

function client(
  script: string,
  opts?: {
    watchdogMs?: number;
    execGraceMs?: number;
    maxOutputBytes?: number;
    killGraceMs?: number;
  },
) {
  const profile = profileFor("implementer", tmp(), DEFAULT_POLICY, tmp());
  return new SandboxClient(profile, fake(script), opts);
}

test("exit 120 with escaped descendant -> sandbox_escape", async () => {
  const c = client("echo 'sandbox: escaped descendant 123' >&2; exit 120");
  await expect(c.exec(["x"], { timeoutMs: 1000 })).rejects.toMatchObject({
    code: "sandbox_escape",
  });
});

test("exit 120 other -> sandbox_unavailable", async () => {
  const c = client("echo boom >&2; exit 120");
  await expect(c.exec(["x"], { timeoutMs: 1000 })).rejects.toMatchObject({
    code: "sandbox_unavailable",
  });
  await expect(c.read("a")).rejects.toMatchObject({ code: "sandbox_unavailable" });
});

test("killed by signal -> sandbox_unavailable", async () => {
  const c = client("kill -9 $$");
  await expect(c.checkPath("read", "a")).rejects.toMatchObject({ code: "sandbox_unavailable" });
  await expect(c.exec(["x"], { timeoutMs: 1000 })).rejects.toMatchObject({
    code: "sandbox_unavailable",
  });
});

test("exit 3 with unparseable output -> sandbox_unavailable", async () => {
  const c = client("echo 'not json' >&2; exit 3");
  await expect(c.checkPath("write", "a")).rejects.toMatchObject({ code: "sandbox_unavailable" });
  await expect(c.write("a", "x")).rejects.toMatchObject({ code: "sandbox_unavailable" });
});

test("unexpected exit code on checkPath -> sandbox_unavailable", async () => {
  const c = client("exit 42");
  await expect(c.checkPath("read", "a")).rejects.toMatchObject({ code: "sandbox_unavailable" });
});

test("hanging binary -> watchdog fires", { timeout: 8000 }, async () => {
  const c = client("sleep 30", { watchdogMs: 300 });
  await expect(c.read("a")).rejects.toMatchObject({
    code: "sandbox_unavailable",
    message: expect.stringContaining("watchdog"),
  });
});

test("exec watchdog is timeoutMs + grace", { timeout: 8000 }, async () => {
  const c = client("sleep 30", { execGraceMs: 300 });
  await expect(c.exec(["x"], { timeoutMs: 100 })).rejects.toMatchObject({
    code: "sandbox_unavailable",
    message: expect.stringContaining("watchdog"),
  });
});

test("oversized output -> sandbox_unavailable", { timeout: 8000 }, async () => {
  const c = client("yes | head -c 100000", { maxOutputBytes: 1000 });
  await expect(c.read("a")).rejects.toMatchObject({
    code: "sandbox_unavailable",
    message: expect.stringContaining("output"),
  });
});

test("exec cwd outside root -> path_protected <outside-root>", async () => {
  const c = client("exit 0");
  const outside = tmp();
  await expect(c.exec(["x"], { timeoutMs: 1000, cwd: outside })).rejects.toMatchObject({
    code: "path_protected",
    message: expect.stringContaining(`${outside} is protected (rule <outside-root>)`),
  });
});

test("exec exit 3 is the child's plain exit code", async () => {
  const c = client("exit 3");
  expect(await c.exec(["x"], { timeoutMs: 1000 })).toMatchObject({ exitCode: 3 });
});

test("REWIRE_SANDBOX_BIN pointing at a missing file -> binary_missing", () => {
  const old = process.env.REWIRE_SANDBOX_BIN;
  process.env.REWIRE_SANDBOX_BIN = "/nonexistent/rewire-sandbox";
  try {
    expect(() => findSandboxBinary()).toThrow(expect.objectContaining({ code: "binary_missing" }));
  } finally {
    if (old === undefined) Reflect.deleteProperty(process.env, "REWIRE_SANDBOX_BIN");
    else process.env.REWIRE_SANDBOX_BIN = old;
  }
});

test("REWIRE_SANDBOX_BIN override is used", () => {
  const old = process.env.REWIRE_SANDBOX_BIN;
  const p = fake("exit 0");
  process.env.REWIRE_SANDBOX_BIN = p;
  try {
    expect(findSandboxBinary()).toBe(p);
  } finally {
    if (old === undefined) Reflect.deleteProperty(process.env, "REWIRE_SANDBOX_BIN");
    else process.env.REWIRE_SANDBOX_BIN = old;
  }
});

test("expandHome handles bare ~", () => {
  expect(expandHome("~")).toBe(homedir());
});

test("exec cwd inside an extraWrite dir outside root -> path_protected <outside-root>", async () => {
  const scratch = tmp("rewire-scratch-");
  const c = new SandboxClient(profileFor("verify", tmp(), DEFAULT_POLICY, scratch), fake("exit 0"));
  await expect(c.exec(["x"], { timeoutMs: 1000, cwd: scratch })).rejects.toMatchObject({
    code: "path_protected",
    message: expect.stringContaining(`${scratch} is protected (rule <outside-root>)`),
  });
});

test("fake binary ignoring SIGTERM is SIGKILLed after the grace", { timeout: 8000 }, async () => {
  const mark = join(tmp("rewire-mark-"), "term");
  const c = client(`trap 'echo t > ${mark}' TERM; while :; do sleep 0.1; done`, {
    // generous: a freshly written executable can take a while to start on macOS
    watchdogMs: 1500,
    killGraceMs: 400,
  });
  const t0 = Date.now();
  const err = await c.read("a").catch((e: Error) => e);
  expect((err as Error).message).toContain("watchdog");
  expect((err as Error).message).toContain("SIGKILLed");
  expect(Date.now() - t0).toBeGreaterThanOrEqual(1850);
  expect(existsSync(mark)).toBe(true);
});
