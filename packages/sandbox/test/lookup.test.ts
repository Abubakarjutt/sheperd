import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { findSandboxBinary, locateSandboxBinary, platformPackageName } from "../src/index.js";
import { tmp } from "./helpers.js";

const NAME = "sheperd-darwin-arm64";
const HOST = { platform: "darwin", arch: "arm64" } as const;
const BINARY = "#!/bin/sh\nexit 0\n";
const SHA = createHash("sha256").update(BINARY).digest("hex");

function exe(p: string, body = BINARY): string {
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

type Install = {
  binary?: "exe" | "plain" | "dir" | "none";
  version?: string;
  manifest?: boolean;
  /** nested: <sheperd>/node_modules/<name>; sibling: <node_modules>/sheperd + <node_modules>/<name>. */
  layout?: "nested" | "sibling";
};

/** An installed sheperd (its package root) with this host's platform package next to it. */
function install(opts: Install = {}) {
  const top = tmp("rewire-npm-");
  const modules = join(top, "node_modules");
  const packageRoot = join(modules, "sheperd");
  mkdirSync(packageRoot, { recursive: true });
  const pkg =
    (opts.layout ?? "nested") === "nested"
      ? join(packageRoot, "node_modules", NAME)
      : join(modules, NAME);
  mkdirSync(pkg, { recursive: true });
  if (opts.manifest !== false) {
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: NAME, version: opts.version ?? "0.1.0-beta.1", os: ["darwin"] }),
    );
  }
  const bin = join(pkg, "rewire-sandbox");
  const kind = opts.binary ?? "exe";
  if (kind === "exe") exe(bin);
  if (kind === "plain") writeFileSync(bin, "not executable");
  if (kind === "dir") mkdirSync(bin);
  return { top, packageRoot, bin };
}

function onPath(): { dir: string; bin: string } {
  const dir = tmp("rewire-path-");
  return { dir, bin: exe(join(dir, "rewire-sandbox")) };
}

const base = (packageRoot: string) => ({
  sourceRoot: null,
  packageRoot,
  expectedSha256: { "darwin-arm64": SHA },
  ...HOST,
});

test("platformPackageName maps the four supported hosts and nothing else", () => {
  expect(platformPackageName("darwin", "arm64")).toBe("sheperd-darwin-arm64");
  expect(platformPackageName("darwin", "x64")).toBe("sheperd-darwin-x64");
  expect(platformPackageName("linux", "x64")).toBe("sheperd-linux-x64");
  expect(platformPackageName("linux", "arm64")).toBe("sheperd-linux-arm64");
  expect(platformPackageName("win32", "x64")).toBeUndefined();
  expect(platformPackageName("linux", "ia32")).toBeUndefined();
});

test.each(["nested", "sibling"] as const)(
  "the %s platform package's binary is used after the checkout and before PATH",
  (layout) => {
    const { packageRoot, bin } = install({ layout });
    const path = onPath();
    const opts = { env: { PATH: path.dir }, ...base(packageRoot) };
    expect(locateSandboxBinary(opts)).toEqual({
      path: bin,
      source: "platform-package",
      detail: NAME,
    });
    expect(findSandboxBinary(opts)).toBe(bin);
  },
);

test("REWIRE_SANDBOX_BIN and the checkout both win over the platform package", () => {
  const { packageRoot } = install();
  const override = exe(join(tmp(), "rewire-sandbox"));
  expect(
    locateSandboxBinary({ env: { REWIRE_SANDBOX_BIN: override }, ...base(packageRoot) }),
  ).toMatchObject({ path: override, source: "env" });

  const root = tmp("rewire-src-");
  mkdirSync(join(root, "target", "release"), { recursive: true });
  const built = exe(join(root, "target", "release", "rewire-sandbox"), "different bytes");
  expect(locateSandboxBinary({ env: {}, ...base(packageRoot), sourceRoot: root })).toMatchObject({
    path: built,
    source: "checkout",
  });
});

test("no platform package installed falls through to PATH", () => {
  const path = onPath();
  const packageRoot = join(tmp("rewire-empty-"), "node_modules", "sheperd");
  mkdirSync(packageRoot, { recursive: true });
  expect(locateSandboxBinary({ env: { PATH: path.dir }, ...base(packageRoot) })).toEqual({
    path: path.bin,
    source: "path",
  });
});

