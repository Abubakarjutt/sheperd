import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { RewireError, redact } from "@rewire/core";
import { REPO_SKILL_CAPS, repoSkillsHash, type Skill, trustRepo } from "@rewire/skills";
import { Box, useInput } from "ink";
import { useRef, useState } from "react";
import { fit } from "./fit.js";
import { Safe } from "./safe.js";
import { theme } from "./theme.js";
import { useColumns } from "./use-columns.js";

/** At most this many entries (files and directories) per skill in the live walk: the repo cap. */
export const VIEW_FILES_CAP = REPO_SKILL_CAPS.files;
/** The live walk never descends deeper than this. */
export const VIEW_MAX_DEPTH = 16;

export type SkillFile = { path: string; bytes: number; symlink?: boolean };

/**
 * The files under a skill dir as they are on disk now, read on the host with `lstat`: a symlink is
 * listed as one (its own size) and never followed, and directories are walked without following
 * links. Only `dir` itself is followed, once, as discovery does (a user skill dir is often a
 * link): its real path is walked and returned as `linkedTo`; links inside are never followed. Bounded: files and directories both count toward `cap`, and the walk stops at `maxDepth`;
 * `truncated` is true only when something was actually left out. Paths are relative to `dir` and
 * sorted. Names are NOT sanitized here.
 */
export async function listSkillFiles(
  dir: string,
  cap: number = VIEW_FILES_CAP,
  maxDepth: number = VIEW_MAX_DEPTH,
): Promise<{ entries: SkillFile[]; truncated: boolean; linkedTo?: string }> {
  const entries: SkillFile[] = [];
  let seen = 0;
  let truncated = false;
  const walk = async (d: string, depth: number): Promise<void> => {
    const names = (await readdir(d)).sort();
    for (const name of names) {
      if (truncated) return;
      if (seen >= cap) {
        truncated = true;
        return;
      }
      seen++;
      const p = join(d, name);
      const st = await lstat(p);
      if (st.isDirectory()) {
        if (depth >= maxDepth) {
          truncated = true;
          return;
        }
        await walk(p, depth + 1);
      } else {
        entries.push({
          path: relative(base, p),
          bytes: st.size,
          ...(st.isSymbolicLink() ? { symlink: true } : {}),
        });
      }
    }
  };
  const linked = (await lstat(dir)).isSymbolicLink();
  const base = linked ? await realpath(dir) : dir;
  await walk(base, 1);
  return { entries, truncated, ...(linked ? { linkedTo: base } : {}) };
}

/** Shown next to a repo skill that a user skill of the same name hides. */
export const SHADOWED_LABEL = "(shadowed by your user skill; would load if that is removed)";

/** Every repo skill the approval's hash covers (`repoSkillsHash(found)`), shadowed ones included. */
export function coveredSkills(found: Skill[]): Skill[] {
  return found.filter((s) => s.source === "repo");
}

export type TrustPromptProps = {
  /**
   * The repo skills waiting for approval (`resolveSkills(found, false).pendingRepo`). Kept for
   * callers; the prompt shows every repo skill in `found`, since the approval covers them all.
   */
  pending: Skill[];
  /** Every discovered skill: the approval pins `repoSkillsHash(found)`. */
  found: Skill[];
  repo: string;
  /** `$XDG_CONFIG_HOME/rewire/trusted-skills.json`. */
  trustFile: string;
  /** `true` once the approval is saved; `false` for `n`, or after a failed save is acknowledged. */
  onDone: (trusted: boolean) => void;
};

type View = { lines: string[] } | undefined;

const key = (f: { path: string; bytes: number }): string => `${f.path}\0${f.bytes}`;

/**
 * Per covered skill: the files hashed at discovery (exactly what the approval pins), then a bounded
 * live `lstat` walk of the dir that flags any difference from that list.
 */
