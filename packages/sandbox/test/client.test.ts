import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_POLICY } from "@rewire/policy";
import { expect, test } from "vitest";
import { profileFor, SandboxClient } from "../src/index.js";
import { tmp } from "./helpers.js";

const mac = process.platform === "darwin";

function setup(stage: Parameters<typeof profileFor>[0] = "implementer") {
  const root = tmp();
  const scratch = tmp("rewire-scratch-");
  return { root, scratch, c: new SandboxClient(profileFor(stage, root, DEFAULT_POLICY, scratch)) };
}

test("client write into denied path rejects with canonical path", async () => {
  const { root, c } = setup();
  await expect(c.write("a.test.ts", "x")).rejects.toMatchObject({
    code: "path_protected",
    message: expect.stringContaining(join(root, "a.test.ts")),
  });
  expect(existsSync(join(root, "a.test.ts"))).toBe(false);
});

test("client write/read allowed path roundtrips; checkPath reports", async () => {
  const { root, c } = setup();
  await c.write("src/a.ts", "hello");
  expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("hello");
  expect(await c.read("src/a.ts")).toBe("hello");
  expect(await c.checkPath("write", "src/a.ts")).toEqual({ allowed: true });
  const d = await c.checkPath("write", ".git/config");
  expect(d).toEqual({
    allowed: false,
    canonical: join(root, ".git", "config"),
    rule: expect.any(String),
  });
  expect(await c.checkPath("write", "/etc/passwd")).toMatchObject({
    allowed: false,
    rule: "<outside-root>",
  });
});

test("read of credential glob is denied", async () => {
  const { root, c } = setup();
  writeFileSync(join(root, ".env"), "SECRET=1");
  await expect(c.read(".env")).rejects.toMatchObject({ code: "path_protected" });
});

test("exec runs, reports exit code and output", async () => {
  const { c } = setup();
  const r = await c.exec(["sh", "-c", "echo out; echo err >&2; exit 7"], { timeoutMs: 10000 });
  expect(r).toMatchObject({ exitCode: 7, stdout: "out\n", timedOut: false });
  expect(r.stderr).toContain("err");
});

test("exec of a missing command is binary_missing", async () => {
  const { c } = setup();
  await expect(c.exec(["definitely-not-a-cmd-xyz"], { timeoutMs: 5000 })).rejects.toMatchObject({
    code: "binary_missing",
  });
});

test("exec timeout sets timedOut", async () => {
  const { c } = setup();
  const r = await c.exec(["sleep", "30"], { timeoutMs: 300 });
  expect(r.timedOut).toBe(true);
});

test("exec honours cwd", async () => {
  const { root, c } = setup();
  mkdirSync(join(root, "sub"));
  const r = await c.exec(["pwd"], { timeoutMs: 5000, cwd: join(root, "sub") });
  expect(r.stdout.trim()).toBe(join(root, "sub"));
});

test.skipIf(!mac)("implementer exec cannot write a test file", async () => {
  const { root, c } = setup();
  const r = await c.exec(["sh", "-c", "echo x > a.test.ts"], { timeoutMs: 10000, cwd: root });
  expect(r.exitCode).not.toBe(0);
  expect(existsSync(join(root, "a.test.ts"))).toBe(false);
  const ok = await c.exec(["sh", "-c", "echo x > a.ts"], { timeoutMs: 10000, cwd: root });
  expect(ok.exitCode).toBe(0);
});

test("profile file is mode 0600 and removed by dispose", () => {
  const { c } = setup();
  expect(statSync(c.profilePath).mode & 0o777).toBe(0o600);
  c.dispose();
  expect(existsSync(c.profilePath)).toBe(false);
});

test("unrunnable binary fails closed with sandbox_unavailable", async () => {
  const c = new SandboxClient(profileFor("spec", tmp(), DEFAULT_POLICY, tmp()), "/nonexistent/bin");
  await expect(c.read("x")).rejects.toMatchObject({ code: "sandbox_unavailable" });
});
