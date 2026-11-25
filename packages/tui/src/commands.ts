import type { CheckpointKind } from "@rewire/core";

/** A parsed slash command. `error` is a usage problem to show; `unknown` names the command. */
export type Command =
  | { kind: "run"; task: string }
  | { kind: "skills" }
  | { kind: "checkpoints"; set?: Set<CheckpointKind> }
  | { kind: "model" }
  | { kind: "resume"; id?: string }
  | { kind: "clear" }
  | { kind: "doctor" }
  | { kind: "help" }
  | { kind: "exit" }
  | { kind: "skip" }
  | { kind: "error"; message: string }
  | { kind: "unknown"; name: string };

/** The TUI's checkpoint defaults: pause after the contract and after the tests, not before commit. */
export const DEFAULT_CHECKPOINTS: ReadonlySet<CheckpointKind> = new Set<CheckpointKind>([
  "contract",
  "tests",
]);

const KINDS: readonly CheckpointKind[] = ["contract", "tests", "commit"];

export const HELP = [
  "/run <task>        start a gated run directly",
  "/skills            list skills; review pending repo skills",
  "/checkpoints [contract] [tests] [commit] | off",
  "                   show or set where runs pause for approval",
  "/model             show the model routing",
  "/resume [id]       list stored sessions, or resume one",
  "/clear             start a fresh session (the old one stays resumable)",
  "/doctor            check prerequisites",
  "/skip              decline a run's clarification questions",
  "/help              this list",
  "/exit              quit",
  "//text             send text that starts with a slash",
].join("\n");

/**
 * True when `line` is a slash command. A line starting with `//` is not: it is chat text with one
 * leading slash removed (see `literalText`), so a message can start with a path like `/etc`.
 */
export function isCommand(line: string): boolean {
  return line.startsWith("/") && !line.startsWith("//");
}

/** The chat text to send for a non-command line: `//x` becomes `/x`, anything else is unchanged. */
export function literalText(line: string): string {
  return line.startsWith("//") ? line.slice(1) : line;
}

function checkpoints(args: string[]): Command {
  if (args.length === 0) return { kind: "checkpoints" };
  if (args.length === 1 && args[0] === "off") return { kind: "checkpoints", set: new Set() };
  const set = new Set<CheckpointKind>();
  for (const a of args) {
    if (!(KINDS as readonly string[]).includes(a)) {
      return {
        kind: "error",
        message: `unknown checkpoint ${a}: use contract, tests, commit, or off alone`,
      };
    }
    set.add(a as CheckpointKind);
  }
  return { kind: "checkpoints", set };
}

/** Parses one submitted line. Undefined when the line is not a command (chat text). */
export function parseCommand(line: string): Command | undefined {
  if (!isCommand(line)) return undefined;
  const m = /^(\S*)([\s\S]*)$/.exec(line) as RegExpExecArray;
  const name = m[1] as string;
  const rest = (m[2] as string).trim();
  const args = rest === "" ? [] : rest.split(/\s+/);
  switch (name) {
    case "/run":
      return rest === ""
        ? { kind: "error", message: "usage: /run <task>" }
        : { kind: "run", task: rest };
    case "/checkpoints":
      return checkpoints(args);
    case "/resume":
      return args[0] === undefined ? { kind: "resume" } : { kind: "resume", id: args[0] };
    case "/skills":
    case "/model":
    case "/clear":
    case "/doctor":
    case "/help":
    case "/exit":
    case "/skip":
      return { kind: name.slice(1) as "skills" };
    default:
      return { kind: "unknown", name };
  }
}

/** `/checkpoints` display text. */
export function describeCheckpoints(set: ReadonlySet<CheckpointKind>): string {
  const on = KINDS.filter((k) => set.has(k));
  return `checkpoints: ${on.length === 0 ? "off" : on.join(", ")}`;
}

/** "2m ago" style age for `/resume`. */
export function age(then: Date, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - then.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
