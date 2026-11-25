#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runDoctor } from "./doctor.js";
import { isInteractive, tuiRequiresTty } from "./interactive.js";
import { effectivePlatform, isSupported, PLATFORM_MESSAGE } from "./platform.js";
import { formatError, runCommand } from "./run.js";
import { oneLine } from "./sanitize.js";
import { installSigint, onProcessSigint } from "./sigint.js";

const USAGE = `usage:
  rewire                      (on a terminal: the interactive session)
  rewire chat [--repo <path>] [--models <file>]
  rewire run <task> [--repo <path>] [--models <file>] [--headless]
  rewire run --task-file <path> [--repo <path>] [--models <file>] [--headless]
  rewire doctor [--models <file>]
`;

async function drain(): Promise<void> {
  await new Promise<void>((r) => process.stdout.write("", () => r()));
  await new Promise<void>((r) => process.stderr.write("", () => r()));
}

async function main(argv: string[]): Promise<number> {
  const env = process.env;
  if (!isSupported(effectivePlatform(env))) {
    process.stderr.write(`${PLATFORM_MESSAGE}\n`);
    return 1;
  }
  const [command, ...rest] = argv;
  if (command === undefined && isInteractive(process)) return await chat([]);
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (command === "chat") return await chat(rest);
  if (command !== "run" && command !== "doctor") {
    process.stderr.write(`unknown command: ${JSON.stringify(command.slice(0, 40))}\n${USAGE}`);
    return 1;
  }
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        repo: { type: "string" },
        models: { type: "string" },
        "task-file": { type: "string" },
        headless: { type: "boolean", default: false },
      },
    });
    if (command === "doctor") {
      return await runDoctor(values.models, effectivePlatform(env), {
        stdout: process.stdout,
        env,
        cwd: process.cwd(),
      });
    }
    const ac = new AbortController();
    installSigint({
      on: (h) => process.on("SIGINT", h),
      abort: () => ac.abort(),
      exit: (c) => process.exit(c),
      notify: () =>
        process.stderr.write("interrupted: stopping the run (Ctrl-C again to force quit)\n"),
    });
    if (positionals.length > 1) {
      process.stderr.write("usage: quote the task as one argument\n");
      return 1;
    }
    return await runCommand(
      {
        task: positionals[0],
        taskFile: values["task-file"],
        repo: values.repo,
        models: values.models,
        headless: values.headless === true,
      },
      {
        stdout: process.stdout,
        stderr: process.stderr,
        stdin: process.stdin,
        env,
        cwd: process.cwd(),
      },
      ac.signal,
      () => ac.abort(),
    );
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS")) {
      process.stderr.write(`${oneLine(e.message, 300)}\n${USAGE}`);
      return 1;
    }
    process.stderr.write(`${formatError(e)}\n`);
    return 1;
  }
}

/** `rewire chat` (and bare `rewire` on a TTY). The TUI modules load only on this path. */
async function chat(args: string[]): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { repo: { type: "string" }, models: { type: "string" } },
    });
    if (positionals.length > 0) {
      process.stderr.write(`usage: rewire chat takes no task; type it in the session\n${USAGE}`);
      return 1;
    }
    // Packaging self-check (scripts/npm/smoke.mjs): load the TUI modules (Ink, React, yoga-layout)
    // exactly as a TTY session would, then exit, so the bundled TUI is proven to import.
    if (process.env.REWIRE_TUI_SELFCHECK === "1") {
      const { chatCommand } = await import("./tui.js");
      if (typeof chatCommand !== "function") throw new Error("the TUI entry point did not load");
      process.stdout.write("tui: loaded\n");
      return 0;
    }
    if (!isInteractive(process)) throw tuiRequiresTty();
    const { chatCommand } = await import("./tui.js");
    return await chatCommand(
      { repo: values.repo, models: values.models },
      {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        env: process.env,
        cwd: process.cwd(),
        onSigint: onProcessSigint,
        exit: (c) => process.exit(c),
      },
    );
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS")) {
      process.stderr.write(`${oneLine(e.message, 300)}\n${USAGE}`);
      return 1;
    }
    process.stderr.write(`${formatError(e)}\n`);
    return 1;
  }
}

main(process.argv.slice(2)).then(
  async (code) => {
    await drain();
    process.exit(code);
  },
  async (e) => {
    process.stderr.write(`${formatError(e)}\n`);
    await drain();
    process.exit(1);
  },
);
