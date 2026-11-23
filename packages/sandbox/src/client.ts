import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE_VERSION, RewireError } from "@rewire/core";
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
  // The npm bundle is never a checkout: walking up from node_modules could land in whatever
  // Rust + pnpm repo sheperd happens to be installed in, and take its target/ binary.
  if (BUNDLE_VERSION !== undefined) return undefined;
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

function executableFile(p: string): { mtimeMs: number } | undefined {
  try {
    const st = statSync(p);
    if (!st.isFile()) return undefined;
    accessSync(p, constants.X_OK);
    return st;
  } catch {
    return undefined;
  }
}

/** The npm platform packages that carry a prebuilt binary, keyed `<platform>-<arch>`. */
const PLATFORM_PACKAGES = new Set(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]);

/** `sheperd-<platform>-<arch>`, or undefined when no prebuilt binary is published for the host. */
export function platformPackageName(platform: string, arch: string): string | undefined {
  const key = `${platform}-${arch}`;
  return PLATFORM_PACKAGES.has(key) ? `sheperd-${key}` : undefined;
}

export type FindBinaryOptions = {
  /** Default `process.env` (REWIRE_SANDBOX_BIN, PATH). */
  env?: NodeJS.ProcessEnv;
  /** The rewire source checkout to look in; `null` skips it. Default: found from this module. */
  sourceRoot?: string | null;
  /**
   * Resolves `<name>/package.json` to an absolute path, or throws when it is not installed.
   * Default: `require.resolve` from this module, i.e. from the installed sheperd package. `null`
   * skips the platform package.
   */
  resolvePackage?: ((specifier: string) => string) | null;
  /** Default `process.platform` / `process.arch`. */
  platform?: string;
  arch?: string;
  /** The version the platform package must have. Default: the bundle's own version, if any. */
  expectedVersion?: string;
};

export type SandboxBinarySource = "env" | "checkout" | "platform-package" | "path";
export type SandboxBinary = { path: string; source: SandboxBinarySource; detail?: string };

