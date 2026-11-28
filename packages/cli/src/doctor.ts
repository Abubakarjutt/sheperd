import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { Writable } from "node:stream";
import { RewireError } from "@rewire/core";
import { INSTALL_HINTS } from "@rewire/gates";
import { defaultWebConfig, loadModelsFile, type WebConfig } from "@rewire/pipeline";
import { loadPolicy } from "@rewire/policy";
import { probeOllama, resolveOllamaTimeout } from "@rewire/providers";
import { type FindBinaryOptions, locateSandboxBinary, type SandboxBinary } from "@rewire/sandbox";
import { providerLines } from "./doctor-providers.js";
import { webLine } from "./doctor-web.js";
import { discoverModels, ollamaBase } from "./models.js";
import { defaultModelsFile } from "./run.js";
import { oneLine } from "./sanitize.js";

export const HINTS: Record<string, string> = {
  ...INSTALL_HINTS,
  git: "install git: https://git-scm.com/downloads",
  "rewire-sandbox":
    "reinstall sheperd (npm i -g sheperd@next), build it with cargo build -p rewire-sandbox, or set REWIRE_SANDBOX_BIN to the binary",
  "sandbox-exec":
    "sandbox-exec ships with macOS (/usr/bin/sandbox-exec); this system looks damaged",
};

export function findOnPath(bin: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const p = join(dir, bin);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return undefined;
}

const isDirectory = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export type DoctorIo = {
  stdout: Writable;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The repo whose `.rewire/policy.toml` the web line reads (`--repo`; default `cwd`). */
  repo?: string | undefined;
  /** Test seam: lookup options other than `env` (default: the run's own defaults). */
  sandboxLookup?: Omit<FindBinaryOptions, "env">;
};

const SOURCE_LABEL: Record<SandboxBinary["source"], string> = {
  env: "REWIRE_SANDBOX_BIN",
  checkout: "source checkout",
  "platform-package": "platform package",
  path: "PATH",
};

/** `<path> (<where it came from>)`, e.g. `.../rewire-sandbox (platform package sheperd-linux-x64)`. */
export function describeSandboxBinary(b: SandboxBinary): string {
  const from = b.detail ? `${SOURCE_LABEL[b.source]} ${b.detail}` : SOURCE_LABEL[b.source];
  return `${b.path} (${from})`;
}

/** One line per check; returns the exit code (1 when anything required is missing). */
export async function runDoctor(
  modelsPath: string | undefined,
  platform: string,
  io: DoctorIo,
): Promise<number> {
  let failed = false;
  const ok = (name: string, detail: string) => io.stdout.write(`✓ ${name} ${detail}\n`);
  const note = (name: string, why: string, hint: string | undefined) =>
    io.stdout.write(`! ${name} — ${why}${hint ? ` — ${hint}` : ""}\n`);
  const bad = (name: string, why: string, hint: string | undefined) => {
    failed = true;
    io.stdout.write(`✗ ${name} — ${why}${hint ? ` — ${hint}` : ""}\n`);
  };

  // The exact lookup a run uses (I1): doctor never accepts a binary the run cannot find.
  try {
    const found = locateSandboxBinary({ ...io.sandboxLookup, env: io.env });
    ok("rewire-sandbox", oneLine(describeSandboxBinary(found), 300));
  } catch (e) {
    bad(
      "rewire-sandbox",
      oneLine(e instanceof Error ? e.message : "not found"),
      e instanceof RewireError ? e.hint : HINTS["rewire-sandbox"],
    );
  }

  const bins = [
    "git",
    "rg",
    "semgrep",
    "gitleaks",
    platform === "linux" ? "bwrap" : "sandbox-exec",
  ];
  for (const b of bins) {
    const p = findOnPath(b, io.env);
    if (p) ok(b, p);
    else bad(b, "not found", HINTS[b]);
  }

  // models.toml [web], when the models file loads (the defaults otherwise).
  let web: WebConfig = defaultWebConfig();
  // Models, then Ollama reachability and version when any of them is an Ollama model.
  try {
    const file =
      modelsPath !== undefined ? resolve(io.cwd, modelsPath) : await defaultModelsFile(io.env);
    const models = file
      ? await loadModelsFile(file)
      : { available: await discoverModels(io.env), overrides: {} };
    const available = models.available;
    if ("web" in models) web = models.web;
    ok("models", oneLine(available.map((m) => `${m.provider}:${m.model}`).join(", "), 300));
    if (available.some((m) => m.provider === "ollama")) {
      const base = ollamaBase(io.env);
      try {
        const timeout = resolveOllamaTimeout(io.env, "providers" in models ? models.providers : {});
        const { version } = await probeOllama(base);
        ok(
          "ollama",
          `${version} at ${base}, reply timeout ${timeout.ms / 1000}s (${timeout.source})`,
        );
      } catch (e) {
        bad(
          "ollama",
          oneLine(e instanceof Error ? e.message : String(e)),
          e instanceof RewireError ? e.hint : undefined,
        );
      }
    }
    // Cloud providers and endpoints: what each resolved, credentials by env var name only.
    for (const l of providerLines(models, io.env)) {
      const hint = !l.ok && l.hint !== undefined ? oneLine(l.hint, 300) : undefined;
      if (l.ok) ok(l.name, oneLine(l.detail, 300));
      else if (l.used) bad(l.name, oneLine(l.why, 300), hint);
      // A table nothing routes to cannot break a run: a note, not a failure.
      else note(`${l.name} (no model uses it)`, oneLine(l.why, 300), hint);
    }
  } catch (e) {
    bad(
      "models",
      oneLine(e instanceof Error ? e.message : String(e)),
      e instanceof RewireError ? e.hint : undefined,
    );
  }
  // Web access: optional, so a missing key or web off is a note; a broken policy fails a run.
  try {
    const repo = resolve(io.cwd, io.repo ?? ".");
    if (!isDirectory(repo)) throw new Error(`--repo ${repo} is not a directory`);
    const policy = await loadPolicy(repo);
    const l = webLine(web, io.env, policy);
    if (l.ok) ok("web", oneLine(l.detail, 300));
    else note("web", oneLine(l.detail, 300), undefined);
  } catch (e) {
    bad(
      "policy",
      oneLine(e instanceof Error ? e.message : String(e)),
      e instanceof RewireError ? e.hint : undefined,
    );
  }
  return failed ? 1 : 0;
}
