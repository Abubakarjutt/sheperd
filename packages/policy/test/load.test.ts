import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DEFAULT_POLICY, loadPolicy } from "../src/index.js";

async function repoWith(toml?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rewire-policy-"));
  if (toml !== undefined) {
    await mkdir(join(dir, ".rewire"));
    await writeFile(join(dir, ".rewire", "policy.toml"), toml);
  }
  return dir;
}

test("no policy file yields defaults", async () =>
  expect(await loadPolicy(await repoWith())).toEqual(DEFAULT_POLICY));
test("loadPolicy rejects a toml that loosens", async () => {
  await expect(loadPolicy(await repoWith('gates = ["tsc"]'))).rejects.toMatchObject({
    code: "policy_loosening",
  });
});
test("valid overlay merges", async () => {
  const p = await loadPolicy(
    await repoWith(
      'maxFixRounds = 3\n[[commandRules]]\npattern = ["git", "push"]\ndecision = "forbidden"\nmatch = ["git push origin"]\n',
    ),
  );
  expect(p.maxFixRounds).toBe(3);
  expect(p.commandRules).toHaveLength(1);
});
test("unknown key is rejected", async () => {
  await expect(loadPolicy(await repoWith("maxFixRound = 3"))).rejects.toThrow();
});
test("failing self-test is rejected", async () => {
  await expect(
    loadPolicy(
      await repoWith(
        '[[commandRules]]\npattern = ["git"]\ndecision = "forbidden"\nmatch = ["ls"]\n',
      ),
    ),
  ).rejects.toMatchObject({ code: "policy_selftest_failed" });
});
test("a repo policy raising reviewerMinConfidence is policy_loosening (R39)", async () => {
  await expect(loadPolicy(await repoWith("reviewerMinConfidence = 1"))).rejects.toMatchObject({
    code: "policy_loosening",
  });
});
test("malformed TOML is policy_invalid (row 3)", async () => {
  await expect(loadPolicy(await repoWith("gates = [\n"))).rejects.toMatchObject({
    code: "policy_invalid",
  });
});
test("numeric guards: non-positive, non-integer and out-of-range values are policy_invalid (row 3)", async () => {
  for (const toml of [
    "maxFixRounds = 0",
    "maxFixRounds = 1.5",
    "noProgressRounds = -1",
    "gateTimeoutMs = 0",
    "reviewerMinConfidence = 1.5",
    "reviewerMinConfidence = -0.1",
    'maxFixRounds = "3"',
  ]) {
    await expect(loadPolicy(await repoWith(toml)), toml).rejects.toMatchObject({
      code: "policy_invalid",
    });
  }
});
test("unknown key is rejected with policy_invalid", async () => {
  await expect(loadPolicy(await repoWith("maxFixRound = 3"))).rejects.toMatchObject({
    code: "policy_invalid",
  });
});
