import { type CommandRule, evaluateCommand, type Policy } from "@rewire/policy";
import { parse } from "shell-quote";

/**
 * Best-effort evaluation of Policy.commandRules against a shell command line.
 *
 * ADVISORY: the OS sandbox is the enforcement boundary (decision #21). Shell syntax is too rich
 * to evaluate soundly, so this only gives agents a fast, clear refusal. When commandRules is
 * non-empty we recurse into everything we can evaluate (command/process substitution, sub-shells,
 * `sh -c`, `env -S`, compound-command bodies, wrappers) and REFUSE what we genuinely cannot
 * (dynamic argv0 such as `$C` or a glob, parse failures, nesting beyond the depth cap, heredocs,
 * array assignment, extglob, `case` inside a substitution, a `#` after `(`/`)` or inside parens or
 * after `[[`), telling the
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
/** Whitespace to JS `\s` that bash does NOT treat as a blank (bash blanks: space, tab, newline). */
const NON_BASH_BLANK = /[^\S \t\n]/;
/** Scanner state: start of input, or "inside a word" after an escape, quote or expansion. */
const START = "";
const IN_WORD = "\u0000w";

const cannot = (what: string): string =>
  `cannot evaluate command against command rules (${what}); rewrite it in plain form`;

type Tok = ReturnType<typeof parse>[number];

class Unevaluable extends Error {}

/** Tracks the last two characters the scanner consumed, for `#` word-start decisions. */
class Prev {
  c = START;
  c2 = START;
  step(c: string): void {
    this.c2 = this.c;
    this.c = c;
  }
}

/** Index of the `'` closing the ANSI-C quote `$'...'` whose opening quote is at `quote`. */
function closeAnsiC(s: string, quote: number): number {
  for (let i = quote + 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "'") return i;
  }
  throw new Unevaluable("unterminated $'...' quote");
}

const ANSI_SIMPLE: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};
/** Max hex digits for `\xHH`, `\uHHHH`, `\UHHHHHHHH`. */
const ANSI_HEX: Record<string, number> = { x: 2, u: 4, U: 8 };

/**
 * Decode the body of `$'...'` like bash. Numeric escapes that yield NUL (bash truncates there) or
 * a non-ASCII byte/code point (locale dependent) are refused. Unknown escapes keep the backslash.
 */
function decodeAnsiC(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = body[i + 1];
    if (n === undefined) return `${out}\\`;
    i++;
    const simple = ANSI_SIMPLE[n];
    if (simple !== undefined) {
      out += simple;
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(body.slice(i));
    const hexLen = ANSI_HEX[n];
    const hex = hexLen ? new RegExp(`^[0-9A-Fa-f]{1,${hexLen}}`).exec(body.slice(i + 1)) : null;
    let code: number;
    if (octal) {
      code = Number.parseInt(octal[0], 8);
      i += octal[0].length - 1;
    } else if (hex) {
      code = Number.parseInt(hex[0], 16);
      i += hex[0].length;
    } else if (n === "c") {
      const x = body[i + 1];
      if (x === undefined || x === "\\") throw new Unevaluable("ambiguous $'\\c' escape");
      code = x === "?" ? 0x7f : x.charCodeAt(0) & 0x1f;
      i++;
    } else {
      out += `\\${n}`;
      continue;
    }
    if (code === 0 || code > 0x7f) {
      throw new Unevaluable("$'...' escape yields NUL or a non-ASCII byte");
    }
    out += String.fromCharCode(code);
  }
  return out;
}

/** `$'...'` at `dollar` decoded and re-quoted as a single-quoted literal; returns [text, end]. */
function ansiC(s: string, dollar: number): [string, number] {
  const end = closeAnsiC(s, dollar + 1);
  const decoded = decodeAnsiC(s.slice(dollar + 2, end));
  return [`'${decoded.replace(/'/g, "'\\''")}'`, end];
}

