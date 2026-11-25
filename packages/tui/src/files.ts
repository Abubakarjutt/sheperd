import { execFile } from "node:child_process";
import { sanitize } from "./sanitize.js";

/** The `@` picker lists at most this many repo paths. */
export const MAX_REPO_FILES = 5000;

const TIMEOUT_MS = 3000;
const MAX_BUFFER = 8 * 1024 * 1024;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The repo's tracked and untracked, not-ignored files (`git ls-files -co --exclude-standard`),
 * for the `@` picker. Host side, no shell, never reads a file. Paths that hold a control or
 * terminal-unsafe character are dropped, not shown. At most {@link MAX_REPO_FILES}. A directory
 * that is not a git work tree, a missing git, a timeout or any other error gives `[]`.
 */
export function listRepoFiles(repo: string): Promise<string[]> {
  return new Promise((resolve) => {
    try {
      execFile(
        "git",
        ["-C", repo, "ls-files", "-co", "--exclude-standard", "-z"],
        { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: "utf8", windowsHide: true },
        (err, stdout) => {
          if (err) return resolve([]);
          const out = new Set<string>();
          for (const p of stdout.split("\0")) {
            if (out.size >= MAX_REPO_FILES) break;
            if (p === "" || CONTROL.test(p) || sanitize(p) !== p) continue;
            out.add(p);
          }
          resolve([...out]);
        },
      );
    } catch {
      resolve([]);
    }
  });
}
