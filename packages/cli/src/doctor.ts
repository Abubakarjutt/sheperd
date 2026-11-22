import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { Writable } from "node:stream";
import { RewireError } from "@rewire/core";
import { INSTALL_HINTS } from "@rewire/gates";
import { loadModelsFile } from "@rewire/pipeline";
import { probeOllama } from "@rewire/providers";
import { findSandboxBinary } from "@rewire/sandbox";
import { discoverModels, ollamaBase } from "./models.js";
import { defaultModelsFile } from "./run.js";
import { oneLine } from "./sanitize.js";

export const HINTS: Record<string, string> = {
  ...INSTALL_HINTS,
  git: "install git: https://git-scm.com/downloads",
  "rewire-sandbox":
    "build it with: cargo build -p rewire-sandbox (or set REWIRE_SANDBOX_BIN to the binary)",
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

export type DoctorIo = { stdout: Writable; env: NodeJS.ProcessEnv; cwd: string };

/** One line per check; returns the exit code (1 when anything required is missing). */
export async function runDoctor(
  modelsPath: string | undefined,
  platform: string,
  io: DoctorIo,
): Promise<number> {
  let failed = false;
  const ok = (name: string, detail: string) => io.stdout.write(`✓ ${name} ${detail}\n`);
  const bad = (name: string, why: string, hint: string | undefined) => {
    failed = true;
    io.stdout.write(`✗ ${name} — ${why}${hint ? ` — ${hint}` : ""}\n`);
  };

  try {
    ok("rewire-sandbox", oneLine(findSandboxBinary(), 300));
  } catch (e) {
    const p = findOnPath("rewire-sandbox", io.env);
    if (p) ok("rewire-sandbox", p);
    else
      bad(
        "rewire-sandbox",
        "not found",
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

  // Models, then Ollama reachability and version when any of them is an Ollama model.
  try {
    const file =
      modelsPath !== undefined ? resolve(io.cwd, modelsPath) : await defaultModelsFile(io.env);
    const available = file ? (await loadModelsFile(file)).available : await discoverModels(io.env);
    ok("models", available.map((m) => `${m.provider}:${m.model}`).join(", "));
    if (available.some((m) => m.provider === "ollama")) {
      const base = ollamaBase(io.env);
      try {
        const { version } = await probeOllama(base);
        ok("ollama", `${version} at ${base}`);
      } catch (e) {
        bad(
          "ollama",
          oneLine(e instanceof Error ? e.message : String(e)),
          e instanceof RewireError ? e.hint : undefined,
        );
      }
    }
  } catch (e) {
    bad(
      "models",
      oneLine(e instanceof Error ? e.message : String(e)),
      e instanceof RewireError ? e.hint : undefined,
    );
  }
  return failed ? 1 : 0;
}
