import { type CommandRule, evaluateCommand, type Policy } from "@rewire/policy";
import { parse } from "shell-quote";

/**
 * Best-effort evaluation of Policy.commandRules against a shell command line.
 *
 * ADVISORY ONLY. Shell syntax is too rich to evaluate soundly (variable expansion, eval, aliases,
 * `$(...)`, scripts that run other commands, ...). This exists to give agents a fast, clear
 * refusal for the obvious forms. The OS sandbox is the enforcement boundary (decision #21);
 * anything we cannot evaluate here is allowed through and left to the sandbox.
 */
export type CommandVerdict = { forbidden: true; message: string } | { forbidden: false };

const SEPARATORS = new Set(["&&", "||", ";", ";;", "|", "|&", "&", "(", ")"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_DEPTH = 5;

type Tok = ReturnType<typeof parse>[number];

/** Split into simple commands; unevaluable argv0 (op/glob object) yields a segment starting with null. */
function segments(command: string): Array<Array<string | null>> {
  // Newlines separate commands; shell-quote would otherwise treat them as whitespace.
  const toks: Tok[] = parse(command.replace(/\r?\n/g, " ; "), (k) => `$${k}`);
  const out: Array<Array<string | null>> = [];
  let cur: Array<string | null> = [];
  const flush = () => {
    if (cur.length > 0) out.push(cur);
    cur = [];
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as Tok;
    if (typeof t === "string") {
      cur.push(t);
    } else if ("comment" in t) {
      break;
    } else if ("op" in t && t.op === "glob") {
      cur.push(cur.length === 0 ? null : t.pattern);
    } else if ("op" in t && SEPARATORS.has(t.op)) {
      flush();
    } else {
      // Redirection (>, <, >>, >&, <( ...): skip the operator and its target word.
      i++;
    }
  }
  flush();
  return out;
}

const base = (s: string): string => s.slice(s.lastIndexOf("/") + 1);

/** Strip leading assignments and wrappers; returns argv with basename-normalized argv0. */
function normalize(argv: string[]): string[] {
  let a = [...argv];
  for (let guard = 0; guard < 20 && a.length > 0; guard++) {
    if (ASSIGNMENT.test(a[0] as string)) {
      a = a.slice(1);
      continue;
    }
    const name = base(a[0] as string);
    const skipOpts = (rest: string[], withArg: string[]): string[] => {
      let r = rest;
      while (r.length > 0 && (r[0] as string).startsWith("-") && r[0] !== "--") {
        r = withArg.includes(r[0] as string) ? r.slice(2) : r.slice(1);
      }
      return r[0] === "--" ? r.slice(1) : r;
    };
    switch (name) {
      case "env": {
        let r = skipOpts(a.slice(1), ["-u", "-C", "-S"]);
        while (r.length > 0 && ASSIGNMENT.test(r[0] as string)) r = r.slice(1);
        a = r;
        continue;
      }
      case "command":
      case "nohup":
      case "exec":
      case "time":
        a = skipOpts(a.slice(1), []);
        continue;
      case "sudo":
        a = skipOpts(a.slice(1), ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-r", "-t"]);
        continue;
      case "nice":
        a = skipOpts(a.slice(1), ["-n"]);
        continue;
      default:
        return [name, ...a.slice(1)];
    }
  }
  return a;
}

function justify(rules: CommandRule[], argv: string[]): string {
  const rule = rules.find((r) => evaluateCommand([r], argv) === "forbidden");
  return rule?.justification ?? `forbidden by command rule ${JSON.stringify(rule?.pattern ?? [])}`;
}

function check(rules: CommandRule[], command: string, depth: number): string | undefined {
  if (depth > MAX_DEPTH) return undefined;
  // Backtick substitutions are opaque to shell-quote; evaluate their bodies too.
  for (const m of command.matchAll(/`([^`]*)`/g)) {
    const r = check(rules, m[1] as string, depth + 1);
    if (r) return r;
  }
  let segs: Array<Array<string | null>>;
  try {
    segs = segments(command);
  } catch {
    return undefined; // advisory: cannot parse, leave to the sandbox
  }
  for (const seg of segs) {
    if (seg[0] === null) continue; // glob/op in argv0: cannot evaluate
    const argv = normalize(seg.map((s) => s ?? ""));
    if (argv.length === 0) continue;
    if (evaluateCommand(rules, argv) === "forbidden") {
      return `${justify(rules, argv)} (blocked: ${argv.join(" ")})`;
    }
    if (SHELLS.has(argv[0] as string)) {
      const ci = argv.findIndex((x, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(x));
      const script = ci > 0 ? argv[ci + 1] : undefined;
      if (script !== undefined) {
        const r = check(rules, script, depth + 1);
        if (r) return r;
      }
    }
  }
  return undefined;
}

export function evaluateBashCommand(policy: Policy, command: string): CommandVerdict {
  if (policy.commandRules.length === 0) return { forbidden: false };
  const why = check(policy.commandRules, command, 0);
  return why ? { forbidden: true, message: why } : { forbidden: false };
}
