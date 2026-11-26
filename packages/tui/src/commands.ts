import type { CheckpointKind } from "@rewire/core";

/** A parsed slash command. `error` is a usage problem to show; `unknown` names the command. */
export type Command =
  | { kind: "run"; task: string }
  | { kind: "skills" }
  | { kind: "checkpoints"; set?: Set<CheckpointKind> }
  | { kind: "model" }
  | { kind: "resume"; id?: string }
  | { kind: "clear" }
  | { kind: "compact"; focus?: string }
  | { kind: "context" }
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

/** One slash command for `/help` and the `/` menu. `args` is shown after the name. */
export type CommandHelp = {
  /** Without the slash. */
  name: string;
  /** Usage hint after the name; absent when the command takes no arguments. */
  args?: string;
  /** Whether the arguments are required (`/run <task>`) or optional (`/resume [id]`). */
  argsRequired?: boolean;
  description: string;
  /** Listed (and allowed) while a gated run is active. */
  inRun: boolean;
};

/** The one command table: `/help` and the `/` menu are both built from it, so they cannot drift. */
export const COMMAND_HELP: readonly CommandHelp[] = [
  {
    name: "run",
    args: "<task>",
    argsRequired: true,
    description: "start a gated run directly",
    inRun: false,
  },
  { name: "skills", description: "list skills; review pending repo skills", inRun: true },
  {
    name: "checkpoints",
    args: "[contract] [tests] [commit] | off",
    description: "show or set where runs pause for approval",
    inRun: true,
  },
  { name: "model", description: "show the model routing", inRun: true },
  {
    name: "resume",
    args: "[id]",
    description: "list stored sessions, or resume one",
    inRun: false,
  },
  {
    name: "clear",
    description: "start a fresh session (the old one stays resumable)",
    inRun: false,
  },
  {
    name: "compact",
    args: "[focus]",
    description: "compact the chat context now (optionally on a focus)",
    inRun: false,
  },
  {
    name: "context",
    description: "show the context size, its limit and the session record",
    inRun: true,
  },
  { name: "doctor", description: "check prerequisites", inRun: false },
  { name: "skip", description: "decline a run's clarification questions", inRun: true },
  { name: "help", description: "this list", inRun: true },
  { name: "exit", description: "quit", inRun: false },
];

/** `/name args`, as `/help` and the menu show it. */
export const commandUsage = (c: CommandHelp): string =>
  c.args === undefined ? `/${c.name}` : `/${c.name} ${c.args}`;

const HELP_COL = 19;

export const HELP = [
  ...COMMAND_HELP.flatMap((c) => {
    const usage = commandUsage(c);
    // A usage too long for the column gets the description on its own line.
    return usage.length < HELP_COL
      ? [`${usage.padEnd(HELP_COL)}${c.description}`]
      : [usage, `${"".padEnd(HELP_COL)}${c.description}`];
  }),
  `${"//text".padEnd(HELP_COL)}send text that starts with a slash`,
].join("\n");

const IN_RUN = new Set(COMMAND_HELP.filter((c) => c.inRun).map((c) => c.name));

/** Commands that work while a run is active (the others would race it or the session). */
export function allowedInRun(c: Command): boolean {
  if (c.kind === "checkpoints") return c.set === undefined;
  return IN_RUN.has(c.kind);
}

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
    case "/compact":
      return rest === "" ? { kind: "compact" } : { kind: "compact", focus: rest };
    case "/context":
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