/**
 * Index of the `}` closing the `${` whose `{` is at `open`. Only plain expansions are evaluated
 * (`#` inside is never a comment); nested quotes, escapes, braces, backticks, `$(` or newlines
 * are refused.
 */
function closeBrace(s: string, open: number): number {
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i] as string;
    if (c === "}") return i;
    if ("'\"`\\{\n".includes(c) || (c === "$" && s[i + 1] === "(") || NON_BASH_BLANK.test(c)) {
      throw new Unevaluable("complex $" + "{...} expansion");
    }
  }
  throw new Unevaluable("unterminated $" + "{...} expansion");
}

const wordStart = (p: Prev): boolean => p.c === START || " \t\n;|&()".includes(p.c);

/**
 * Fail-closed tracking of contexts where bash keeps a word going after `)` or where `#` is not a
 * comment: array assignment `=(`, extglob `?( *( +( @( !(`, arithmetic `((..))`, `[[ .. ]]` and
 * heredocs. The first two are refused outright; a comment inside open plain parens or after `[[`
 * is refused rather than dropped.
 */
class Ctx {
  depth = 0;
  dbl = false;
  /** An unquoted plain `(` (not `$(`, `<(`, `>(`). */
  open(p: Prev): void {
    if (p.c === "=") throw new Unevaluable("array assignment");
    if ("?*+@!".includes(p.c) && p.c !== START) throw new Unevaluable("extglob pattern");
    this.depth++;
  }
  close(): void {
    if (this.depth > 0) this.depth--; // case patterns close without an open
  }
  /** Called on each unquoted plain character. */
  word(s: string, i: number, p: Prev, inSubst: boolean): void {
    if (!wordStart(p)) return;
    const end = s[i + 2] === undefined || " \t\n".includes(s[i + 2] as string);
    if (s.startsWith("[[", i) && end) this.dbl = true;
    if (
      inSubst &&
      s.startsWith("case", i) &&
      (s[i + 4] === undefined || " \t\n".includes(s[i + 4] as string))
    ) {
      throw new Unevaluable("case inside a substitution");
    }
  }
  comment(): void {
    if (this.depth > 0) throw new Unevaluable("# inside parentheses");
    if (this.dbl) throw new Unevaluable("# after [[");
  }
}

/**
 * Classify an unquoted `#` from the characters before it, using bash's rules: a comment starts
 * only at a word start (start of input, after a bash blank or an unescaped `;|&()`). Inside a word
 * (after an escape, quote or expansion, or a plain character) it is literal. After a redirection
 * operator, a non-ASCII character or a control character it is refused as ambiguous.
 */
function hashKind(p: Prev): "comment" | "word" {
  const { c, c2 } = p;
  if (c === IN_WORD) return "word";
  if (c === "<" || c === ">" || ((c === "&" || c === "|") && (c2 === "<" || c2 === ">"))) {
    throw new Unevaluable("ambiguous # after a redirection");
  }
  if (c === "(" || c === ")") throw new Unevaluable("ambiguous # after a parenthesis");
  if (c === START || " \t\n;|&".includes(c)) return "comment";
  const code = c.charCodeAt(0);
  if (code < 0x20 || code >= 0x7f) {
    throw new Unevaluable("ambiguous # after a non-ASCII or control character");
  }
  return "word";
}

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
    else if (c === "$" && s[i + 1] === "{") i = closeBrace(s, i + 1);
    else if (c === "`") i = closeBacktick(s, i + 1);
  }
  throw new Unevaluable("unterminated double quote");
}

/**
 * Index of the `)` closing the `(` at `open`; quote-aware, with the same `#` word-start tracking
 * as the top level. A `)` closing a nested `$(`/`<(`/`>(` leaves the scanner inside a word.
 */
