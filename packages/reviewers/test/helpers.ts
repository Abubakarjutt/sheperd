import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SandboxClient } from "@rewire/sandbox";

/** A host-backed stand-in for the review SandboxClient (exec runs the real argv; read reads the file). */
export const hostClient = (): SandboxClient =>
  ({
    exec: (argv: string[], opts: { cwd?: string }) =>
      new Promise((resolve) => {
        const [bin = "", ...args] = argv;
        execFile(
          bin,
          args,
          { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
          (err, stdout, stderr) => {
            const code = err ? ((err as { code?: unknown }).code as number | string) : 0;
            resolve({
              exitCode: typeof code === "number" ? code : 1,
              stdout,
              stderr,
              timedOut: false,
            });
          },
        );
      }),
    read: async (p: string) => readFileSync(p, "utf8"),
    dispose() {},
  }) as unknown as SandboxClient;

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

export function put(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/** A repo with one commit containing `base` files; returns its real path. */
export function makeRepo(base: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rewire-rev-")));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  git(root, "config", "commit.gpgsign", "false");
  for (const [p, c] of Object.entries(base)) put(root, p, c);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}
