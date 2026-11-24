import { RewireError, stripControls } from "@rewire/core";

/** `name` must match this (global constraint). */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_DESCRIPTION_CHARS = 1024;

export type ParsedSkillMd = {
  name: string | undefined;
  description: string | undefined;
  /** `disable-model-invocation: true` (or True/TRUE/yes) sets this to false. */
  modelInvocable: boolean;
  body: string;
};

const invalid = (message: string) => new RewireError("skill_invalid", message);

const KEY_NAME_RE = /^[A-Za-z0-9_-]+$/;
const BLOCK_RE = /^([|>])[-+]?[1-9]?\s*(?:#.*)?$/;

/**
 * Read a SKILL.md: a leading `---` frontmatter block, then the markdown body. Only the keys
 * `name`, `description` and `disable-model-invocation` are read; every other key, including list
 * and map values, is skipped. Scalars may be plain, single- or double-quoted, or `|` / `>` block
 * scalars. Deliberately minimal: no YAML dependency.
 */
export function parseSkillMd(text: string): ParsedSkillMd {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") throw invalid("SKILL.md has no frontmatter block");
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (end < 0) throw invalid("SKILL.md frontmatter is not closed");
  const fm = lines.slice(1, end);
  const body = lines.slice(end + 1).join("\n");

  const values = new Map<string, string>();
  let i = 0;
  while (i < fm.length) {
    const line = fm[i] ?? "";
    i++;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    // Indented lines belong to a key we skipped (list items, nested maps).
    if (/^\s/.test(line) || line.startsWith("- ")) continue;
    // Split on the first ':' by hand: a regex here backtracked quadratically on hostile lines.
    const colon = line.indexOf(":");
    const key = colon > 0 ? line.slice(0, colon) : "";
    const rest = line.slice(colon + 1);
    if (!KEY_NAME_RE.test(key) || (rest !== "" && rest[0] !== " " && rest[0] !== "\t")) {
      throw invalid("SKILL.md frontmatter has a line that is not `key: value`");
    }
    const raw = rest.trim();
    const block = BLOCK_RE.exec(raw);
    let value: string | undefined;
    if (block) {
      const cont: string[] = [];
      while (i < fm.length && (/^\s/.test(fm[i] ?? "") || (fm[i] ?? "").trim() === "")) {
        cont.push(fm[i] ?? "");
        i++;
      }
      value = blockScalar(cont, block[1] === ">");
    } else if (raw === "") {
      value = undefined; // a list or map follows; skipped by the indented-line rule
    } else if (/^["']/.test(raw)) {
      value = scalar(raw);
    } else {
      // A plain scalar may continue on more-indented lines; they fold into one line.
      const parts = [scalar(raw)];
      while (i < fm.length && /^\s+\S/.test(fm[i] ?? "")) {
        parts.push(scalar((fm[i] ?? "").trim()));
        i++;
      }
      value = parts.join(" ");
    }
    if (value === undefined) continue;
    if (values.has(key) && TRACKED.has(key)) throw invalid(`SKILL.md repeats the key ${key}`);
    values.set(key, value);
  }

  return {
    name: values.get("name"),
    description: values.get("description"),
    modelInvocable: !/^(?:true|yes)$/i.test(values.get("disable-model-invocation") ?? ""),
    body,
  };
}

const TRACKED = new Set(["name", "description", "disable-model-invocation"]);

function scalar(raw: string): string {
  if (raw.startsWith('"')) return doubleQuoted(raw);
  if (raw.startsWith("'")) return singleQuoted(raw);
  // Plain scalar: a ` #` starts a comment.
  const hash = raw.search(/\s#/);
  return (hash < 0 ? raw : raw.slice(0, hash)).trim();
}

function singleQuoted(raw: string): string {
  let out = "";
  for (let i = 1; i < raw.length; i++) {
    const c = raw[i];
    if (c === "'") {
      if (raw[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      return out;
    }
    out += c;
  }
  throw invalid("SKILL.md frontmatter has an unterminated single-quoted value");
}

const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  n: "\n",
  t: "\t",
  r: "\r",
  "0": "\0",
};

function doubleQuoted(raw: string): string {
  let out = "";
  for (let i = 1; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') return out;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = raw[i + 1] ?? "";
    if (e === "u" && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 2, i + 6))) {
      out += String.fromCharCode(Number.parseInt(raw.slice(i + 2, i + 6), 16));
      i += 5;
    } else if (e in ESCAPES) {
      out += ESCAPES[e];
      i++;
    } else {
      throw invalid("SKILL.md frontmatter has an unsupported escape in a double-quoted value");
    }
  }
  throw invalid("SKILL.md frontmatter has an unterminated double-quoted value");
}

/** `|` keeps newlines; `>` folds single newlines to spaces (blank lines become newlines). */
function blockScalar(lines: string[], fold: boolean): string {
  const indents = lines.filter((l) => l.trim() !== "").map((l) => /^\s*/.exec(l)?.[0].length ?? 0);
  const indent = indents.length ? Math.min(...indents) : 0;
  const stripped = lines.map((l) => (l.trim() === "" ? "" : l.slice(indent).trimEnd()));
  if (!fold) return stripped.join("\n").trim();
  const paras: string[] = [];
  let cur: string[] = [];
  for (const l of stripped) {
    if (l === "") {
      if (cur.length) paras.push(cur.join(" "));
      cur = [];
    } else cur.push(l);
  }
  if (cur.length) paras.push(cur.join(" "));
  return paras.join("\n").trim();
}

/**
 * Validate the parsed frontmatter. A missing `name` falls back to `fallbackName` (the skill's
 * directory name), as Claude Code does; the result must still match `SKILL_NAME_RE`, which also
 * excludes control characters. The description is stripped of ANSI sequences and C0/C1 control
 * characters and its whitespace (newlines included) collapses to single spaces: it goes into the
 * model's skill index and onto one terminal line.
 */
export function validateSkillMd(
  parsed: ParsedSkillMd,
  fallbackName: string,
): { name: string; description: string } {
  const name = parsed.name ?? fallbackName;
  if (!SKILL_NAME_RE.test(name)) {
    throw invalid(`skill name must match ${SKILL_NAME_RE.source}`);
  }
  const description = stripControls(parsed.description ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (description.length < 1) throw invalid("SKILL.md frontmatter has no description");
  if (description.length > MAX_DESCRIPTION_CHARS) {
    throw invalid(`skill description is longer than ${MAX_DESCRIPTION_CHARS} characters`);
  }
  return { name, description };
}
