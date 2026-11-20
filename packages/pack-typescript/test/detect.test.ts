import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { RewireError } from "@rewire/core";
import { describe, expect, test } from "vitest";
import { detectTsPack } from "../src/index.js";

function fixture(files: Record<string, string | object>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rewire-pack-")));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(
      join(root, name),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  return root;
}

const pkg = (extra: object = {}) => ({ name: "x", ...extra });

async function code(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RewireError) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("expected rejection");
}

describe("detectTsPack", () => {
  test("detects pnpm + vitest + lint script", async () => {
    const root = fixture({
      "package.json": pkg({ devDependencies: { vitest: "1" }, scripts: { lint: "biome check ." } }),
      "pnpm-lock.yaml": "",
      "tsconfig.json": "{}",
    });
    const p = await detectTsPack(root);
    expect(p).toEqual({
      packageManager: "pnpm",
      testRunner: "vitest",
      testCommand: ["pnpm", "exec", "vitest", "run"],
      testJsonArgs: ["--reporter=json", "--outputFile=<path>"],
      lintCommand: ["pnpm", "run", "lint"],
      tsconfig: join(root, "tsconfig.json"),
    });
  });

  test("jest with npm and eslint config", async () => {
    const root = fixture({
      "package.json": pkg({ dependencies: { jest: "1" } }),
      "package-lock.json": "{}",
      "tsconfig.json": "{}",
      "eslint.config.mjs": "",
    });
    const p = await detectTsPack(root);
    expect(p.packageManager).toBe("npm");
    expect(p.testCommand).toEqual(["npm", "exec", "jest"]);
    expect(p.testJsonArgs).toEqual(["--json", "--outputFile=<path>"]);
    expect(p.lintCommand).toEqual(["npx", "eslint", "."]);
  });

  test("yarn uses yarn <runner>", async () => {
    const root = fixture({
      "package.json": pkg({ devDependencies: { vitest: "1" } }),
      "yarn.lock": "",
      "tsconfig.json": "{}",
    });
    const p = await detectTsPack(root);
    expect(p.testCommand).toEqual(["yarn", "vitest", "run"]);
  });

  test("biome.json fallback and .eslintrc detection", async () => {
    const base = {
      "package.json": pkg({ devDependencies: { vitest: "1" } }),
      "tsconfig.json": "{}",
    };
    expect((await detectTsPack(fixture({ ...base, "biome.json": "{}" }))).lintCommand).toEqual([
      "npx",
      "biome",
      "check",
      ".",
    ]);
    expect((await detectTsPack(fixture({ ...base, ".eslintrc.json": "{}" }))).lintCommand).toEqual([
      "npx",
      "eslint",
      ".",
    ]);
    expect((await detectTsPack(fixture(base))).lintCommand).toBeNull();
  });

  test("no lockfile: packageManager field, else npm", async () => {
    const mk = (extra: object) =>
      fixture({
        "package.json": pkg({ devDependencies: { vitest: "1" }, ...extra }),
        "tsconfig.json": "{}",
      });
    expect((await detectTsPack(mk({ packageManager: "pnpm@9.0.0" }))).packageManager).toBe("pnpm");
    expect((await detectTsPack(mk({}))).packageManager).toBe("npm");
  });

  test("multiple lockfiles → pack_ambiguous", async () => {
    const root = fixture({
      "package.json": pkg({ devDependencies: { vitest: "1" } }),
      "pnpm-lock.yaml": "",
      "yarn.lock": "",
      "tsconfig.json": "{}",
    });
    const e = await code(detectTsPack(root));
    expect(e.code).toBe("pack_ambiguous");
    expect(e.message).toMatch(/pnpm-lock\.yaml.*yarn\.lock/);
  });

  test("both runners: test script decides, otherwise ambiguous", async () => {
    const both = { vitest: "1", jest: "1" };
    const mk = (scripts: object) =>
      fixture({ "package.json": pkg({ devDependencies: both, scripts }), "tsconfig.json": "{}" });
    expect((await detectTsPack(mk({ test: "jest --ci" }))).testRunner).toBe("jest");
    expect((await detectTsPack(mk({ test: "vitest run" }))).testRunner).toBe("vitest");
    expect((await code(detectTsPack(mk({ test: "node t.js" })))).code).toBe("pack_ambiguous");
    expect((await code(detectTsPack(mk({})))).code).toBe("pack_ambiguous");
  });

  test("no test runner → pack_undetected", async () => {
    const root = fixture({ "package.json": pkg(), "tsconfig.json": "{}" });
    const e = await code(detectTsPack(root));
    expect(e.code).toBe("pack_undetected");
    expect(e.message).toMatch(/test runner/);
  });

  test("missing package.json / tsconfig.json name the missing file", async () => {
    const a = await code(detectTsPack(fixture({ "tsconfig.json": "{}" })));
    expect(a).toMatchObject({ code: "pack_undetected" });
    expect(a.message).toMatch(/package\.json/);
    const b = await code(
      detectTsPack(fixture({ "package.json": pkg({ devDependencies: { vitest: "1" } }) })),
    );
    expect(b.code).toBe("pack_undetected");
    expect(b.message).toMatch(/tsconfig\.json/);
  });

  test("unparseable package.json names the file and the parse error", async () => {
    const root = fixture({ "package.json": "{ not json", "tsconfig.json": "{}" });
    const e = await code(detectTsPack(root));
    expect(e.code).toBe("pack_undetected");
    expect(e.message).toContain(join(root, "package.json"));
    expect(e.message).toMatch(/not valid JSON: .+/);
  });

  test("null or non-object dependencies → pack_undetected naming the field", async () => {
    for (const field of ["dependencies", "devDependencies"]) {
      for (const bad of [null, "x", 5, []]) {
        const root = fixture({ "package.json": pkg({ [field]: bad }), "tsconfig.json": "{}" });
        const e = await code(detectTsPack(root));
        expect(e.code).toBe("pack_undetected");
        expect(e.message).toContain(field);
      }
    }
  });

  test("relative root still yields an absolute tsconfig", async () => {
    const root = fixture({
      "package.json": pkg({ devDependencies: { vitest: "1" } }),
      "tsconfig.json": "{}",
    });
    const p = await detectTsPack(relative(process.cwd(), root));
    expect(p.tsconfig).toBe(join(root, "tsconfig.json"));
  });
});
