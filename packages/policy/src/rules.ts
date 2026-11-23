import { RewireError } from "@rewire/core";
import { parse } from "shell-quote";
import type { CommandRule } from "./defaults.js";

function matches(rule: CommandRule, argv: string[]): boolean {
  if (argv.length < rule.pattern.length) return false;
  return rule.pattern.every((el, i) =>
    Array.isArray(el) ? el.includes(argv[i] as string) : el === argv[i],
  );
}

/** Prefix match on tokens; forbidden wins; no match means allow (the sandbox is the boundary). */
export function evaluateCommand(rules: CommandRule[], argv: string[]): "allow" | "forbidden" {
  const hits = rules.filter((r) => matches(r, argv));
  return hits.some((r) => r.decision === "forbidden") ? "forbidden" : "allow";
}

function tokenize(example: string): string[] {
  return parse(example).map((t) =>
    typeof t === "string" ? t : "op" in t ? t.op : "pattern" in t ? String(t.pattern) : "",
  );
}

/** Every `match` example must hit the rule; every `notMatch` example must not. */
export function selfTestRules(rules: CommandRule[]): void {
  const failures: string[] = [];
  rules.forEach((rule, i) => {
    const label = `rule #${i} ${JSON.stringify(rule.pattern)}`;
    for (const ex of rule.match ?? [])
      if (!matches(rule, tokenize(ex)))
        failures.push(`${label}: expected match but did not: "${ex}"`);
    for (const ex of rule.notMatch ?? [])
      if (matches(rule, tokenize(ex)))
        failures.push(`${label}: expected no match but matched: "${ex}"`);
  });
  if (failures.length > 0)
    throw new RewireError(
      "policy_selftest_failed",
      `policy_selftest_failed:\n${failures.join("\n")}`,
    );
}
