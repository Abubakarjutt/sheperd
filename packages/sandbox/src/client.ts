import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RewireError } from "@rewire/core";
import type { CapabilityProfile } from "./profiles.js";

export type CheckResult = { allowed: true } | { allowed: false; canonical: string; rule: string };
export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const EXIT_DENY = 3;
const EXIT_INTERNAL = 120;
const EXIT_TIMEOUT = 124;
const EXIT_NOT_FOUND = 127;

/** The rewire source checkout (not the target repo): nearest ancestor with Cargo.toml and pnpm-workspace.yaml. */
function rewireRepoRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "Cargo.toml")) && existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function findSandboxBinary(): string {
  const env = process.env.REWIRE_SANDBOX_BIN;
  if (env && existsSync(env)) return env;
  const root = rewireRepoRoot();
  if (root) {
    for (const profile of ["release", "debug"]) {
      const p = join(root, "target", profile, "rewire-sandbox");
      if (existsSync(p)) return p;
    }
  }
  throw new RewireError(
    "binary_missing",
    "rewire-sandbox binary not found",
    "run cargo build -p rewire-sandbox",
  );
}

const profileDirs = new Set<string>();
let exitHandlerRegistered = false;

function removeDir(dir: string): void {
  profileDirs.delete(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function registerProfileDir(dir: string): void {
  profileDirs.add(dir);
  if (!exitHandlerRegistered) {
    exitHandlerRegistered = true;
    process.on("exit", () => {
      for (const d of [...profileDirs]) removeDir(d);
    });
  }
}

type Raw = { code: number | null; signal: string | null; stdout: string; stderr: string };

function run(bin: string, args: string[], stdin?: string): Promise<Raw> {
  return new Promise((res, rej) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) =>
      rej(new RewireError("sandbox_unavailable", `cannot run rewire-sandbox: ${e.message}`)),
    );
    child.on("close", (code, signal) =>
      res({
        code,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
    child.stdin.on("error", () => {
      // EPIPE if the binary exits before reading; the exit code tells the story.
    });
    child.stdin.end(stdin ?? "");
  });
}

function unavailable(what: string, r: Raw): RewireError {
  const detail = r.signal ? `signal ${r.signal}` : `exit ${r.code}`;
  return new RewireError(
    "sandbox_unavailable",
    `rewire-sandbox ${what} failed (${detail}): ${r.stderr.trim()}`,
  );
}

function parseDeny(r: Raw): { canonical: string; rule: string } {
  try {
    const j = JSON.parse(r.stderr.trim().split("\n").pop() ?? "") as {
      denied?: unknown;
      rule?: unknown;
    };
    if (typeof j.denied === "string" && typeof j.rule === "string") {
      return { canonical: j.denied, rule: j.rule };
    }
  } catch {
    // fall through
  }
  throw unavailable("deny output", r);
}

export class SandboxClient {
  private readonly bin: string;
  private readonly dir: string;
  readonly profilePath: string;

  constructor(profile: CapabilityProfile, binPath?: string) {
    this.bin = binPath ?? findSandboxBinary();
    this.dir = mkdtempSync(join(tmpdir(), "rewire-profile-"));
    registerProfileDir(this.dir);
    this.profilePath = join(this.dir, "profile.json");
    writeFileSync(this.profilePath, JSON.stringify(profile), { mode: 0o600 });
  }

  /** Delete the temp profile early. */
  dispose(): void {
    removeDir(this.dir);
  }

  async checkPath(op: "read" | "write", path: string): Promise<CheckResult> {
    const r = await run(this.bin, [
      "check-path",
      "--profile",
      this.profilePath,
      "--op",
      op,
      "--",
      path,
    ]);
    if (r.code === 0) return { allowed: true };
    if (r.code === EXIT_DENY) return { allowed: false, ...parseDeny(r) };
    throw unavailable("check-path", r);
  }

  async read(path: string): Promise<string> {
    const r = await run(this.bin, ["fs-read", "--profile", this.profilePath, "--", path]);
    if (r.code === 0) return r.stdout;
    if (r.code === EXIT_DENY) {
      const d = parseDeny(r);
      throw new RewireError("path_protected", `${d.canonical} is protected (rule ${d.rule})`);
    }
    throw unavailable("fs-read", r);
  }

  async write(path: string, content: string): Promise<void> {
    const r = await run(this.bin, ["fs-write", "--profile", this.profilePath, "--", path], content);
    if (r.code === 0) return;
    if (r.code === EXIT_DENY) {
      const d = parseDeny(r);
      throw new RewireError("path_protected", `${d.canonical} is protected (rule ${d.rule})`);
    }
    throw unavailable("fs-write", r);
  }

  async exec(argv: string[], opts: { timeoutMs: number; cwd?: string }): Promise<ExecResult> {
    const args = ["exec", "--profile", this.profilePath, "--timeout-ms", String(opts.timeoutMs)];
    if (opts.cwd !== undefined) args.push("--cwd", resolve(opts.cwd));
    args.push("--", ...argv);
    const r = await run(this.bin, args);
    if (r.code === null) throw unavailable("exec", r);
    if (r.code === EXIT_NOT_FOUND && r.stderr.trim().startsWith("command not found: ")) {
      throw new RewireError("binary_missing", r.stderr.trim());
    }
    if (r.code === EXIT_INTERNAL) {
      if (r.stderr.includes("sandbox: escaped descendant")) {
        throw new RewireError("sandbox_escape", r.stderr.trim());
      }
      throw unavailable("exec", r);
    }
    return {
      exitCode: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      timedOut: r.code === EXIT_TIMEOUT,
    };
  }
}
