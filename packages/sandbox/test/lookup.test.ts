import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, test } from "vitest";
import { findSandboxBinary, locateSandboxBinary, platformPackageName } from "../src/index.js";
import { tmp } from "./helpers.js";

const NAME = "sheperd-darwin-arm64";
const HOST = { platform: "darwin", arch: "arm64" } as const;

function exe(p: string): string {
  writeFileSync(p, "#!/bin/sh\nexit 0\n");
  chmodSync(p, 0o755);
  return p;
}

/** An install dir with node_modules/<name>/ holding a package.json and, optionally, the binary. */
function install(opts: { binary?: "exe" | "plain" | "dir" | "none"; version?: string } = {}) {
  const root = tmp("rewire-npm-");
  const pkg = join(root, "node_modules", NAME);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: NAME, version: opts.version ?? "0.1.0-beta.1", os: ["darwin"] }),
  );
  const bin = join(pkg, "rewire-sandbox");
  const kind = opts.binary ?? "exe";
  if (kind === "exe") exe(bin);
  if (kind === "plain") writeFileSync(bin, "not executable");
  if (kind === "dir") mkdirSync(bin);
  // Resolve the way the installed CLI does: from a module inside the install.
  const resolvePackage = createRequire(join(root, "cli.js")).resolve;
  return { root, bin, resolvePackage };
}

function onPath(): { dir: string; bin: string } {
  const dir = tmp("rewire-path-");
  return { dir, bin: exe(join(dir, "rewire-sandbox")) };
}

test("platformPackageName maps the four supported hosts and nothing else", () => {
  expect(platformPackageName("darwin", "arm64")).toBe("sheperd-darwin-arm64");
  expect(platformPackageName("darwin", "x64")).toBe("sheperd-darwin-x64");
  expect(platformPackageName("linux", "x64")).toBe("sheperd-linux-x64");
  expect(platformPackageName("linux", "arm64")).toBe("sheperd-linux-arm64");
  expect(platformPackageName("win32", "x64")).toBeUndefined();
  expect(platformPackageName("linux", "ia32")).toBeUndefined();
});

test("the installed platform package's binary is used after the checkout and before PATH", () => {
  const { bin, resolvePackage } = install();
  const path = onPath();
  const found = locateSandboxBinary({
    env: { PATH: path.dir },
    sourceRoot: null,
    resolvePackage,
    ...HOST,
  });
  expect(found).toEqual({ path: bin, source: "platform-package", detail: NAME });
  expect(
    findSandboxBinary({ env: { PATH: path.dir }, sourceRoot: null, resolvePackage, ...HOST }),
  ).toBe(bin);
});

test("REWIRE_SANDBOX_BIN and the checkout both win over the platform package", () => {
  const { resolvePackage } = install();
  const override = exe(join(tmp(), "rewire-sandbox"));
  expect(
    locateSandboxBinary({
      env: { REWIRE_SANDBOX_BIN: override },
      sourceRoot: null,
      resolvePackage,
      ...HOST,
    }),
  ).toMatchObject({ path: override, source: "env" });

  const root = tmp("rewire-src-");
  mkdirSync(join(root, "target", "release"), { recursive: true });
  const built = exe(join(root, "target", "release", "rewire-sandbox"));
  expect(locateSandboxBinary({ env: {}, sourceRoot: root, resolvePackage, ...HOST })).toMatchObject(
    { path: built, source: "checkout" },
  );
});

test("no platform package installed falls through to PATH", () => {
  const path = onPath();
  const resolvePackage = createRequire(join(tmp("rewire-empty-"), "cli.js")).resolve;
  expect(
    locateSandboxBinary({ env: { PATH: path.dir }, sourceRoot: null, resolvePackage, ...HOST }),
  ).toEqual({ path: path.bin, source: "path" });
});

test("an unsupported host skips the platform package lookup", () => {
  const { resolvePackage } = install();
  expect(() =>
    locateSandboxBinary({
      env: {},
      sourceRoot: null,
      resolvePackage,
      platform: "win32",
      arch: "x64",
    }),
  ).toThrow(expect.objectContaining({ code: "binary_missing" }));
});

// Fail closed (#22): an installed package without a usable binary is an error, never a silent
// fall-through to whatever happens to be on PATH.
test.each([
  ["missing", "none"],
  ["not executable", "plain"],
  ["a directory", "dir"],
] as const)("an installed platform package whose binary is %s fails closed", (_why, binary) => {
  const { resolvePackage } = install({ binary });
  const path = onPath();
  expect(() =>
    locateSandboxBinary({ env: { PATH: path.dir }, sourceRoot: null, resolvePackage, ...HOST }),
  ).toThrow(
    expect.objectContaining({
      code: "binary_missing",
      message: expect.stringContaining(NAME),
    }),
  );
});

test("a platform package whose version differs from the CLI's fails closed", () => {
  const { resolvePackage } = install({ version: "0.0.9" });
  expect(() =>
    locateSandboxBinary({
      env: {},
      sourceRoot: null,
      resolvePackage,
      expectedVersion: "0.1.0-beta.1",
      ...HOST,
    }),
  ).toThrow(
    expect.objectContaining({
      code: "binary_missing",
      message: expect.stringMatching(/0\.0\.9.*0\.1\.0-beta\.1/),
    }),
  );
  expect(
    locateSandboxBinary({
      env: {},
      sourceRoot: null,
      resolvePackage,
      expectedVersion: "0.0.9",
      ...HOST,
    }).source,
  ).toBe("platform-package");
});

test("nothing found anywhere is the preflight binary_missing error, naming every place", () => {
  const resolvePackage = createRequire(join(tmp("rewire-empty-"), "cli.js")).resolve;
  expect(() =>
    locateSandboxBinary({ env: { PATH: "" }, sourceRoot: null, resolvePackage, ...HOST }),
  ).toThrow(
    expect.objectContaining({
      code: "binary_missing",
      message: "rewire-sandbox binary not found",
      hint: expect.stringContaining("sheperd-darwin-arm64"),
    }),
  );
});