async function viewLines(skills: Skill[]): Promise<string[]> {
  const out: string[] = [];
  for (const s of skills) {
    out.push(`${s.name}/ ${s.shadowed ? `${SHADOWED_LABEL} ` : ""}files covered by this approval:`);
    for (const f of s.files) out.push(`  ${f.path}  ${f.bytes} B`);
    try {
      const live = await listSkillFiles(s.dir);
      const pinned = new Set(s.files.map(key));
      const differs =
        live.truncated ||
        live.linkedTo !== undefined ||
        live.entries.length !== s.files.length ||
        live.entries.some((e) => e.symlink || !pinned.has(key(e)));
      if (differs) {
        out.push(
          "  ! the current files on disk differ from this list; trusting pins the list above",
        );
        for (const e of live.entries) {
          if (!pinned.has(key(e)) || e.symlink) {
            out.push(
              `    on disk: ${e.path}  ${e.symlink ? "(symlink, not followed) " : ""}${e.bytes} B`,
            );
          }
        }
        if (live.linkedTo !== undefined)
          out.push(`    the skill dir is a link to ${live.linkedTo}`);
        if (live.truncated) out.push("    … truncated");
      }
    } catch (e) {
      out.push(
        `  cannot read the current files on disk: ${(e as NodeJS.ErrnoException).code ?? String(e)}`,
      );
    }
  }
  return out;
}

/**
 * Asks once whether to trust this repo's skills: `[y]es` saves the approval (a locked
 * read-merge-write keyed by the repo's realpath, pinned to the hash of all repo skills), `[n]o`
 * keeps them pending, `[v]iew files` toggles a listing of their files.
 */
export function TrustPrompt({ found, repo, trustFile, onDone }: TrustPromptProps) {
  const cols = useColumns();
  // The approval pins every repo skill, so every one is shown, shadowed ones included.
  const covered = coveredSkills(found);
  const [view, setView] = useState<View>(undefined);
  const [error, setError] = useState<{ code: string; message: string } | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const settled = useRef(false);
  const busy = useRef(false);

  const finish = (trusted: boolean): void => {
    if (settled.current) return;
    settled.current = true;
    onDone(trusted);
  };

  useInput((input) => {
    if (settled.current || busy.current) return;
    if (error) return finish(false); // any key acknowledges the failed save
    if (input === "y") {
      busy.current = true;
      setSaving(true);
      trustRepo(trustFile, repo, repoSkillsHash(found)).then(
        () => finish(true),
        (e: unknown) => {
          busy.current = false;
          setSaving(false);
          const code = e instanceof RewireError ? e.code : "trust_store_unreadable";
          setError({ code, message: redact(e instanceof Error ? e.message : String(e)) });
        },
      );
    } else if (input === "n") finish(false);
    else if (input === "v") {
      if (view) setView(undefined);
      else {
        busy.current = true;
        viewLines(covered).then((lines) => {
          busy.current = false;
          setView({ lines });
        });
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Safe wrap="truncate" color={theme.busy}>
        {fit("This repo has skills that load only after you trust them:", cols)}
      </Safe>
      {covered.map((s) => (
        <Box key={s.name} flexDirection="column">
          <Safe wrap="truncate">{fit(`  ${s.name}: ${s.description}`, cols)}</Safe>
          {s.shadowed ? (
            <Safe wrap="truncate" color={theme.dim}>
              {fit(`    ${SHADOWED_LABEL}`, cols)}
            </Safe>
          ) : null}
        </Box>
      ))}
      {view?.lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed listing
        <Safe key={i} wrap="truncate" color={theme.dim}>
          {fit(l, cols)}
        </Safe>
      ))}
      {error ? (
        <>
          <Safe wrap="truncate" color={theme.error}>
            {fit(`${theme.glyph.toolError} ${error.code}: ${error.message}`, cols)}
          </Safe>
          <Safe wrap="truncate" color={theme.dim}>
            {fit("not trusted; the repo skills stay pending. Press any key.", cols)}
          </Safe>
        </>
      ) : (
        <Safe wrap="truncate">
          {fit(saving ? "saving…" : "Trust them? [y]es [n]o [v]iew files", cols)}
        </Safe>
      )}
    </Box>
  );
}
