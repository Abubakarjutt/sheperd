import { type CommandRule, evaluateCommand, type Policy } from "@rewire/policy";
import { parse } from "shell-quote";

/**
 * Best-effort evaluation of Policy.commandRules against a shell command line.
 *
 * ADVISORY: the OS sandbox is the enforcement boundary (decision #21). Shell syntax is too rich
 * to evaluate soundly, so this only gives agents a fast, clear refusal. When commandRules is
 * non-empty we recurse into everything we can evaluate (command/process substitution, sub-shells,
 * `sh -c`, `env -S`, compound-command bodies, wrappers) and REFUSE what we genuinely cannot
 * (dynamic argv0 such as `$C` or a glob, parse failures, nesting beyond the depth cap), telling the
 * agent to rewrite in plain form. Substitution itself is evaluated, never blocked. With no rules,
 * nothing is refused.
 */
export type CommandVerdict = { forbidden: true; message: string } | { forbidden: false };

const SEPARATORS = new Set(["&&", "||", ";", ";;", "|", "|&", "&", "(", ")"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const RESERVED = new Set([
  "!",
  "{",
  "}",
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "while",
  "until",
  "do",
  "done",
  "esac",
  "time",
]);
const LOOP_HEADERS = new Set(["for", "select", "case"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GLOB = "\u0000";
const SUB = "$__SUB__";
const MAX_DEPTH = 5;

const cannot = (what: string): string =>
  `cannot evaluate command against command rules (${what}); rewrite it in plain form`;

type Tok = ReturnType<typeof parse>[number];

class Unevaluable extends Error {}

/** Index of the `)` closing the `(` at `open`, or -1. */
function closeParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Evaluate and replace `$(..)`, `<(..)`, `>(..)` and backtick bodies with a placeholder word. */
function extractSubstitutions(
  s: string,
  visit: (body: string) => string | undefined,
): { text: string; refusal?: string } {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const two = s.slice(i, i + 2);
    if (two === "$(" || two === "<(" || two === ">(") {
      const end = closeParen(s, i + 1);
      if (end < 0) throw new Unevaluable("unbalanced substitution");
      const refusal = visit(s.slice(i + 2, end));
      if (refusal) return { text: "", refusal };
      out += SUB;
      i = end;
    } else if (s[i] === "`") {
      const end = s.indexOf("`", i + 1);
      if (end < 0) throw new Unevaluable("unbalanced backtick");
      const refusal = visit(s.slice(i + 1, end));
      if (refusal) return { text: "", refusal };
      out += SUB;
      i = end;
    } else {
      out += s[i];
    }
  }
  return { text: out };
}

/** Split into simple commands. Glob words are marked so argv0 can be recognised as dynamic. */
function segments(command: string): string[][] {
  // Newlines separate commands; shell-quote would otherwise treat them as whitespace.
  const toks: Tok[] = parse(command.replace(/\r?\n/g, " ; "), (k) => `$${k}`);
  const out: string[][] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.length > 0) out.push(cur);
    cur = [];
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as Tok;
    if (typeof t === "string") cur.push(t);
    else if ("comment" in t) break;
    else if ("op" in t && t.op === "glob") cur.push(GLOB + t.pattern);
    else if ("op" in t && SEPARATORS.has(t.op)) flush();
    else if (typeof toks[i + 1] === "string") i++; // redirection: skip its target word
  }
  flush();
  return out;
}

const base = (s: string): string => s.slice(s.lastIndexOf("/") + 1);
const isDynamic = (w: string): boolean =>
  w.startsWith(GLOB) ||
  w.includes("$") ||
  w.includes("`") ||
  (w !== "[" && w !== "[[" && /[*?[\]{}]/.test(w)); // glob/brace forms (shell-quote only marks * and ?)

/** Strip reserved words, assignments and wrappers; argv0 is basename-normalized. */
function normalize(argv: string[]): { argv: string[]; scripts: string[] } {
  let a = [...argv];
  const scripts: string[] = [];
  const skipOpts = (rest: string[], withArg: string[]): string[] => {
    let r = rest;
    while (r.length > 0 && (r[0] as string).startsWith("-") && r[0] !== "--") {
      r = withArg.includes(r[0] as string) ? r.slice(2) : r.slice(1);
    }
    return r[0] === "--" ? r.slice(1) : r;
  };
  for (let guard = 0; guard < 50 && a.length > 0; guard++) {
    const w = a[0] as string;
    if (RESERVED.has(w) || ASSIGNMENT.test(w)) {
      a = a.slice(1);
      continue;
    }
    if (w === "function") {
      a = a.slice(2);
      continue;
    }
    if (isDynamic(w)) return { argv: a, scripts };
    const name = base(w);
    switch (name) {
      case "env": {
        let r = a.slice(1);
        if (r[0] === "-S" && r[1] !== undefined) {
          scripts.push(r[1]);
          return { argv: [], scripts };
        }
        r = skipOpts(r, ["-u", "-C"]);
        while (r.length > 0 && ASSIGNMENT.test(r[0] as string)) r = r.slice(1);
        a = r;
        continue;
      }
      case "command":
      case "nohup":
        a = skipOpts(a.slice(1), []);
        continue;
      case "exec":
        a = skipOpts(a.slice(1), ["-a"]);
        continue;
      case "sudo":
        a = skipOpts(a.slice(1), ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-r", "-t"]);
        continue;
      case "nice":
        a = skipOpts(a.slice(1), ["-n"]);
        continue;
      default:
        return { argv: [name, ...a.slice(1).map((x) => x.replace(GLOB, ""))], scripts };
    }
  }
  return { argv: a, scripts };
}

function justify(rules: CommandRule[], argv: string[]): string {
  const rule = rules.find((r) => evaluateCommand([r], argv) === "forbidden");
  return rule?.justification ?? `forbidden by command rule ${JSON.stringify(rule?.pattern ?? [])}`;
}

/** Returns a refusal/forbidden message, or undefined when the command evaluates clean. */
function check(rules: CommandRule[], command: string, depth: number): string | undefined {
  if (depth > MAX_DEPTH) return cannot("nesting too deep");
  const { text, refusal } = extractSubstitutions(command, (b) => check(rules, b, depth + 1));
  if (refusal) return refusal;
  for (const seg of segments(text)) {
    if (LOOP_HEADERS.has(seg[0] as string)) continue; // `for x in ...` / `case x in ...` header
    const { argv, scripts } = normalize(seg);
    for (const s of scripts) {
      const r = check(rules, s, depth + 1);
      if (r) return r;
    }
    if (argv.length === 0) continue;
    const argv0 = argv[0] as string;
    if (isDynamic(argv0)) {
      return cannot(`dynamic command name ${JSON.stringify(argv0.replace(GLOB, ""))}`);
    }
    if (evaluateCommand(rules, argv) === "forbidden") {
      return `${justify(rules, argv)} (blocked: ${argv.join(" ")})`;
    }
    if (SHELLS.has(argv0)) {
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
  try {
    const why = check(policy.commandRules, command, 0);
    return why ? { forbidden: true, message: why } : { forbidden: false };
  } catch (e) {
    return {
      forbidden: true,
      message: cannot(e instanceof Unevaluable ? e.message : "parse failure"),
    };
  }
}
