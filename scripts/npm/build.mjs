#!/usr/bin/env node
// Assembles and checks the npm packages (docs/RELEASING.md). Nothing here publishes.
//
//   node scripts/npm/build.mjs sandbox
//       cargo build --release of rewire-sandbox into target/npm/, with local paths remapped so
//       the binary does not embed the build machine's home or checkout path.
//   node scripts/npm/build.mjs sheperd  [--out dir]
//       Bundles packages/cli/dist/main.js (run `pnpm -r build` first) into <out>/sheperd/.
//   node scripts/npm/build.mjs platform [--target <os>-<arch>] [--binary <path>] [--out dir]
//       Stages the prebuilt rewire-sandbox (default: the `sandbox` output) as
//       <out>/sheperd-<os>-<arch>/. The target defaults to this host; the binary's own header
//       must match it.
//   node scripts/npm/build.mjs pack     [--out dir]
//       Checks every staged package's `npm pack --dry-run` file list and contents, then packs
//       each into <out>/tarballs/.
//
// <out> defaults to dist-npm/ in the repository root.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = join(ROOT, "npm", "sheperd", "package.json");
const ENTRY = join(ROOT, "packages", "cli", "dist", "main.js");
const SANDBOX_TARGET_DIR = join(ROOT, "target", "npm");
const SANDBOX_BINARY = join(SANDBOX_TARGET_DIR, "release", "rewire-sandbox");
/** The prebuilt targets, with the ELF / Mach-O machine each binary must declare. */
const TARGETS = {
  "darwin-arm64": { format: "macho", machine: 0x0100000c },
  "darwin-x64": { format: "macho", machine: 0x01000007 },
  "linux-arm64": { format: "elf", machine: 183 },
  "linux-x64": { format: "elf", machine: 62 },
};

const fail = (msg) => {
  process.stderr.write(`build.mjs: ${msg}\n`);
  process.exit(1);
};
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
const npm = (args, cwd) =>
  execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

/** The committed sheperd manifest, checked: every platform package pinned to its own version. */
function manifest() {
  const m = readJson(MANIFEST);
  const want = Object.keys(TARGETS).map((t) => `sheperd-${t}`);
  const got = Object.keys(m.optionalDependencies ?? {}).sort();
  if (JSON.stringify(got) !== JSON.stringify([...want].sort())) {
    fail(`optionalDependencies must be exactly ${want.join(", ")}; got ${got.join(", ")}`);
  }
  for (const [name, v] of Object.entries(m.optionalDependencies)) {
    if (v !== m.version) fail(`${name} is pinned to ${v}, not to sheperd's ${m.version}`);
  }
  if (m.dependencies && Object.keys(m.dependencies).length > 0) {
    fail("sheperd bundles its dependencies; the manifest must not list any");
  }
  return m;
}

/**
 * Release build of the sandbox. rustc embeds source paths (panic locations, dependency sources);
 * remap the home directory, cargo home and this checkout so no build-machine path ships. With
 * several matching prefixes the last one given wins, so the most specific comes last.
 */
function buildSandbox() {
  const home = homedir();
  const cargoHome = process.env.CARGO_HOME || join(home, ".cargo");
  const remap = [
    `--remap-path-prefix=${home}=/home`,
    `--remap-path-prefix=${cargoHome}=/cargo`,
    `--remap-path-prefix=${ROOT}=/rewire`,
  ];
  const flags = [process.env.RUSTFLAGS, ...remap].filter(Boolean).join(" ");
  execFileSync(
    "cargo",
    ["build", "--release", "--locked", "-p", "rewire-sandbox", "--target-dir", SANDBOX_TARGET_DIR],
    { cwd: ROOT, stdio: "inherit", env: { ...process.env, RUSTFLAGS: flags } },
  );
  process.stdout.write(`built ${SANDBOX_BINARY}\n`);
}

const hostTarget = () => `${process.platform}-${process.arch}`;

/** The nearest directory above `file` with a named package.json (skips `{"type": ...}` stubs). */
function pkgRootOf(file) {
  let dir = dirname(file);
  while (!existsSync(join(dir, "package.json")) || !readJson(join(dir, "package.json")).name) {
    const up = dirname(dir);
    if (up === dir) fail(`no package.json above ${file}`);
    dir = up;
  }
  return dir;
}

function licenseText(dir) {
  const f = readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\..*)?$/i.test(n));
  return f ? readFileSync(join(dir, f), "utf8").trim() : undefined;
}

