import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Contract, RewireError, type RunEvent } from "@rewire/core";
import { runAgent } from "@rewire/loop";
import { DEFAULT_POLICY, type Policy } from "@rewire/policy";
import { type ChatMessage, type ModelRef, type Provider, structured } from "@rewire/providers";
import { profileFor, SandboxClient } from "@rewire/sandbox";
import { createTools } from "@rewire/tools";

const STAGE = "spec";
const MAX_TURNS = 20;
const DIGEST_CAP_BYTES = 200 * 1024;
const SUMMARY_ARG_CAP = 120;
const SECRET = /(sk-|ghp_|AKIA)[A-Za-z0-9_-]+/g;

export type SpecInput = {
  task: string;
  worktree: string;
  model: ModelRef;
  provider: Provider;
  /** Returns one answer per question, or null when no human is available. */
  ask: (questions: string[]) => Promise<string[] | null>;
  emit: (e: RunEvent) => void;
  runId: string;
  signal?: AbortSignal;
  /** Defaults to a `spec`-profile client rooted at `worktree`. */
  client?: SandboxClient;
  policy?: Policy;
};

let promptCache: string | undefined;
function specPrompt(): string {
  // Same relative path from src/stages and dist/stages.
  promptCache ??= readFileSync(new URL("../../prompts/spec.md", import.meta.url), "utf8");
  return promptCache;
}

function redact(s: string): string {
  return s.replace(SECRET, "[redacted]");
}

function serialize(m: ChatMessage): string {
  if (m.role === "tool") return `[tool result]\n${m.content}`;
  const calls = (m.toolCalls ?? [])
    .map((c) => `\n[tool call] ${c.name} ${JSON.stringify(c.arguments)}`)
    .join("");
  return `[${m.role}]\n${m.content}${calls}`;
}

/** Task, then the exploration; oldest tool results are dropped first to stay under the cap. */
function buildDigest(task: string, messages: ChatMessage[]): { digest: string; trimmed: boolean } {
  const head = `# Task\n${task}\n\n# Exploration transcript\n`;
  const parts = messages.map(serialize);
  const size = () => Buffer.byteLength(head + parts.join("\n\n"), "utf8");
  let trimmed = false;
  for (let i = 0; i < messages.length && size() > DIGEST_CAP_BYTES; i++) {
    if (messages[i]?.role === "tool") {
      parts[i] = "[tool result dropped: transcript size cap]";
      trimmed = true;
    }
  }
  let body = parts.join("\n\n");
  if (Buffer.byteLength(head + body, "utf8") > DIGEST_CAP_BYTES) {
    // Only non-tool text is left; keep the newest part.
    body = Buffer.from(body, "utf8")
      .subarray(-(DIGEST_CAP_BYTES - Buffer.byteLength(head, "utf8")))
      .toString("utf8");
    trimmed = true;
  }
  return { digest: head + body, trimmed };
}

function numbered(c: Contract): Contract {
  return { ...c, criteria: c.criteria.map((x, i) => ({ ...x, id: `AC-${i + 1}` })) };
}

function clarification(questions: string[]): RewireError {
  return new RewireError("clarification_required", questions.join("\n"));
}

export async function runSpecStage(input: SpecInput): Promise<Contract> {
  const { runId } = input;
  const safeEmit = (e: RunEvent): void => {
    try {
      const r: unknown = input.emit(e);
      Promise.resolve(r).catch(() => {});
    } catch {
      // Observers must never break the stage.
    }
  };
  const ev = () => ({ runId, ts: new Date().toISOString(), stage: STAGE });

  safeEmit({ ...ev(), type: "stage_start" });
  let ok = false;
  try {
    const contract = await compile(input, safeEmit);
    ok = true;
    return contract;
  } finally {
    safeEmit({ ...ev(), type: "stage_end", ok });
  }
}

async function compile(input: SpecInput, safeEmit: (e: RunEvent) => void): Promise<Contract> {
  const policy = input.policy ?? DEFAULT_POLICY;
  const client =
    input.client ??
    new SandboxClient(
      profileFor(
        STAGE,
        input.worktree,
        policy,
        mkdtempSync(join(tmpdir(), "rewire-spec-scratch-")),
      ),
    );
  const tools = createTools(client, { policy, stage: STAGE, allow: ["read", "grep", "find"] });
  const system = specPrompt();

  const explored = await runAgent({
    provider: input.provider,
    model: input.model.model,
    system,
    prompt: input.task,
    tools,
    maxTurns: MAX_TURNS,
    emit: (e) => {
      if (e.type === "tool_call") {
        const [tool = e.tool, ...rest] = redact(e.summary).split(" ");
        safeEmit({ ...e, summary: `${tool} ${rest.join(" ").slice(0, SUMMARY_ARG_CAP)}` });
      } else safeEmit(e);
    },
    runId: input.runId,
    stage: STAGE,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  // Never compile a contract from a broken exploration. max_turns (and a length-truncated
  // final message) still compile from what was gathered.
  if (explored.endedBy === "error") {
    throw explored.error ?? new RewireError("spec_exploration_failed", "exploration failed");
  }
  if (explored.endedBy === "aborted") {
    throw new RewireError("aborted", "spec exploration was aborted");
  }

  const { digest, trimmed } = buildDigest(input.task, explored.messages);
  const sys = `${system}\n\nCompile the task into the contract JSON from the exploration below.${
    trimmed
      ? " The transcript was capped at about 200 KB: the oldest tool results were dropped."
      : ""
  }`;
  const compileWith = (content: string) =>
    structured(input.provider, input.model, Contract, {
      system: sys,
      messages: [{ role: "user", content }],
      maxTokens: 8192,
      ...(input.signal ? { signal: input.signal } : {}),
    });

  let contract = await compileWith(digest);
  if (contract.openQuestions.length > 0) {
    const questions = contract.openQuestions;
    const answers = await input.ask(questions);
    if (answers === null || answers.length !== questions.length) throw clarification(questions);
    const qa = questions.map((q, i) => `Q: ${q}\nA: ${answers[i]}`).join("\n\n");
    contract = await compileWith(`${digest}\n\n# Clarifications\n${qa}`);
    if (contract.openQuestions.length > 0) throw clarification(contract.openQuestions);
  }
  return numbered(contract);
}
