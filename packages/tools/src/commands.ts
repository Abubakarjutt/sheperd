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

/** Index of the closing backtick after `from`, honoring backslash escapes. */
function closeBacktick(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "`") return i;
  }
  throw new Unevaluable("unbalanced backtick");
}

/** Index of the `"` closing the double-quoted span opened at `open`. */
function closeDouble(s: string, open: number): number {
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") i++;
    else if (c === '"') return i;
    else if (c === "$" && s[i + 1] === "(") i = closeParen(s, i + 1);
    else if (c === "`") i = closeBacktick(s, i + 1);
  }
  throw new Unevaluable("unterminated double quote");
}

/** Index of the `)` closing the `(` at `open`; quote-aware. Throws when it cannot be matched. */
function closeParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") i++;
    else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new Unevaluable("unterminated single quote");
      i = end;
    } else if (c === '"') i = closeDouble(s, i);
    else if (c === "`") i = closeBacktick(s, i + 1);
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  throw new Unevaluable("unbalanced substitution");
}

/**
 * Evaluate and replace `$(..)`, `<(..)`, `>(..)` and backtick bodies with a placeholder word.
 * Quote-aware like the shell: single-quoted text is inert, `<(`/`>(` are literal inside double
 * quotes, and a substitution that cannot be matched unambiguously throws (refused).
 */
function extractSubstitutions(
  s: string,
  visit: (body: string) => string | undefined,
): { text: string; refusal?: string } {
  let out = "";
  let dq = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    const two = s.slice(i, i + 2);
    if (c === "\\") {
      out += s.slice(i, i + 2);
      i++;
    } else if (!dq && c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new Unevaluable("unterminated single quote");
      out += s.slice(i, end + 1);
      i = end;
    } else if (c === '"') {
      dq = !dq;
      out += c;
    } else if (two === "$(" || (!dq && (two === "<(" || two === ">("))) {
      const end = closeParen(s, i + 1);
      const refusal = visit(s.slice(i + 2, end));
      if (refusal) return { text: "", refusal };
      out += SUB;
      i = end;
    } else if (c === "`") {
      const end = closeBacktick(s, i + 1);
      const refusal = visit(s.slice(i + 1, end));
      if (refusal) return { text: "", refusal };
      out += SUB;
      i = end;
    } else {
      out += c;
    }
  }
  if (dq) throw new Unevaluable("unterminated double quote");
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
    else {
      // Redirection: drop a preceding fd number (`2>&1`) and skip the target word.
      if (/^\d+$/.test(cur[cur.length - 1] ?? "")) cur.pop();
      if (typeof toks[i + 1] === "string") i++;
    }
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
        const r = envOptions(a.slice(1), scripts);
        if (r === undefined) return { argv: [], scripts };
        a = r;
        while (a.length > 0 && ASSIGNMENT.test(a[0] as string)) a = a.slice(1);
        continue;
      }
      case "eval":
        scripts.push(
          a
            .slice(1)
            .map((x) => x.replace(GLOB, ""))
            .join(" "),
        );
        return { argv: [], scripts };
      case "time":
        a = a.slice(1);
        while (a[0] === "-p" || a[0] === "--") a = a.slice(1);
        continue;
      case "command":
      case "builtin":
      case "nohup":
        a = skipOpts(a.slice(1), []);
        continue;
      case "coproc":
        a = a[2] === "{" ? a.slice(2) : a.slice(1);
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

/**
 * Skip `env`'s options. A split-string option (`-S`, `-iS`, `-S'cmd'`, `--split-string[=]`) is a
 * script: it is pushed to `scripts` and undefined is returned. Otherwise returns the rest.
 */
function envOptions(args: string[], scripts: string[]): string[] | undefined {
  let r = args;
  while (r.length > 0 && (r[0] as string).startsWith("-") && r[0] !== "--") {
    const o = r[0] as string;
    if (o.startsWith("--")) {
      if (o === "--split-string" || o.startsWith("--split-string=")) {
        const inline = o.startsWith("--split-string=")
          ? o.slice("--split-string=".length)
          : undefined;
        scripts.push(inline ?? (r[1] as string | undefined) ?? "");
        return undefined;
      }
      r = ["--unset", "--chdir", "--argv0"].includes(o) ? r.slice(2) : r.slice(1);
      continue;
    }
    let consumed = 1;
    for (let k = 1; k < o.length; k++) {
      const ch = o[k];
      if (ch === "S") {
        const rest = o.slice(k + 1);
        scripts.push(rest !== "" ? rest : ((r[1] as string | undefined) ?? ""));
        return undefined;
      }
      if (ch === "u" || ch === "C") {
        if (k === o.length - 1) consumed = 2;
        break;
      }
    }
    r = r.slice(consumed);
  }
  return r[0] === "--" ? r.slice(1) : r;
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
    if (/\s/.test(argv0) || argv0.startsWith("-")) {
      return cannot(`unexpected command name ${JSON.stringify(argv0)}`);
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