async function buildSheperd(out) {
  const m = manifest();
  if (!existsSync(ENTRY)) fail(`${relative(ROOT, ENTRY)} is missing: run pnpm -r build first`);
  const dest = join(out, "sheperd");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(dest, "dist"), { recursive: true });

  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [ENTRY],
    outfile: join(dest, "dist", "main.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: false,
    legalComments: "none",
    metafile: true,
    logLevel: "warning",
    absWorkingDir: ROOT,
    define: { REWIRE_BUNDLE_VERSION: JSON.stringify(m.version) },
    // CommonJS dependencies call require() on node builtins; give the ESM bundle one.
    banner: {
      js: 'import { createRequire as __sheperdRequire } from "node:module";\nconst require = __sheperdRequire(import.meta.url);',
    },
  });

  // Every bundled @rewire package ships its non-dist `files` (prompts/, rules/) under
  // assets/<dir>/, which is where assetRoot() looks in the bundle.
  const third = new Map();
  const workspace = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    const abs = resolve(ROOT, input);
    const root = pkgRootOf(abs);
    const pkg = readJson(join(root, "package.json"));
    if (abs.split(sep).includes("node_modules")) {
      if (!third.has(pkg.name)) third.set(pkg.name, { pkg, root });
    } else if (pkg.name?.startsWith("@rewire/")) {
      workspace.add(root);
    } else {
      fail(`unexpected bundle input outside node_modules and the workspace: ${input}`);
    }
  }
  for (const root of workspace) {
    for (const f of readJson(join(root, "package.json")).files ?? []) {
      if (f === "dist") continue;
      cpSync(join(root, f), join(dest, "assets", relative(join(ROOT, "packages"), root), f), {
        recursive: true,
      });
    }
  }

  const notices = [
    "# Third-party software bundled in dist/main.js",
    "",
    "sheperd bundles the following packages. Their licenses follow.",
  ];
  for (const name of [...third.keys()].sort()) {
    const { pkg, root } = third.get(name);
    const text = licenseText(root);
    if (!text && !pkg.license) fail(`${name} has no license`);
    notices.push("", `## ${name}@${pkg.version} (${pkg.license ?? "see below"})`, "");
    notices.push(text ? ["```", text, "```"].join("\n") : `License: ${pkg.license}`);
  }
  writeFileSync(join(dest, "dist", "THIRD_PARTY_LICENSES.md"), `${notices.join("\n")}\n`);

  for (const f of ["README.md", "LICENSE", "NOTICE"]) copyFileSync(join(ROOT, f), join(dest, f));
  writeJson(join(dest, "package.json"), m);
  chmodSync(join(dest, "dist", "main.js"), 0o755);
  const head = readFileSync(join(dest, "dist", "main.js"), "utf8").slice(0, 40);
  if (!head.startsWith("#!/usr/bin/env node\n")) fail("the bundle lost its #! line");
  process.stdout.write(
    `staged ${relative(process.cwd(), dest) || dest} (sheperd ${m.version}; bundled ${third.size} third-party packages)\n`,
  );
}

/** The architecture a 64-bit ELF or Mach-O binary declares, checked against the target. */
function checkBinary(bin, target) {
  const want = TARGETS[target];
  const b = readFileSync(bin);
  if (want.format === "elf") {
    if (b.readUInt32BE(0) !== 0x7f454c46 || b[4] !== 2) fail(`${bin} is not a 64-bit ELF binary`);
    if (b.readUInt16LE(18) !== want.machine) fail(`${bin} is not built for ${target}`);
  } else {
    if (b.readUInt32LE(0) !== 0xfeedfacf) fail(`${bin} is not a 64-bit Mach-O binary`);
    if (b.readUInt32LE(4) !== want.machine) fail(`${bin} is not built for ${target}`);
  }
}

