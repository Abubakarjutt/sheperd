import { homedir } from "node:os";
import { DEFAULT_POLICY } from "@rewire/policy";
import { expect, test } from "vitest";
import { profileFor } from "../src/index.js";

test("implementer profile denies test globs and protected globs", () => {
  const p = profileFor("implementer", "/w", DEFAULT_POLICY, "/tmp/s");
  expect(p.writeDeny).toEqual(
    expect.arrayContaining([
      "**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      ".github/**",
      "**/pnpm-lock.yaml",
      "**/node_modules/**",
    ]),
  );
  expect(p.write).toEqual(["**"]);
});

test("test-writer cannot write src", () => {
  const p = profileFor("test-writer", "/w", DEFAULT_POLICY, "/tmp/s");
  expect(p.write).not.toContain("**");
  expect(p.write).toEqual(DEFAULT_POLICY.testGlobs);
  expect(p.writeDeny).toEqual(DEFAULT_POLICY.protectedGlobs);
});

test("spec and review are read-only; verify stages get scratch", () => {
  for (const s of ["spec", "review"] as const) {
    const p = profileFor(s, "/w", DEFAULT_POLICY, "/tmp/s");
    expect(p.write).toEqual([]);
    expect(p.extraWrite).toEqual([]);
  }
  const v = profileFor("verify", "/w", DEFAULT_POLICY, "/tmp/s");
  expect(v).toMatchObject({ write: [], extraWrite: ["/tmp/s"], network: "deny" });
  expect(profileFor("verify-registry", "/w", DEFAULT_POLICY, "/tmp/s")).toMatchObject({
    write: [],
    extraWrite: ["/tmp/s"],
    network: "registry",
  });
});

test("~ is expanded in readDeny", () => {
  const p = profileFor("spec", "/w", DEFAULT_POLICY, "/tmp/s");
  expect(p.readDeny).toContain(`${homedir()}/.ssh/**`);
  expect(p.readDeny).toContain("**/.env*");
  expect(p.readDeny.some((g) => g.startsWith("~"))).toBe(false);
});

test("odd ~ pattern is policy_invalid; relative root rejected; dedupes", () => {
  expect(() =>
    profileFor("spec", "/w", { ...DEFAULT_POLICY, credentialDenyGlobs: ["~root/x"] }, "/s"),
  ).toThrow(expect.objectContaining({ code: "policy_invalid" }));
  expect(() => profileFor("spec", "w", DEFAULT_POLICY, "/s")).toThrow(
    expect.objectContaining({ code: "policy_invalid" }),
  );
  const p = profileFor("spec", "/w", { ...DEFAULT_POLICY, credentialDenyGlobs: ["a", "a"] }, "/s");
  expect(p.readDeny).toEqual(["a"]);
});

test("a run worktree's own repo .env files are read-denied (I3: outside the worktree)", () => {
  const p = profileFor("implementer", "/r/repo/.rewire/worktrees/run-1", DEFAULT_POLICY, "/tmp/s");
  expect(p.readDeny).toEqual(
    expect.arrayContaining(["/r/repo/.env*", "/r/repo/*/.env*", "/r/repo/*/*/.env*"]),
  );
  // Any other root gets no repo-derived entries.
  const q = profileFor("implementer", "/w", DEFAULT_POLICY, "/tmp/s");
  expect(q.readDeny.filter((g) => g.startsWith("/r/"))).toEqual([]);
});
