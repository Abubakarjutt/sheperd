import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@rewire/loop";
import { DEFAULT_POLICY, type Policy } from "@rewire/policy";
import { createWorktree, profileFor, SandboxClient, type StageName } from "@rewire/sandbox";
import { expect, test } from "vitest";
import { createTools } from "../src/index.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function setup(
  stage: StageName = "implementer",
  opts: {
    allow?: Array<"read" | "write" | "edit" | "bash" | "grep" | "find">;
    policy?: Policy;
    files?: Record<string, string>;
  } = {},
) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "rewire-tools-repo-")));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "a.txt"), "a\n");
  for (const [p, c] of Object.entries(opts.files ?? {})) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), c);
  }
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const wt = await createWorktree(repo, "run1");
  const root = realpathSync(wt.path);
  const policy = opts.policy ?? DEFAULT_POLICY;
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "rewire-tools-scratch-")));
  const client = new SandboxClient(profileFor(stage, root, policy, scratch));
  const tools = createTools(client, {
    policy,
    stage,
    allow: opts.allow ?? ["read", "write", "edit", "bash", "grep", "find"],
  });
  const t = (name: string): AgentTool => {
    const x = tools.find((y) => y.spec.name === name);
    if (!x) throw new Error(`no tool ${name}`);
    return x;
  };
  return { root, tools, t };
}

const forbidNpm: Policy = {
  ...DEFAULT_POLICY,
  commandRules: [
    {
      pattern: ["npm", ["install", "i"]],
      decision: "forbidden",
      justification: "use pnpm instead of npm",
    },
  ],
};

test("edit fails on ambiguous oldString", async () => {
  const { root, t } = await setup();
  writeFileSync(join(root, "f.txt"), "a a");
  const r = await t("edit").execute({ path: "f.txt", oldString: "a", newString: "b" });
  expect(r.isError).toBe(true);
  expect(r.content).toMatch(/matches 2 times/);
  expect(readFileSync(join(root, "f.txt"), "utf8")).toBe("a a");
});

test("edit not found, replaceAll, and unique replace", async () => {
  const { root, t } = await setup();
  writeFileSync(join(root, "f.txt"), "a a");
  const nf = await t("edit").execute({ path: "f.txt", oldString: "zzz", newString: "b" });
  expect(nf.isError).toBe(true);
  expect(nf.content).toContain("oldString not found");
  const all = await t("edit").execute({
    path: "f.txt",
    oldString: "a",
    newString: "b",
    replaceAll: true,
  });
  expect(all.isError).toBe(false);
  expect(readFileSync(join(root, "f.txt"), "utf8")).toBe("b b");
  const one = await t("edit").execute({ path: "f.txt", oldString: "b b", newString: "c" });
  expect(one.isError).toBe(false);
  expect(readFileSync(join(root, "f.txt"), "utf8")).toBe("c");
});

test("write to frozen test path returns protected error and file unchanged", async () => {
  const { root, t } = await setup("implementer");
  const r = await t("write").execute({ path: "tests/x.test.ts", content: "x" });
  expect(r.isError).toBe(true);
  expect(r.content).toMatch(/^.*tests\/x\.test\.ts is protected \(rule .+\) in stage implementer$/);
  expect(existsSync(join(root, "tests/x.test.ts"))).toBe(false);
  const ok = await t("write").execute({ path: "src/a.ts", content: "hi" });
  expect(ok.isError).toBe(false);
  expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("hi");
});

test("bash cannot bypass via redirect", async () => {
  const { root, t } = await setup("implementer");
  const r = await t("bash").execute({ command: "echo x > tests/a.test.ts" });
  expect(r.isError).toBe(true);
  expect(existsSync(join(root, "tests/a.test.ts"))).toBe(false);
});

test("forbidden command rule blocks before exec", async () => {
  const { root, t } = await setup("implementer", { policy: forbidNpm });
  const r = await t("bash").execute({ command: "npm install left-pad && touch ran" });
  expect(r.isError).toBe(true);
  expect(r.content).toContain("use pnpm instead of npm");
  expect(existsSync(join(root, "ran"))).toBe(false);
});

test.each([
  ["a && npm install", "a && npm install x"],
  ["absolute path", "/usr/bin/npm i"],
  ["env wrapper", "env X=1 npm i"],
  ["sh -c", `sh -c "npm i"`],
  ["leading assignment", "X=1 npm i"],
  ["subshell", "(npm i)"],
  ["semicolon", "true; sudo nice npm install"],
])("command rule bypass form blocked: %s", async (_n, command) => {
  const { t } = await setup("implementer", { policy: forbidNpm });
  const r = await t("bash").execute({ command });
  expect(r.isError).toBe(true);
  expect(r.content).toContain("use pnpm instead of npm");
});

