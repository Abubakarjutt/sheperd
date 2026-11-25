#!/usr/bin/env node
// Assembles and checks the npm packages (docs/RELEASING.md). Nothing here publishes.
//
//   node scripts/npm/build.mjs sandbox
//       cargo build --release of rewire-sandbox into target/npm/, with local paths remapped so
//       the binary does not embed the build machine's home or checkout path.
//   node scripts/npm/build.mjs sheperd  [--out dir] [--all-platforms]
//       Bundles packages/cli/dist/main.js (run `pnpm -r build` first) into <out>/sheperd/,
//       recording the sha256 of every platform binary already staged in <out> (stage them
//       first); the installed CLI refuses a platform binary that does not match.
//       --all-platforms (release) requires all four.
//   node scripts/npm/build.mjs platform [--target <os>-<arch>] [--binary <path>] [--out dir]
//       Stages the prebuilt rewire-sandbox (default: the `sandbox` output) as
//       <out>/sheperd-<os>-<arch>/. The target defaults to this host; the binary's own header
//       must match it. Also writes THIRD_PARTY_LICENSES.md for the Rust crates linked in.
//   node scripts/npm/build.mjs check    [--out dir]
//       Runs pack's file-list and local-path checks on every staged package, without packing
//       (the release workflow runs it on each native build runner).
//   node scripts/npm/build.mjs pack     [--out dir] [--all-platforms]
//       Checks every staged package's `npm pack --dry-run` file list and contents, then packs
//       each into <out>/tarballs/. --all-platforms (release) requires every platform package.
//
// <out> defaults to dist-npm/ in the repository root.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  "darwin-arm64": { format: "macho", machine: 0x0100000c, triple: "aarch64-apple-darwin" },
  "darwin-x64": { format: "macho", machine: 0x01000007, triple: "x86_64-apple-darwin" },
  "linux-arm64": { format: "elf", machine: 183, triple: "aarch64-unknown-linux-gnu" },
  "linux-x64": { format: "elf", machine: 62, triple: "x86_64-unknown-linux-gnu" },
};
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** sha256 of each staged platform binary in <out>, keyed by target. */
function stagedHashes(out) {
  const hashes = {};
  for (const t of Object.keys(TARGETS)) {
    const bin = join(out, `sheperd-${t}`, "rewire-sandbox");
    if (existsSync(bin)) hashes[t] = sha256(bin);
  }
  return hashes;
}

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

/**
 * Ink imports `react-devtools-core` (an optional peer it loads only when DEV=true and the package
 * resolves) from its devtools module. sheperd does not ship it: left unresolved the build fails,
 * and a plain `external` leaves a static import that crashes the bundle on load
 * (ERR_MODULE_NOT_FOUND). Replace it with an inert stub; {@link inkDevtoolsOff} makes Ink's
 * devtools branch dead code, so neither the stub nor Ink's devtools module ever runs.
 */
const stubDevtools = {
  name: "stub-react-devtools-core",
  setup(b) {
    b.onResolve({ filter: /^react-devtools-core$/ }, (a) => ({
      path: a.path,
      namespace: "sheperd-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "sheperd-stub" }, () => ({
      contents: "export default { initialize() {}, connectToDevTools() {} };\n",
      loader: "js",
    }));
  },
};

/**
 * Ink gates every devtools path (the react-devtools-core import and its window polyfill and
 * localhost probe, injectIntoDevTools, a package.json read) on `process.env['DEV'] === 'true'`,
 * with `process` imported from node:process, which an esbuild `define` cannot reach. Rewrite
 * that test to `false` in Ink's own files, so a user's DEV=true never turns them on.
 * `inkDevGuards` counts the rewrites; the build fails if Ink stops matching.
 */