// Only the installed sheperd's own node_modules and its hoisted siblings count: NODE_PATH,
// ~/.node_modules and ancestor node_modules directories are never searched.
test("a platform package elsewhere up the tree is not used", () => {
  const top = tmp("rewire-npm-");
  const packageRoot = join(top, "app", "node_modules", "sheperd");
  mkdirSync(packageRoot, { recursive: true });
  const far = join(top, "node_modules", NAME);
  mkdirSync(far, { recursive: true });
  writeFileSync(join(far, "package.json"), JSON.stringify({ name: NAME, version: "0.1.0-beta.1" }));
  exe(join(far, "rewire-sandbox"));
  expect(() => locateSandboxBinary({ env: { PATH: "" }, ...base(packageRoot) })).toThrow(
    expect.objectContaining({ message: "rewire-sandbox binary not found" }),
  );
});

test("an unsupported host skips the platform package lookup", () => {
  const { packageRoot } = install();
  expect(() =>
    locateSandboxBinary({ env: {}, ...base(packageRoot), platform: "win32", arch: "x64" }),
  ).toThrow(expect.objectContaining({ code: "binary_missing" }));
});

// Fail closed (#22): an installed package without a usable binary is an error, never a silent
// fall-through to whatever happens to be on PATH.
test.each([
  ["has a missing binary", { binary: "none" }],
  ["has a binary that is not executable", { binary: "plain" }],
  ["has a directory for a binary", { binary: "dir" }],
  ["has no package.json", { manifest: false }],
] as const)("an installed platform package that %s fails closed", (_why, opts) => {
  const { packageRoot } = install(opts);
  const path = onPath();
  expect(() => locateSandboxBinary({ env: { PATH: path.dir }, ...base(packageRoot) })).toThrow(
    expect.objectContaining({ code: "binary_missing", message: expect.stringContaining(NAME) }),
  );
});

test("a platform package whose version differs from the CLI's fails closed", () => {
  const { packageRoot } = install({ version: "0.0.9" });
  const opts = { env: {}, ...base(packageRoot) };
  expect(() => locateSandboxBinary({ ...opts, expectedVersion: "0.1.0-beta.1" })).toThrow(
    expect.objectContaining({
      code: "binary_missing",
      message: expect.stringMatching(/0\.0\.9.*0\.1\.0-beta\.1/),
    }),
  );
  expect(locateSandboxBinary({ ...opts, expectedVersion: "0.0.9" }).source).toBe(
    "platform-package",
  );
});

// A substituted or hijacked platform package (same name and version, other bytes) is refused:
// the bundle records each binary's sha256 at build time.
test("a platform binary whose sha256 differs from the recorded one fails closed", () => {
  const { packageRoot, bin } = install();
  exe(bin, "#!/bin/sh\necho evil\n");
  const path = onPath();
  expect(() => locateSandboxBinary({ env: { PATH: path.dir }, ...base(packageRoot) })).toThrow(
    expect.objectContaining({
      code: "binary_missing",
      message: expect.stringContaining(`sha256 does not match`),
    }),
  );
});

test("with recorded hashes, a host without one fails closed instead of trusting the binary", () => {
  const { packageRoot } = install();
  expect(() =>
    locateSandboxBinary({
      env: {},
      ...base(packageRoot),
      expectedSha256: { "linux-x64": SHA },
    }),
  ).toThrow(expect.objectContaining({ message: expect.stringContaining("no recorded sha256") }));
});

test("without recorded hashes (running from source) the hash is not checked", () => {
  const { packageRoot, bin } = install();
  exe(bin, "other bytes");
  expect(
    locateSandboxBinary({ env: {}, ...base(packageRoot), expectedSha256: undefined }).path,
  ).toBe(bin);
});

test("nothing found anywhere is the preflight binary_missing error, naming every place", () => {
  const packageRoot = join(tmp("rewire-empty-"), "node_modules", "sheperd");
  mkdirSync(packageRoot, { recursive: true });
  expect(() => locateSandboxBinary({ env: { PATH: "" }, ...base(packageRoot) })).toThrow(
    expect.objectContaining({
      code: "binary_missing",
      message: "rewire-sandbox binary not found",
      hint: expect.stringContaining("sheperd-darwin-arm64"),
    }),
  );
});