test("bash output truncated with marker", async () => {
  const { t } = await setup();
  const r = await t("bash").execute({ command: "yes | head -n 100000" });
  expect(r.content).toContain("chars omitted");
  expect(r.content.length).toBeLessThan(31_000);
});

test("bash non-zero exit is error with exit code; success includes stdout", async () => {
  const { t } = await setup();
  const bad = await t("bash").execute({ command: "echo out; echo err >&2; exit 7" });
  expect(bad.isError).toBe(true);
  expect(bad.content).toContain("exit code 7");
  expect(bad.content).toContain("out");
  expect(bad.content).toContain("err");
  const good = await t("bash").execute({ command: "echo hello" });
  expect(good.isError).toBe(false);
  expect(good.content).toContain("hello");
  expect(good.content).toContain("exit code 0");
});

test("bash timeout reports timed out", async () => {
  const { t } = await setup();
  const r = await t("bash").execute({ command: "sleep 5", timeoutMs: 300 });
  expect(r.isError).toBe(true);
  expect(r.content).toContain("timed out after 300ms");
});

test("bash background process is reported, not success", async () => {
  const { t } = await setup();
  const r = await t("bash").execute({ command: "sleep 30 &" });
  expect(r.isError).toBe(true);
  expect(r.content).toMatch(/background/i);
});

test("read: offsets, cap, and truncation notice", async () => {
  const lines = Array.from({ length: 2500 }, (_, i) => `line${i + 1}`).join("\n");
  const { t } = await setup("implementer", { files: { "big.txt": lines } });
  const r = await t("read").execute({ path: "big.txt" });
  expect(r.isError).toBe(false);
  expect(r.content).toContain("line2000");
  expect(r.content).not.toContain("line2001");
  expect(r.content).toContain("[truncated: 500 more lines]");
  const s = await t("read").execute({ path: "big.txt", offset: 10, limit: 2 });
  expect(s.content).toContain("line10");
  expect(s.content).toContain("line11");
  expect(s.content).not.toContain("line12");
  expect(s.content).not.toContain("line9\n");
});

test("read of a read-denied path is an error", async () => {
  const { t } = await setup("implementer", { files: { ".env": "SECRET=1\n" } });
  const r = await t("read").execute({ path: ".env" });
  expect(r.isError).toBe(true);
  expect(r.content).not.toContain("SECRET=1");
});

test("read of a binary file", async () => {
  const { root, t } = await setup();
  writeFileSync(join(root, "b.bin"), Buffer.from([65, 0, 66]));
  const r = await t("read").execute({ path: "b.bin" });
  expect(r.content).toContain("binary file, not shown");
});

test("grep finds matches, no matches is not an error", async () => {
  const { t } = await setup("implementer", { files: { "src/x.ts": "const needle = 1;\n" } });
  const hit = await t("grep").execute({ pattern: "needle" });
  expect(hit.isError).toBe(false);
  expect(hit.content).toContain("src/x.ts");
  const miss = await t("grep").execute({ pattern: "nonexistent_zzz" });
  expect(miss.isError).toBe(false);
  expect(miss.content).toBe("no matches");
  const bad = await t("grep").execute({ pattern: "(" });
  expect(bad.isError).toBe(true);
});

test("grep rejects absolute and escaping paths", async () => {
  const { t } = await setup();
  const a = await t("grep").execute({ pattern: "x", path: "/etc" });
  expect(a.isError).toBe(true);
  expect(a.content).toMatch(/relative/);
  const b = await t("grep").execute({ pattern: "x", path: "../.." });
  expect(b.isError).toBe(true);
});

test("find lists files by glob", async () => {
  const { t } = await setup("implementer", { files: { "src/x.ts": "1", "src/y.md": "2" } });
  const r = await t("find").execute({ glob: "**/*.ts" });
  expect(r.isError).toBe(false);
  expect(r.content).toContain("src/x.ts");
  expect(r.content).not.toContain("y.md");
});

test("allow filter limits the toolset", async () => {
  const { tools } = await setup("review", { allow: ["read", "grep", "find"] });
  expect(tools.map((x) => x.spec.name).sort()).toEqual(["find", "grep", "read"]);
});

test("specs mark required keys", async () => {
  const { tools } = await setup();
  const edit = tools.find((x) => x.spec.name === "edit");
  expect(edit?.spec.inputSchema.required).toEqual(["path", "oldString", "newString"]);
});
