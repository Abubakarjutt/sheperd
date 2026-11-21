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

test.each([
  "time -p npm i",
  "time -p -- npm i",
  "env -iS 'npm i'",
  "env -S'npm i'",
  "env --split-string='npm i'",
  "eval 'npm i'",
  "eval npm i",
  "2>&1 npm i",
  ">out npm i",
  "2>/dev/null npm i",
  "builtin exec npm i",
  "coproc npm i",
  `echo "$(echo ')' ; npm i)"`,
  "echo '$(' ; npm i; echo ')'",
])("forbidden (round 2): %s", (c) => {
  const v = verdict(c);
  expect(v).toMatchObject({ forbidden: true });
  expect((v as { message: string }).message).toContain("use pnpm");
});

test.each(["echo $(echo 'unterminated)", "$(echo 'x)", "-x i"])(
  "unmatched or odd forms are refused: %s",
  (c) => {
    expect((verdict(c) as { message: string }).message).toContain("cannot evaluate");
  },
);

test.each(["echo 'a)'", 'echo "a)" $(date)', "time -p ls", "ls 2>&1", "echo '$(npm i)'"])(
  "round 2 allowed: %s",
  (c) => {
    expect(verdict(c)).toEqual({ forbidden: false });
  },
);

test.each([
  "echo hi #'\nnpm i\n#'",
  "echo $'\\'' ; npm i ; echo '",
  "echo $'a\\'b' ; npm i",
  "env --split='npm i'",
  "env --spl 'npm i'",
  "env -a x npm i",
  "env -P /bin npm i",
  "env --frob npm i",
])("forbidden or refused (round 3): %j", (c) => {
  expect(verdict(c)).toMatchObject({ forbidden: true });
});

test.each(["echo $'hello\\n'", "ls # comment with 'quote", 'echo "#notacomment" ; ls', "echo a#b"])(
  "round 3 allowed: %j",
  (c) => {
    expect(verdict(c)).toEqual({ forbidden: false });
  },
);

// Round 4: bash blanks are space/tab/newline only; `#` word-start tracking (S17); $'..' decoding (S18).
test.each([
  "echo a #x ; npm i",
  "echo a #x ; npm i",
  "echo a﻿#x ; npm i",
  "echo a #x ; npm i",
  "echo a\r#x ; npm i",
  "echo a\v#x ; npm i",
  "echo a\f#x ; npm i",
  "function for x { npm i; }",
  "echo a\\ b ; npm i",
  "echo café#x ; npm i",
])("forbidden or refused (round 4, blanks): %j", (c) => {
  expect(verdict(c)).toMatchObject({ forbidden: true });
});

test.each([
  "echo \\;#x ; npm i",
  "echo a\\ #x ; npm i",
  "echo $(date)#x ; npm i",
  "echo <(true)#x ; npm i",
  "echo $((1))#x ; npm i",
  "echo $(echo $(date)#x ; npm i)",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template
  "echo ${x#y} ; npm i",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template
  "echo ${x:-#} ; npm i",
  "npm \\\ni",
  "echo a \\\n#'\nnpm i\n#'",
  "npm $'i'",
  "npm $'\\x69'",
  "npm $'\\151'",
  "$'npm' i",
  "npm $'ins''tall'",
  "npm $'ins'\"tall\"",
])("forbidden (round 4): %j", (c) => {
  const v = verdict(c);
  expect(v).toMatchObject({ forbidden: true });
  expect((v as { message: string }).message).toContain("use pnpm");
});

test.each([
  "echo $'\\0' ; ls",
  "echo $'\\xff' ; ls",
  "echo $'\\u00e9' ; ls",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template
  "echo ${x:-$(npm i)}",
  "echo a>#x",
  "echo a>&#x",
])("refused (round 4): %j", (c) => {
  expect((verdict(c) as { message: string }).message).toContain("cannot evaluate");
});

test.each([
  "ls # comment",
  "echo a#b",
  "ls\t# comment",
  "ls;# comment",
  "echo a&#x",
  "echo $'hello\\n'",
  "echo $'\\e[31mred'",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template
  "echo ${HOME}/x",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template
  'echo "${x#y}"',
  "echo $#",
  'echo "café a b"',
  "ls \\\n  -la",
])("round 4 allowed: %j", (c) => {
  expect(verdict(c)).toEqual({ forbidden: false });
});

// Round 5: `)` does not always end a word in bash. Ambiguous `)` contexts are refused (fail closed).
test.each([
  "a=(1 2)#x ; npm i",
  "a+=(1)#x ; npm i",
  "[[ a =~ (a)#x ]] ; npm i",
  "[[ a =~ x|#x ]] ; npm i",
  "[[ a =~ x #x\n]] ; npm i",
  "shopt -s extglob\necho @(a)#x ; npm i",
  "shopt -s extglob\necho !(a)#x ; npm i",
  "shopt -s extglob\necho @(a|#x) ; npm i",
  "echo $(case x in x) npm i;; esac)",
  '"$(case x in x) npm i;; esac)"',
  "cat <(case x in x) npm i;; esac)",
  "echo $(case x in x) ls;; esac)#x ; npm i",
  "echo $(case x in x) ls;; esac)",
  "((1|#x)) ; npm i",
  "(( 1 + #x )) ; npm i",
  "for ((i=0;i<1;i++|#x)); do :; done ; npm i",
  "echo $(a=(1)#x ; npm i)",
  "((1))#x ; npm i",
  "(ls)#x ; npm i",
  "(ls)#x",
  "cat <<EOF\na '\nEOF\nnpm i\necho '",
  "cat <<EOF\nhi\nEOF",
])("forbidden or refused (round 5): %j", (c) => {
  expect(verdict(c)).toMatchObject({ forbidden: true });
});

test.each([
  "(ls)",
  "(cd x && ls)",
  "{ ls; }",
  "echo $(date)",
  "if [ -f x ]; then echo ok; fi",
  "case x in x) ls;; esac",
  "(ls) # comment",
  "[[ -f x ]] && echo ok",
  "cat <<< hi",
  "x=$(( 16#ff ))",
])("round 5 allowed: %j", (c) => {
  expect(verdict(c)).toEqual({ forbidden: false });
});