function closeParen(s: string, open: number): number {
  const p = new Prev();
  const ctx = new Ctx();
  const subst: boolean[] = [];
  for (let i = open; i < s.length; i++) {
    const c = s[i] as string;
    if (c === "\\") {
      if (s[i + 1] !== "\n") p.step(IN_WORD); // `\<newline>` is removed by bash
      i++;
    } else if (c === "$" && s[i + 1] === "'") {
      i = closeAnsiC(s, i + 1);
      p.step(IN_WORD);
    } else if (c === "$" && s[i + 1] === "{") {
      i = closeBrace(s, i + 1);
      p.step(IN_WORD);
    } else if (c === "#") {
      if (hashKind(p) === "comment") {
        ctx.comment();
        const nl = s.indexOf("\n", i);
        if (nl < 0) throw new Unevaluable("comment runs to end of substitution");
        i = nl - 1; // the newline is consumed next
      } else p.step(c);
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new Unevaluable("unterminated single quote");
      i = end;
      p.step(IN_WORD);
    } else if (c === '"') {
      i = closeDouble(s, i);
      p.step(IN_WORD);
    } else if (c === "`") {
      i = closeBacktick(s, i + 1);
      p.step(IN_WORD);
    } else if (c === "(") {
      const isSubst = p.c === "$" || p.c === "<" || p.c === ">";
      if (!isSubst && subst.length > 0) ctx.open(p);
      subst.push(isSubst);
      p.step(c);
    } else if (c === ")") {
      const wasSubst = subst.pop();
      if (subst.length === 0) return i;
      if (!wasSubst) ctx.close();
      p.step(wasSubst ? IN_WORD : c);
    } else {
      ctx.word(s, i, p, true);
      p.step(c);
    }
  }
  throw new Unevaluable("unbalanced substitution");
}

/**
 * Evaluate and replace `$(..)`, `<(..)`, `>(..)` and backtick bodies with a placeholder word.
 * Quote-aware like the shell: single-quoted text is inert, `<(`/`>(` are literal inside double
 * quotes, `$'...'` is decoded into a single-quoted literal, comments are dropped only where bash
 * starts one, and anything that cannot be matched unambiguously throws (refused). Unquoted
 * whitespace that bash does not treat as a blank (NBSP, `\r`, `\v`, ...) is refused, because
 * shell-quote would split words on it.
 */
function extractSubstitutions(
  s: string,
  visit: (body: string) => string | undefined,
): { text: string; refusal?: string } {
  let out = "";
  let dq = false;
  const p = new Prev();
  const ctx = new Ctx();
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    const two = s.slice(i, i + 2);
    if (c === "\\") {
      const n = s[i + 1];
      if (n === "\n") {
        i++; // line continuation: bash removes it, the word (or blank) state carries on
        continue;
      }
      if (!dq && n !== undefined && NON_BASH_BLANK.test(n)) {
        throw new Unevaluable("escaped non-blank whitespace");
      }
      out += s.slice(i, i + 2);
      i++;
      p.step(IN_WORD);
    } else if (!dq && two === "$'") {
      const [lit, end] = ansiC(s, i);
      out += lit;
      i = end;
      p.step(IN_WORD);
    } else if (two === "${") {
      const end = closeBrace(s, i + 1);
      out += s.slice(i, end + 1);
      i = end;
      p.step(IN_WORD);
    } else if (!dq && c === "#") {
      if (hashKind(p) === "comment") {
        ctx.comment();
        const nl = s.indexOf("\n", i);
        i = nl < 0 ? s.length : nl - 1; // keep the newline
      } else {
        out += "\\#";
        p.step(c);
      }
    } else if (!dq && c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new Unevaluable("unterminated single quote");
      out += s.slice(i, end + 1);
      i = end;
      p.step(IN_WORD);
    } else if (c === '"') {
      dq = !dq;
      out += c;
      p.step(IN_WORD);
    } else if (two === "$(" || (!dq && (two === "<(" || two === ">("))) {
      const end = closeParen(s, i + 1);
      const refusal = visit(s.slice(i + 2, end));
      if (refusal) return { text: "", refusal };
      out += SUB;
      i = end;
      p.step(IN_WORD);
    } else if (c === "`") {
      const end = closeBacktick(s, i + 1);
      const refusal = visit(s.slice(i + 1, end));
      if (refusal) return { text: "", refusal };
      out += SUB;
      i = end;
      p.step(IN_WORD);
    } else if (!dq && two === "<<") {
      if (s[i + 2] !== "<") throw new Unevaluable("heredoc");
      out += "<<<"; // here-string
      i += 2;
      p.step("<");
    } else {
      if (!dq && NON_BASH_BLANK.test(c)) {
        throw new Unevaluable(`unquoted non-blank whitespace U+${c.codePointAt(0)?.toString(16)}`);
      }
      if (!dq) {
        if (c === "(") ctx.open(p);
        else if (c === ")") ctx.close();
        else ctx.word(s, i, p, false);
      }
      out += c;
      p.step(c);
    }
  }
  if (dq) throw new Unevaluable("unterminated double quote");
  return { text: out };
}

