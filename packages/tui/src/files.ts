import { spawn } from "node:child_process";
import { sanitize } from "./sanitize.js";

/** The `@` picker lists at most this many repo paths. */
export const MAX_REPO_FILES = 5000;

const TIMEOUT_MS = 3000;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export type ListRepoFilesOptions = {
  /** The git executable (tests point this at a fake). Default `git` on PATH. */
  git?: string;
  /** Wall clock for the whole listing. Default 3 s. */
  timeoutMs?: number;
};

/**
 * The repo's tracked and untracked, not-ignored files (`git ls-files -co --exclude-standard -z`),
 * for the `@` picker. Host side, no shell, never reads a file. The `-z` stream is read as it
 * arrives and git is killed once {@link MAX_REPO_FILES} usable paths are in, so a huge repo still
 * gives its first 5000. Paths that hold a control or terminal-unsafe character are dropped. A
 * directory that is not a git work tree, a missing git, a timeout or any other error gives `[]`.
 */
export function listRepoFiles(repo: string, opts: ListRepoFilesOptions = {}): Promise<string[]> {
  return new Promise((resolve) => {
    const out = new Set<string>();
    let rest = "";
    let settled = false;
    const finish = (list: string[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(list);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        opts.git ?? "git",
        // fsmonitor off: the listing must never start a hook the (untrusted) repo configures.
        ["-c", "core.fsmonitor=false", "-C", repo, "ls-files", "-co", "--exclude-standard", "-z"],
        { stdio: ["ignore", "pipe", "ignore"], shell: false, windowsHide: true },
      );
    } catch {
      resolve([]);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish([]);
    }, opts.timeoutMs ?? TIMEOUT_MS);
    child.on("error", () => finish([]));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (settled) return;
      const parts = (rest + chunk).split("\0");
      rest = parts.pop() ?? ""; // an entry cut by the chunk boundary waits for the next chunk
      for (const p of parts) {
        if (p === "" || CONTROL.test(p) || sanitize(p) !== p) continue;
        out.add(p);
        if (out.size >= MAX_REPO_FILES) {
          child.kill("SIGKILL"); // enough: a kill by us is a success
          finish([...out]);
          return;
        }
      }
    });
    child.on("close", (code) => finish(code === 0 ? [...out] : []));
  });
}