function buildPlatform(out, target, binary) {
  const m = manifest();
  if (!TARGETS[target]) fail(`unknown target ${target}; one of ${Object.keys(TARGETS).join(", ")}`);
  if (!binary || !statSync(binary, { throwIfNoEntry: false })?.isFile()) {
    fail(`--binary must name the built rewire-sandbox (got ${binary})`);
  }
  checkBinary(binary, target);
  const [os, cpu] = target.split("-");
  const name = `sheperd-${target}`;
  const dest = join(out, name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  copyFileSync(binary, join(dest, "rewire-sandbox"));
  chmodSync(join(dest, "rewire-sandbox"), 0o755);
  copyFileSync(join(ROOT, "LICENSE"), join(dest, "LICENSE"));
  writeJson(join(dest, "package.json"), {
    name,
    version: m.version,
    description: `The prebuilt rewire-sandbox binary for sheperd on ${os} ${cpu}. Install sheperd, not this.`,
    license: m.license,
    repository: m.repository,
    homepage: m.homepage,
    bugs: m.bugs,
    os: [os],
    cpu: [cpu],
    files: ["rewire-sandbox", "LICENSE"],
    preferUnplugged: true,
    publishConfig: m.publishConfig,
  });
  process.stdout.write(`staged ${relative(process.cwd(), dest) || dest} (${name} ${m.version})\n`);
}

/** Paths a package may contain, beyond package.json (always included by npm). */
const ALLOWED = {
  sheperd: [
    /^README\.md$/,
    /^LICENSE$/,
    /^NOTICE$/,
    /^dist\/main\.js$/,
    /^dist\/THIRD_PARTY_LICENSES\.md$/,
    /^assets\/[a-z-]+\/(prompts\/[\w.-]+\.md|rules\/[\w.-]+\.yml)$/,
  ],
  platform: [/^LICENSE$/, /^rewire-sandbox$/],
};
/** Strings that would leak the build machine into a published file. */
const LEAKS = [ROOT, homedir()].filter((s) => s.length > 1);

function checkPack(dir) {
  const pkg = readJson(join(dir, "package.json"));
  const kind = pkg.name === "sheperd" ? "sheperd" : "platform";
  const [report] = JSON.parse(npm(["pack", "--dry-run", "--json", "--ignore-scripts"], dir));
  const problems = [];
  const paths = report.files.map((f) => f.path).filter((p) => p !== "package.json");
  for (const p of paths) {
    if (!ALLOWED[kind].some((re) => re.test(p))) problems.push(`unexpected file ${p}`);
  }
  const must =
    kind === "sheperd"
      ? ["dist/main.js", "LICENSE", "README.md", "assets/gates/rules/semgrep-default.yml"]
      : ["rewire-sandbox", "LICENSE"];
  for (const p of must) if (!paths.includes(p)) problems.push(`missing ${p}`);
  for (const f of report.files) {
    const bytes = readFileSync(join(dir, f.path));
    for (const leak of LEAKS) {
      if (bytes.includes(leak)) problems.push(`${f.path} contains the local path ${leak}`);
    }
    if (f.path === "rewire-sandbox") {
      if ((f.mode & 0o111) === 0) problems.push("rewire-sandbox is not executable");
      continue;
    }
    if (/^\/\/# sourceMappingURL=/m.test(bytes.toString("utf8"))) {
      problems.push(`${f.path} references a source map`);
    }
  }
  if (problems.length > 0) fail(`${pkg.name}: ${problems.join("; ")}`);
  process.stdout.write(
    `${pkg.name}@${pkg.version}: ${report.entryCount} files, ${report.size} bytes packed, ${report.unpackedSize} unpacked\n`,
  );
  for (const f of report.files) process.stdout.write(`  ${f.path} (${f.size} B)\n`);
  return report;
}

function pack(out) {
  const dest = join(out, "tarballs");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const dirs = readdirSync(out)
    .filter((d) => d === "sheperd" || d.startsWith("sheperd-"))
    .map((d) => join(out, d));
  if (!dirs.some((d) => d.endsWith(`${sep}sheperd`))) fail(`no staged sheperd in ${out}`);
  for (const d of dirs) {
    checkPack(d);
    npm(["pack", "--ignore-scripts", "--pack-destination", dest], d);
  }
  process.stdout.write(`tarballs in ${dest}:\n`);
  for (const t of readdirSync(dest)) process.stdout.write(`  ${t}\n`);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: join(ROOT, "dist-npm") },
    target: { type: "string", default: hostTarget() },
    binary: { type: "string" },
  },
});
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
switch (positionals[0]) {
  case "sandbox":
    buildSandbox();
    break;
  case "sheperd":
    await buildSheperd(out);
    break;
  case "platform":
    buildPlatform(out, values.target, values.binary ? resolve(values.binary) : SANDBOX_BINARY);
    break;
  case "pack":
    pack(out);
    break;
  default:
    fail(
      "usage: build.mjs sandbox|sheperd|platform|pack [--out dir] [--target os-arch] [--binary path]",
    );
}
