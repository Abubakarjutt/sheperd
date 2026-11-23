import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RewireError } from "@rewire/core";

export type TsPack = {
  packageManager: "npm" | "pnpm" | "yarn";
  testRunner: "vitest" | "jest";
  testCommand: string[];
  /**
   * Extra args that make the runner write JSON results to a file. The literal
   * `<path>` placeholder is NOT substituted here; the caller (a later task)
   * replaces it with the real output path.
   */
  testJsonArgs: string[];
  lintCommand: string[] | null;
  /** Absolute path to tsconfig.json. */
  tsconfig: string;
};

type PM = TsPack["packageManager"];
type Runner = TsPack["testRunner"];

const LOCKFILES: ReadonlyArray<[string, PM]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/**
 * Root-level linter config files the pack detects. Single list: the lint gate's baseRef
 * detection uses it too, and every name is a protected config file (gates config-patterns test).
 */
export const BIOME_CONFIGS: readonly string[] = ["biome.json", "biome.jsonc"];
export const ESLINT_CONFIGS: readonly string[] = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.mjs",
  ".eslintrc.json",
  ".eslintrc.yaml",
  ".eslintrc.yml",
];

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

type PkgJson = {
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};

async function readPackageJson(root: string): Promise<PkgJson> {
  const file = join(root, "package.json");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new RewireError("pack_undetected", `no package.json found at ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new RewireError(
      "pack_undetected",
      `${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RewireError("pack_undetected", `${file} is not valid JSON: expected an object`);
  }
  return parsed as PkgJson;
}

async function detectPackageManager(root: string, pkg: PkgJson): Promise<PM> {
  const found: Array<[string, PM]> = [];
  for (const [file, pm] of LOCKFILES) {
    if (await exists(join(root, file))) found.push([file, pm]);
  }
  if (found.length > 1) {
    throw new RewireError(
      "pack_ambiguous",
      `multiple lockfiles found (${found.map(([f]) => f).join(", ")}); cannot pick a package manager`,
      "delete the stale lockfiles so exactly one remains",
    );
  }
  if (found[0]) return found[0][1];
  if (typeof pkg.packageManager === "string") {
    const name = pkg.packageManager.split("@")[0];
    if (name === "pnpm" || name === "yarn" || name === "npm") return name;
  }
  return "npm";
}

function checkDepField(pkg: PkgJson, field: "dependencies" | "devDependencies"): void {
  const v = pkg[field];
  if (v !== undefined && (typeof v !== "object" || v === null || Array.isArray(v))) {
    throw new RewireError("pack_undetected", `package.json "${field}" must be an object`);
  }
}

function detectRunner(pkg: PkgJson): Runner {
  checkDepField(pkg, "dependencies");
  checkDepField(pkg, "devDependencies");
  const has = (n: string) =>
    (pkg.dependencies !== undefined && n in pkg.dependencies) ||
    (pkg.devDependencies !== undefined && n in pkg.devDependencies);
  const vitest = has("vitest");
  const jest = has("jest");
  if (vitest && jest) {
    const script = pkg.scripts?.test;
    const text = typeof script === "string" ? script : "";
    const v = /\bvitest\b/.test(text);
    const j = /\bjest\b/.test(text);
    if (v !== j) return v ? "vitest" : "jest";
    throw new RewireError(
      "pack_ambiguous",
      "both vitest and jest are installed and the test script does not name exactly one of them",
      'make the "test" script name the runner to use',
    );
  }
  if (vitest) return "vitest";
  if (jest) return "jest";
  throw new RewireError(
    "pack_undetected",
    "no test runner found: neither vitest nor jest is in dependencies or devDependencies",
  );
}

function execPrefix(pm: PM): string[] {
  return pm === "yarn" ? ["yarn"] : [pm, "exec"];
}

async function anyExists(root: string, names: readonly string[]): Promise<boolean> {
  for (const n of names) if (await exists(join(root, n))) return true;
  return false;
}

export async function detectTsPack(root: string): Promise<TsPack> {
  root = resolve(root);
  const pkg = await readPackageJson(root);
  const tsconfig = join(root, "tsconfig.json");
  if (!(await exists(tsconfig))) {
    throw new RewireError("pack_undetected", `no tsconfig.json found at ${tsconfig}`);
  }
  const packageManager = await detectPackageManager(root, pkg);
  const testRunner = detectRunner(pkg);

  const prefix = execPrefix(packageManager);
  const testCommand = testRunner === "vitest" ? [...prefix, "vitest", "run"] : [...prefix, "jest"];
  const testJsonArgs =
    testRunner === "vitest"
      ? ["--reporter=json", "--outputFile=<path>"]
      : ["--json", "--outputFile=<path>"];

  let lintCommand: string[] | null = null;
  if (pkg.scripts && typeof pkg.scripts.lint === "string") {
    lintCommand = [packageManager, "run", "lint"];
  } else if (await anyExists(root, BIOME_CONFIGS)) {
    lintCommand = ["npx", "biome", "check", "."];
  } else {
    for (const c of ESLINT_CONFIGS) {
      if (await exists(join(root, c))) {
        lintCommand = ["npx", "eslint", "."];
        break;
      }
    }
  }

  return { packageManager, testRunner, testCommand, testJsonArgs, lintCommand, tsconfig };
}
