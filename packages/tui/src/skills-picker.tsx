import type { Skill } from "@rewire/skills";
import { Box, useInput } from "ink";
import { type ReactNode, useEffect, useState } from "react";
import { fit, fitStart } from "./fit.js";
import { ListPicker, type ListPickerItem } from "./list-picker.js";
import { Safe } from "./safe.js";
import { theme } from "./theme.js";
import { listSkillFiles, SHADOWED_LABEL, type SkillFile } from "./trust-prompt.js";
import { useColumns } from "./use-columns.js";

/** The subset of the app's `SkillsInfo` the list needs. */
export type SkillsListInfo = { found: Skill[]; active: Skill[]; pendingRepo: Skill[] };

export const SKILLS_TITLE = "Skills";
export const REVIEW_ROW = "Review pending repo skills";
/** A skill's state as the list shows it. */
export const SKILL_STATE = {
  active: "active",
  pending: "pending trust",
  trustedLater: "trusted; takes effect in a new session (/clear)",
  shadowed: "shadowed",
  notTrusted: "not trusted",
} as const;
/** The detail view shows at most this many description lines and files. */
export const DETAIL_DESCRIPTION_ROWS = 4;
export const DETAIL_FILE_ROWS = 10;

const keyOf = (s: Skill): string => `${s.source}\0${s.dir}\0${s.name}`;

export type SkillRow = { skill: Skill; state: string; active: boolean };

/** Every found skill with its state, active ones first, then by name (then source). */
export function skillRows(info: SkillsListInfo, trustedLater: boolean): SkillRow[] {
  const active = new Set(info.active.map(keyOf));
  const pending = new Set(info.pendingRepo.map(keyOf));
  const rows = info.found.map((skill): SkillRow => {
    const k = keyOf(skill);
    if (active.has(k)) return { skill, state: SKILL_STATE.active, active: true };
    if (pending.has(k)) {
      return {
        skill,
        state: trustedLater ? SKILL_STATE.trustedLater : SKILL_STATE.pending,
        active: false,
      };
    }
    if (skill.shadowed) return { skill, state: SKILL_STATE.shadowed, active: false };
    return { skill, state: SKILL_STATE.notTrusted, active: false };
  });
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return rows.sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      cmp(a.skill.name, b.skill.name) ||
      cmp(a.skill.source, b.skill.source),
  );
}

export type SkillsPickerProps = {
  skills: SkillsListInfo;
  /** A trust was given this session: pending skills load after `/clear`. */
  trustedLater: boolean;
  /** Show the "Review pending repo skills" row (pending repo skills, no run, not yet trusted). */
  canReview: boolean;
  /** Enter on the review row. */
  onReview: () => void;
  /** Esc in the list. */
  onClose: () => void;
  /** The live file walk (default {@link listSkillFiles}). */
  listFiles?: (
    dir: string,
  ) => Promise<{ entries: SkillFile[]; truncated: boolean; linkedTo?: string }>;
  /** Keys are taken only while true (default true). */
  isActive?: boolean;
};

/**
 * `/skills`: every found skill with its source and state; Enter opens its details (description,
 * source, path, the files on disk now), Esc goes back, and Esc in the list closes. With
 * `canReview`, a first row opens the repo-skills trust prompt.
 */
export function SkillsPicker({
  skills,
  trustedLater,
  canReview,
  onReview,
  onClose,
  listFiles = listSkillFiles,
  isActive = true,
}: SkillsPickerProps) {
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState<SkillRow | undefined>(undefined);
  const rows = skillRows(skills, trustedLater);
  const review = canReview && skills.pendingRepo.length > 0;
  const items: ListPickerItem[] = [
    ...(review
      ? [{ label: REVIEW_ROW, detail: `${skills.pendingRepo.length} waiting for your trust` }]
      : []),
    ...rows.map((r) => ({ label: r.skill.name, detail: `${r.skill.source} · ${r.state}` })),
  ];
  if (detail !== undefined) {
    return (
      <SkillDetail
        row={detail}
        listFiles={listFiles}
        onBack={() => setDetail(undefined)}
        isActive={isActive}
      />
    );
  }
  return (
    <ListPicker
      title={SKILLS_TITLE}
      items={items}
      selected={selected}
      onMove={setSelected}
      onSelect={(i) => {
        if (review && i === 0) return onReview();
        const row = rows[review ? i - 1 : i];
        if (row) setDetail(row);
      }}
      onCancel={onClose}
      footer="↑/↓ move · Enter details · Esc close"
      isActive={isActive}
    />
  );
}

type Files =
  | { entries: SkillFile[]; truncated: boolean; linkedTo?: string }
  | { error: string }
  | undefined;

function SkillDetail({
  row,
  listFiles,
  onBack,
  isActive,
}: {
  row: SkillRow;
  listFiles: NonNullable<SkillsPickerProps["listFiles"]>;
  onBack: () => void;
  isActive: boolean;
}) {
  const cols = useColumns();
  const avail = Math.max(1, cols - 2); // paddingX
  const [files, setFiles] = useState<Files>(undefined);
  const { skill } = row;
  useEffect(() => {
    let live = true;
    listFiles(skill.dir).then(
      (f) => live && setFiles(f),
      (e: unknown) =>
        live && setFiles({ error: (e as NodeJS.ErrnoException)?.code ?? "cannot read" }),
    );
    return () => {
      live = false;
    };
  }, [skill.dir, listFiles]);
  useInput(
    (_input, key) => {
      if (key.escape) onBack();
    },
    { isActive },
  );

  const line = (text: string, color?: string, k?: string | number): ReactNode => (
    <Safe key={k} wrap="truncate" color={color}>
      {fit(text, avail)}
    </Safe>
  );
  const description = skill.description.split("\n").filter((l) => l.trim() !== "");
  const shownDesc = description.slice(0, DETAIL_DESCRIPTION_ROWS);
  let fileLines: ReactNode;
  if (files === undefined) fileLines = line("  reading files…", theme.dim);
  else if ("error" in files)
    fileLines = line(`  cannot read the files: ${files.error}`, theme.error);
  else {
    const shown = files.entries.slice(0, DETAIL_FILE_ROWS);
    const more = files.entries.length - shown.length;
    fileLines = (
      <>
        {files.linkedTo !== undefined ? line(`  (linked → ${files.linkedTo})`, theme.dim) : null}
        {files.entries.length === 0 ? line("  (none)", theme.dim) : null}
        {shown.map((f) =>
          line(
            `  ${f.path}  ${f.symlink ? "(symlink, not followed) " : ""}${f.bytes} B`,
            theme.dim,
            f.path,
          ),
        )}
        {more > 0 ? line(`  … ${more} more`, theme.dim) : null}
        {files.truncated ? line("  … truncated", theme.dim) : null}
      </>
    );
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <Safe bold wrap="truncate">
        {fit(skill.name, avail)}
      </Safe>
      {line(`source: ${skill.source} · ${row.state}`)}
      {skill.shadowed ? line(SHADOWED_LABEL, theme.dim) : null}
      <Safe wrap="truncate">{`path: ${fitStart(skill.dir, Math.max(1, avail - 6))}`}</Safe>
      {shownDesc.length === 0 ? line("description: (none)", theme.dim) : null}
      {shownDesc.map((l, i) => line(i === 0 ? `description: ${l}` : `  ${l}`, undefined, `d${i}`))}
      {description.length > shownDesc.length ? line("  …", theme.dim) : null}
      {line("files on disk now:")}
      {fileLines}
      {line("Esc back", theme.dim)}
    </Box>
  );
}