const INK_DEV_GUARD = /process\.env\[(['"])DEV\1\]\s*===\s*(['"])true\2/g;
let inkDevGuards = 0;
const inkDevtoolsOff = {
  name: "ink-devtools-off",
  setup(b) {
    b.onLoad({ filter: /[\\/]node_modules[\\/]ink[\\/]build[\\/][^\\/]+\.js$/ }, (a) => {
      const src = readFileSync(a.path, "utf8");
      const contents = src.replace(INK_DEV_GUARD, () => {
        inkDevGuards++;
        return "false";
      });
      return { contents, loader: "js" };
    });
  },
};

async function buildSheperd(out, allPlatforms) {
  const m = manifest();
  const hashes = stagedHashes(out);
  const missing = Object.keys(TARGETS).filter((t) => !hashes[t]);
  if (Object.keys(hashes).length === 0) {
    fail(`no platform package staged in ${out}: run 'build.mjs platform' first`);
  }
  if (allPlatforms && missing.length > 0)
    fail(`platform packages not staged: ${missing.join(", ")}`);
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
    define: {
      REWIRE_BUNDLE_VERSION: JSON.stringify(m.version),
      REWIRE_BUNDLE_SANDBOX_SHA256: JSON.stringify(hashes),
    },
    plugins: [stubDevtools, inkDevtoolsOff],
    // CommonJS dependencies call require() on node builtins; give the ESM bundle one.
    banner: {
      js: 'import { createRequire as __sheperdRequire } from "node:module";\nconst require = __sheperdRequire(import.meta.url);',
    },
  });

  if (inkDevGuards === 0) fail("no Ink DEV guard was rewritten: update inkDevtoolsOff");

  // Every bundled @rewire package ships its non-dist `files` (prompts/, rules/) under
  // assets/<dir>/, which is where assetRoot() looks in the bundle.
  const third = new Map();
  const workspace = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    if (input.startsWith("<define:")) continue; // an object `define`, not a file
    if (input.startsWith("sheperd-stub:")) continue; // stubDevtools: no file, nothing bundled
    const abs = resolve(ROOT, input);
    const root = pkgRootOf(abs);
    const pkg = readJson(join(root, "package.json"));
    if (abs.split(sep).includes("node_modules")) {
      // One entry per bundled version: two majors of a package may carry different notices.
      const key = `${pkg.name}@${pkg.version}`;
      if (!third.has(key)) third.set(key, { pkg, root });
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
  const byNameVersion = ([a], [b]) => a.localeCompare(b, "en", { numeric: true });
  for (const [id, { pkg, root }] of [...third.entries()].sort(byNameVersion)) {
    const text = licenseText(root);
    if (!text && !pkg.license) fail(`${id} has no license`);
    notices.push("", `## ${id} (${pkg.license ?? "see below"})`, "");
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
  for (const [t, h] of Object.entries(hashes)) process.stdout.write(`  sandbox sha256 ${t} ${h}\n`);
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

/**
 * Licence notices for the Rust crates linked into rewire-sandbox for `target`: the normal
 * (non-dev, non-build) dependency closure from `cargo metadata --locked` for that target's
 * triple. Identical licence texts are printed once, with every crate that ships them.
 */
function crateNotices(target) {
  const meta = JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--format-version",
        "1",
        "--locked",
        "--filter-platform",
        TARGETS[target].triple,
      ],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const root = meta.packages.find((p) => p.name === "rewire-sandbox" && p.source === null);
  if (!root) fail("cargo metadata has no rewire-sandbox package");
  const seen = new Set();
  const stack = [root.id];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of nodes.get(id)?.deps ?? []) {
      if (d.dep_kinds.some((k) => k.kind === null)) stack.push(d.pkg);
    }
  }
  const texts = new Map(); // licence text -> the crate files that carry it
  const bare = [];
  const crates = [...seen]
    .map((id) => byId.get(id))
    .filter((p) => p.source !== null) // workspace members are rewire's own (LICENSE)
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  for (const p of crates) {
    const dir = dirname(p.manifest_path);
    const files = readdirSync(dir)
      .filter((n) => /^(licen[cs]e|copying|notice|copyright)/i.test(n))
      .filter((n) => statSync(join(dir, n)).isFile())
      .sort();
    const label = `${p.name}@${p.version} (${p.license ?? "no license field"})`;
    if (files.length === 0) {
      if (!p.license) fail(`crate ${p.name}@${p.version} has neither a licence file nor a licence`);
      bare.push(label);
      continue;
    }
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8").trim();
      texts.set(text, [...(texts.get(text) ?? []), `${label}: ${f}`]);
    }
  }
  const lines = [
    `# Third-party software in rewire-sandbox (${target})`,
    "",
    `rewire-sandbox statically links these ${crates.length} Rust crates:`,
    "",
    ...crates.map((p) => `- ${p.name} ${p.version} (${p.license ?? "see below"})`),
  ];
  if (bare.length > 0) {
    lines.push("", "These crates ship no licence file; their declared licence applies:", "");
    lines.push(...bare.map((l) => `- ${l}`));
  }
  for (const [text, users] of texts) {
    lines.push("", "---", "", ...users.map((u) => `- ${u}`), "", "```", text, "```");
  }
  return `${lines.join("\n")}\n`;
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
  writeFileSync(join(dest, "THIRD_PARTY_LICENSES.md"), crateNotices(target));
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
    // The Linux binaries link glibc; npm skips the package on musl (Alpine), and doctor then
    // reports a missing binary instead of an exec failure.
    ...(os === "linux" ? { libc: ["glibc"] } : {}),
    files: ["rewire-sandbox", "LICENSE", "THIRD_PARTY_LICENSES.md"],
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
  platform: [/^LICENSE$/, /^THIRD_PARTY_LICENSES\.md$/, /^rewire-sandbox$/],
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
      : ["rewire-sandbox", "LICENSE", "THIRD_PARTY_LICENSES.md"];
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

/** The bundle must record the sha256 of every platform binary packed with it. */
function checkBundleHashes(out) {
  const bundle = readFileSync(join(out, "sheperd", "dist", "main.js"), "utf8");
  for (const [t, h] of Object.entries(stagedHashes(out))) {
    if (!bundle.includes(`"${t}": "${h}"`) && !bundle.includes(`"${t}":"${h}"`)) {
      fail(`the sheperd bundle does not record sha256 ${h} for sheperd-${t}; rebuild sheperd`);
    }
  }
}

function stagedDirs(out) {
  return readdirSync(out)
    .filter((d) => d === "sheperd" || d.startsWith("sheperd-"))
    .map((d) => join(out, d));
}

function pack(out, allPlatforms) {
  const dest = join(out, "tarballs");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const dirs = stagedDirs(out);
  if (!dirs.some((d) => d.endsWith(`${sep}sheperd`))) fail(`no staged sheperd in ${out}`);
  checkBundleHashes(out);
  if (allPlatforms) {
    const missing = Object.keys(TARGETS).filter((t) => !existsSync(join(out, `sheperd-${t}`)));
    if (missing.length > 0) fail(`platform packages not staged: ${missing.join(", ")}`);
  }
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
    "all-platforms": { type: "boolean", default: false },
  },
});
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
switch (positionals[0]) {
  case "sandbox":
    buildSandbox();
    break;
  case "sheperd":
    await buildSheperd(out, values["all-platforms"]);
    break;
  case "check": {
    const dirs = stagedDirs(out);
    if (dirs.length === 0) fail(`nothing staged in ${out}`);
    for (const d of dirs) checkPack(d);
    break;
  }
  case "platform":
    buildPlatform(out, values.target, values.binary ? resolve(values.binary) : SANDBOX_BINARY);
    break;
  case "pack":
    pack(out, values["all-platforms"]);
    break;
  default:
    fail(
      "usage: build.mjs sandbox|sheperd|platform|check|pack [--out dir] [--target os-arch] [--binary path] [--all-platforms]",
    );
}
