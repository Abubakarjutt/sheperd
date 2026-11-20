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
