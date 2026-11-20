import { DEFAULT_POLICY, type Policy } from "@rewire/policy";
import { expect, test } from "vitest";
import { evaluateBashCommand } from "../src/index.js";

const rules: Policy = {
  ...DEFAULT_POLICY,
  commandRules: [
    { pattern: ["npm", ["install", "i"]], decision: "forbidden", justification: "use pnpm" },
  ],
};
const verdict = (c: string, p: Policy = rules) => evaluateBashCommand(p, c);

test.each([
  "cat <(npm i)",
  "tee >(npm i)",
  "{ npm i; }",
  "if true; then npm i; fi",
  "for x in a; do npm i; done",
  "! npm i",
  'echo "$(npm i)"',
  "echo `npm i`",
  "exec -a x npm i",
  "env -S 'npm i'",
  "while true; do npm i; done",
  "case x in a) npm i;; esac",
  "function f { npm i; }",
  "echo $(echo $(npm i))",
])("forbidden: %s", (c) => {
  const v = verdict(c);
  expect(v).toMatchObject({ forbidden: true });
  expect((v as { message: string }).message).toContain("use pnpm");
});

test.each(["C=npm; $C i", "np[m] i", "echo $(true) && $(echo npm) i", "echo $(unclosed"])(
  "refused as unevaluable: %s",
  (c) => {
    const v = verdict(c);
    expect(v).toMatchObject({ forbidden: true });
    expect((v as { message: string }).message).toContain(
      "cannot evaluate command against command rules",
    );
  },
);

test("depth cap is refused", () => {
  let nested = "echo hi";
  for (let i = 0; i < 8; i++) nested = `sh -c ${JSON.stringify(nested)}`;
  expect(verdict("sh -c 'echo hi'")).toEqual({ forbidden: false });
  expect(verdict(nested)).toMatchObject({ forbidden: true });
});

test("with no rules nothing is refused", () => {
  const none: Policy = { ...DEFAULT_POLICY, commandRules: [] };
  for (const c of ["C=npm; $C i", "np[m] i", "echo $(unclosed", "npm i"]) {
    expect(verdict(c, none)).toEqual({ forbidden: false });
  }
});

test.each([
  "if [ -f x ]; then echo ok; fi",
  'echo "$(date)"',
  "for f in *.ts; do echo $f; done",
  "ls | grep x && echo done > out.txt",
  "FOO=1 pnpm test",
])("normal commands are allowed: %s", (c) => {
  expect(verdict(c)).toEqual({ forbidden: false });
});
