import { BINARY_ASSET_EXTS } from "@rewire/reviewers";
import { trustedGitOk } from "@rewire/sandbox";

/** Bytes git sniffs for a NUL to call content binary. */
const SNIFF = 8000;

const assetSpecs = (mode: "" | "exclude,"): string[] =>
  BINARY_ASSET_EXTS.map((e) => `:(${mode}icase,glob)**/*.${e}`);

/**
 * The staged change against the frozen-tests commit for the commit checkpoint, hardened like the
 * reviewers' diff: attributes from the frozen commit only (never the worktree or the user's global
 * file), no external diff or textconv driver, text forced. Asset-extension files follow the
 * reviewers' R21b rule: a staged blob with no NUL in its first 8000 bytes is diffed as text; real
 * binary content (and a deleted asset) is never dumped but named on a `binary file omitted:` line,
 * so every changed path appears in the payload.
 */
export async function commitDiff(
  worktree: string,
  frozenCommit: string,
  sig: { signal?: AbortSignal },
): Promise<string> {
  const attr = [
    `--attr-source=${frozenCommit}`,
    "-c",
    "core.quotepath=off",
    "-c",
    "core.attributesFile=/dev/null",
  ];
  const textDiff = (paths: string[]): Promise<string> =>
    trustedGitOk(
      worktree,
      [
        ...attr,
        "diff",
        "--cached",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--text",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        frozenCommit,
        "--",
        ...paths,
      ],
      sig,
    );
  let diff = await textDiff([".", ...assetSpecs("exclude,")]);
  // `--raw -z`: ":<modes> <shas> <status>\0<path>\0" per changed asset.
  const raw = (
    await trustedGitOk(
      worktree,
      [
        ...attr,
        "diff",
        "--cached",
        "--raw",
        "-z",
        "--no-abbrev",
        "--no-renames",
        frozenCommit,
        "--",
        ...assetSpecs(""),
      ],
      sig,
    )
  ).split("\0");
  const textAssets: string[] = [];
  const omitted: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const status = raw[i]?.split(" ").at(-1) ?? "";
    const path = raw[i + 1] ?? "";
    if (path === "") continue;
    if (status.startsWith("D")) {
      omitted.push(`binary file omitted: ${path} (deleted)`);
      continue;
    }
    const blob = await trustedGitOk(worktree, ["cat-file", "blob", `:0:${path}`], sig);
    if (blob.slice(0, SNIFF).includes("\0")) omitted.push(`binary file omitted: ${path}`);
    else textAssets.push(path);
  }
  if (textAssets.length > 0) diff += await textDiff(textAssets.map((p) => `:(literal)${p}`));
  if (omitted.length > 0)
    diff += `${diff === "" || diff.endsWith("\n") ? "" : "\n"}${omitted.join("\n")}\n`;
  return diff;
}