/** Split into simple commands. Glob words are marked so argv0 can be recognised as dynamic. */
function segments(command: string): string[][] {
  // Newlines separate commands; shell-quote would otherwise treat them as whitespace.
  const toks: Tok[] = parse(command.replace(/\n/g, " ; "), (k) => `$${k}`);
  const out: string[][] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.length > 0) out.push(cur);
    cur = [];
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as Tok;
    if (typeof t === "string") cur.push(t);
    else if ("comment" in t) throw new Unevaluable("unexpected comment");
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

const ENV_LONG_SCRIPT = ["--split-string"];
const ENV_LONG_ARG = ["--unset", "--chdir", "--argv0"];
const ENV_LONG_FLAG = [
  "--ignore-environment",
  "--null",
  "--debug",
  "--help",
  "--version",
  "--default-signal",
  "--ignore-signal",
  "--block-signal",
  "--list-signal-handling",
];
const ENV_SHORT_FLAGS = "i0v";
const ENV_SHORT_ARG = "uCaPLU";

/**
 * Skip `env`'s options. A split-string option (`-S`, `-iS`, `-S'cmd'`, `--split-string[=]`,
 * unambiguous prefixes like `--split=`) is a script: it is pushed to `scripts` and undefined is
 * returned. Unrecognised options throw (refused); they are never skipped.
 */
function envOptions(args: string[], scripts: string[]): string[] | undefined {
  let r = args;
  while (r.length > 0 && (r[0] as string).startsWith("-") && r[0] !== "--") {
    const o = r[0] as string;
    if (o.startsWith("--")) {
      const name = (o.split("=")[0] as string) || o;
      const hasEq = o.includes("=");
      const prefix = (list: string[]) => name.length >= 3 && list.some((l) => l.startsWith(name));
      if (prefix(ENV_LONG_SCRIPT)) {
        scripts.push(hasEq ? o.slice(o.indexOf("=") + 1) : ((r[1] as string | undefined) ?? ""));
        return undefined;
      }
      if (prefix(ENV_LONG_ARG)) r = r.slice(hasEq ? 1 : 2);
      else if (prefix(ENV_LONG_FLAG)) r = r.slice(1);
      else throw new Unevaluable(`env option ${o}`);
      continue;
    }
    let consumed = 1;
    for (let k = 1; k < o.length; k++) {
      const ch = o[k] as string;
      if (ch === "S") {
        const rest = o.slice(k + 1);
        scripts.push(rest !== "" ? rest : ((r[1] as string | undefined) ?? ""));
        return undefined;
      }
      if (ENV_SHORT_ARG.includes(ch)) {
        if (k === o.length - 1) consumed = 2;
        break;
      }
      if (!ENV_SHORT_FLAGS.includes(ch)) throw new Unevaluable(`env option ${o}`);
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
    // Any JS whitespace (a superset of bash blanks) in a quoted argv0 is refused, never skipped.
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
