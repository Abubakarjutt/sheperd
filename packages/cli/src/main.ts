#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runDoctor } from "./doctor.js";
import { effectivePlatform, isSupported, PLATFORM_MESSAGE } from "./platform.js";
import { formatError, runCommand } from "./run.js";
import { installSigint } from "./sigint.js";

const USAGE = `usage:
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
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }
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
    );
  } catch (e) {
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
