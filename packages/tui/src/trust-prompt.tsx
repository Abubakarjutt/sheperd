import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { RewireError, redact } from "@rewire/core";
import { repoSkillsHash, type Skill, trustRepo } from "@rewire/skills";
import { Box, useInput } from "ink";
import { useRef, useState } from "react";
import { fit } from "./fit.js";
import { Safe } from "./safe.js";
import { theme } from "./theme.js";
import { useColumns } from "./use-columns.js";

/** At most this many entries per skill in `[v]iew files`. */
export const VIEW_FILES_CAP = 200;

export type SkillFile = { path: string; bytes: number; symlink?: boolean };

/**
 * The files under a skill dir, read on the host with `lstat`: a symlink is listed as one (its own
 * size) and never followed, and directories are walked without following links. Paths are relative
 * to `dir`, sorted, and cut at `cap` (then `truncated` is true). Names are NOT sanitized here.
 */
export async function listSkillFiles(
  dir: string,
  cap: number = VIEW_FILES_CAP,
): Promise<{ entries: SkillFile[]; truncated: boolean }> {
  const entries: SkillFile[] = [];
  let truncated = false;
  const walk = async (d: string): Promise<void> => {
    const names = (await readdir(d)).sort();
    for (const name of names) {
      if (entries.length >= cap) {
        truncated = true;
        return;
      }
      const p = join(d, name);
      const st = await lstat(p);
      if (st.isDirectory()) await walk(p);
      else
        entries.push({
          path: relative(dir, p),
          bytes: st.size,
          ...(st.isSymbolicLink() ? { symlink: true } : {}),
        });
    }
  };
  await walk(dir);
  return { entries, truncated };
}

export type TrustPromptProps = {
  /** The repo skills waiting for approval (`resolveSkills(found, false).pendingRepo`). */
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

async function viewLines(skills: Skill[]): Promise<string[]> {
  const out: string[] = [];
  for (const s of skills) {
    out.push(`${s.name}/`);
    try {
      const { entries, truncated } = await listSkillFiles(s.dir);
      for (const e of entries) {
        out.push(`  ${e.path}  ${e.symlink ? "(symlink, not followed) " : ""}${e.bytes} B`);
      }
      if (truncated) out.push(`  … more than ${VIEW_FILES_CAP} files, list cut`);
    } catch (e) {
      out.push(`  cannot list: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
    }
  }
  return out;
}

/**
 * Asks once whether to trust this repo's skills: `[y]es` saves the approval (a locked
 * read-merge-write keyed by the repo's realpath, pinned to the hash of all repo skills), `[n]o`
 * keeps them pending, `[v]iew files` toggles a listing of their files.
 */
export function TrustPrompt({ pending, found, repo, trustFile, onDone }: TrustPromptProps) {
  const cols = useColumns();
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
        viewLines(pending).then((lines) => {
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
      {pending.map((s) => (
        <Safe key={s.name} wrap="truncate">
          {fit(`  ${s.name}: ${s.description}`, cols)}
        </Safe>
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