const notInstalled = (e: unknown): boolean =>
  e instanceof Error && (e as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND";

/**
 * The installed `sheperd-<platform>-<arch>` package's binary, or undefined when that package is
 * not installed. An installed package that cannot supply a usable binary throws (#22): a broken
 * or mismatched install never falls through to whatever is on PATH.
 */
function platformPackageBinary(
  name: string,
  resolvePackage: (specifier: string) => string,
  expectedVersion: string | undefined,
): string | undefined {
  const broken = (why: string) =>
    new RewireError(
      "binary_missing",
      `the installed ${name} package ${why}`,
      `reinstall sheperd (npm i -g sheperd@${expectedVersion ?? "next"}) or set REWIRE_SANDBOX_BIN`,
    );
  let manifest: string;
  try {
    manifest = resolvePackage(`${name}/package.json`);
  } catch (e) {
    if (notInstalled(e)) return undefined;
    throw broken(`cannot be resolved: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isAbsolute(manifest)) throw broken(`resolved to a relative path: ${manifest}`);
  if (expectedVersion !== undefined) {
    let version: unknown;
    try {
      version = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown }).version;
    } catch (e) {
      throw broken(`has an unreadable package.json: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (version !== expectedVersion) {
      throw broken(`is version ${String(version)}, but sheperd is ${expectedVersion}`);
    }
  }
  const bin = join(dirname(manifest), "rewire-sandbox");
  if (!executableFile(bin)) throw broken(`has no executable regular file at ${bin}`);
  return bin;
}

/**
 * Where the rewire-sandbox binary is, in this order: `REWIRE_SANDBOX_BIN` (a missing file is an
 * error, never a fall-through); the newer of `target/release` and `target/debug` in the rewire
 * source checkout (never from the npm bundle); the installed `sheperd-<platform>-<arch>`
 * package; the first absolute PATH entry that has it (relative entries are skipped, #25).
 * The run (preflight and every SandboxClient) and `rewire doctor` both use exactly this (I1).
 */
export function locateSandboxBinary(opts: FindBinaryOptions = {}): SandboxBinary {
  const env = opts.env ?? process.env;
  const override = env.REWIRE_SANDBOX_BIN;
  if (override) {
    if (existsSync(override)) return { path: override, source: "env" };
    throw new RewireError(
      "binary_missing",
      `REWIRE_SANDBOX_BIN points at a missing file: ${override}`,
      "unset it or run cargo build -p rewire-sandbox",
    );
  }
  const root = opts.sourceRoot === undefined ? rewireRepoRoot() : opts.sourceRoot;
  if (root) {
    let best: { p: string; mtimeMs: number } | undefined;
    for (const profile of ["release", "debug"]) {
      const p = join(root, "target", profile, "rewire-sandbox");
      const st = executableFile(p);
      if (st && (best === undefined || st.mtimeMs > best.mtimeMs))
        best = { p, mtimeMs: st.mtimeMs };
    }
    if (best) return { path: best.p, source: "checkout" };
  }
  const name = platformPackageName(opts.platform ?? process.platform, opts.arch ?? process.arch);
  const resolvePackage =
    opts.resolvePackage === undefined
      ? createRequire(import.meta.url).resolve
      : opts.resolvePackage;
  if (name && resolvePackage) {
    const expected = "expectedVersion" in opts ? opts.expectedVersion : BUNDLE_VERSION;
    const bin = platformPackageBinary(name, resolvePackage, expected);
    if (bin) return { path: bin, source: "platform-package", detail: name };
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, "rewire-sandbox");
    if (executableFile(p)) return { path: p, source: "path" };
  }
  const reinstall = name ? `reinstall sheperd so its optional ${name} package installs, ` : "";
  throw new RewireError(
    "binary_missing",
    "rewire-sandbox binary not found",
    `${reinstall}run cargo build -p rewire-sandbox, put rewire-sandbox on PATH, or set REWIRE_SANDBOX_BIN`,
  );
}

/** The path {@link locateSandboxBinary} finds. */
export function findSandboxBinary(opts: FindBinaryOptions = {}): string {
  return locateSandboxBinary(opts).path;
}

/**
 * Whether the sandbox binary can be found, for suites that need it. With
 * `REWIRE_REQUIRE_SANDBOX=1` (CI) a missing binary throws instead, so a suite can never go green
 * by skipping (I2, R40).
 */
export function sandboxAvailable(opts: FindBinaryOptions = {}): boolean {
  const env = opts.env ?? process.env;
  try {
    findSandboxBinary(opts);
    return true;
  } catch (e) {
    if (env.REWIRE_REQUIRE_SANDBOX === "1") {
      throw new Error(
        `REWIRE_REQUIRE_SANDBOX=1 but the sandbox binary is unavailable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return false;
  }
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

function run(
  bin: string,
  limits: { watchdogMs: number; maxOutputBytes: number; killGraceMs: number },
  args: string[],
  stdin?: string,
): Promise<Raw> {
  return new Promise((res, rej) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const size = { out: 0, err: 0 };
    let stderrTail = "";
    let failure: RewireError | undefined;
    let closed = false;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const settle = (f: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      clearTimeout(killTimer);
      f();
    };
    // Watchdog / output cap: SIGTERM first so the binary can sweep the command's
    // descendants, SIGKILL only if it has not exited within the grace.
    const fail = (reason: string): void => {
      if (failure || settled) return;
      failure = new RewireError("sandbox_unavailable", reason);
      clearTimeout(watchdog);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (closed) return;
        child.kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        settle(() =>
          rej(
            new RewireError(
              "sandbox_unavailable",
              `${reason}; no exit within ${limits.killGraceMs}ms of SIGTERM, SIGKILLed`,
            ),
          ),
        );
      }, limits.killGraceMs);
    };
    const watchdog = setTimeout(
      () => fail(`rewire-sandbox watchdog fired after ${limits.watchdogMs}ms; child terminated`),
      limits.watchdogMs,
    );
    const collect = (which: "out" | "err", bucket: Buffer[]) => (d: Buffer) => {
      if (which === "err") stderrTail = (stderrTail + d.toString("utf8")).slice(-2000);
      if (failure) return; // keep draining, discard
      size[which] += d.length;
      if (size[which] > limits.maxOutputBytes) {
        fail(
          `rewire-sandbox ${which === "out" ? "stdout" : "stderr"} output exceeded ${limits.maxOutputBytes} bytes; child terminated`,
        );
        return;
      }
      bucket.push(d);
    };
    child.stdout.on("data", collect("out", out));
    child.stderr.on("data", collect("err", err));
    child.on("error", (e) =>
      settle(() =>
        rej(new RewireError("sandbox_unavailable", `cannot run rewire-sandbox: ${e.message}`)),
      ),
    );
    child.on("close", (code, signal) => {
      closed = true;
      settle(() => {
        if (failure) {
          const tail = stderrTail.trim();
          rej(
            new RewireError(
              "sandbox_unavailable",
              tail ? `${failure.message}; binary stderr: ${tail}` : failure.message,
            ),
          );
          return;
        }
        res({
          code,
          signal,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        });
      });
    });
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

const DEFAULT_WATCHDOG_MS = 30_000;
const EXEC_GRACE_MS = 5_000;
const KILL_GRACE_MS = 5_000;
const DEFAULT_MAX_OUTPUT = 16 * 1024 * 1024;

export type ClientOptions = {
  /** Bound for check-path/fs-read/fs-write (default 30s). */
  watchdogMs?: number;
  /** Added to exec's timeoutMs before the TS-side kill (default 5s). */
  execGraceMs?: number;
  /** After SIGTERM on watchdog/cap, wait this long before SIGKILL (default 5s). */
  killGraceMs?: number;
  /** Per-stream output cap (default 16 MiB). */
  maxOutputBytes?: number;
};

function inside(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep);
}

export class SandboxClient {
  private readonly bin: string;
  private readonly profile: CapabilityProfile;
  private readonly watchdogMs: number;
  private readonly execGraceMs: number;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;
  private readonly dir: string;
  readonly profilePath: string;

  constructor(profile: CapabilityProfile, binPath?: string, opts: ClientOptions = {}) {
    this.profile = profile;
    this.watchdogMs = opts.watchdogMs ?? DEFAULT_WATCHDOG_MS;
    this.execGraceMs = opts.execGraceMs ?? EXEC_GRACE_MS;
    this.killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
    this.maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    this.bin = binPath ?? findSandboxBinary();
    this.dir = mkdtempSync(join(tmpdir(), "rewire-profile-"));
    registerProfileDir(this.dir);
    this.profilePath = join(this.dir, "profile.json");
    writeFileSync(this.profilePath, JSON.stringify(profile), { mode: 0o600 });
  }

  private limits(watchdogMs = this.watchdogMs) {
    return {
      watchdogMs,
      maxOutputBytes: this.maxOutputBytes,
      killGraceMs: this.killGraceMs,
    };
  }

  private checkCwd(cwd: string): string {
    let real: string;
    let root: string;
    try {
      real = realpathSync(resolve(cwd));
      root = realpathSync(this.profile.root);
    } catch (e) {
      throw new RewireError("sandbox_unavailable", `cannot resolve exec cwd ${cwd}: ${String(e)}`);
    }
    if (!inside(real, root)) {
      throw new RewireError("path_protected", `${real} is protected (rule <outside-root>)`);
    }
    return real;
  }

  /** Delete the temp profile early. */
  dispose(): void {
    removeDir(this.dir);
  }

  async checkPath(op: "read" | "write", path: string): Promise<CheckResult> {
    const r = await run(this.bin, this.limits(), [
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
    const r = await run(this.bin, this.limits(), [
      "fs-read",
      "--profile",
      this.profilePath,
      "--",
      path,
    ]);
    if (r.code === 0) return r.stdout;
    if (r.code === EXIT_DENY) {
      const d = parseDeny(r);
      throw new RewireError("path_protected", `${d.canonical} is protected (rule ${d.rule})`);
    }
    throw unavailable("fs-read", r);
  }

  async write(path: string, content: string): Promise<void> {
    const r = await run(
      this.bin,
      this.limits(),
      ["fs-write", "--profile", this.profilePath, "--", path],
      content,
    );
    if (r.code === 0) return;
    if (r.code === EXIT_DENY) {
      const d = parseDeny(r);
      throw new RewireError("path_protected", `${d.canonical} is protected (rule ${d.rule})`);
    }
    throw unavailable("fs-write", r);
  }

  async exec(argv: string[], opts: { timeoutMs: number; cwd?: string }): Promise<ExecResult> {
    // cwd must be inside profile.root only (extraWrite is a write target, not a cwd), matching
    // the binary's resolve_cwd. Containment is enforced here: exec's exit 3 is the child's own code (the
    // binary's cwd denial would be indistinguishable from it), so it is never a deny.
    const cwd = opts.cwd === undefined ? undefined : this.checkCwd(opts.cwd);
    const args = ["exec", "--profile", this.profilePath, "--timeout-ms", String(opts.timeoutMs)];
    if (cwd !== undefined) args.push("--cwd", cwd);
    args.push("--", ...argv);
    const r = await run(this.bin, this.limits(opts.timeoutMs + this.execGraceMs), args);
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
