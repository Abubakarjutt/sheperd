import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assetRoot, RewireError, type RunEvent, redact } from "@rewire/core";
import { type AgentTool, type RunAgentResult, runAgent } from "@rewire/loop";
import type { Policy } from "@rewire/policy";
import type { ChatMessage, ChatRequest, ModelRef, Provider } from "@rewire/providers";
import { profileFor, SandboxClient } from "@rewire/sandbox";
import { type SkillSet, skillIndex, skillTool } from "@rewire/skills";
import { createTools } from "@rewire/tools";
import type { SessionStore } from "./store.js";

const PACKAGE_ROOT = assetRoot("session", import.meta.url);
const STAGE = "chat";
const DEFAULT_MAX_TURNS = 40;
const SUMMARY_ARG_CAP = 200;
const TASK_MAX = 20_000;

/** Stand-ins appended so a stored turn always ends in a plain assistant message. */
export const PROPOSAL_NOTE = "[propose_run recorded: the user was asked to confirm the run]";
export const TURN_LIMIT_NOTE = "[turn ended: the tool-call limit for one turn was reached]";

export type ChatEvent =
  | { type: "tool_call"; tool: string; summary: string; isError: boolean }
  | { type: "skill_loaded"; name: string }
  | { type: "assistant_text"; text: string };

export type ChatTurn = {
  /** The model's final text for the turn, redacted. */
  text: string;
  proposal?: { task: string };
  /**
   * Set when the turn did not end with a plain model answer: `proposal` (propose_run ended it;
   * stored with PROPOSAL_NOTE) or `turn_limit` (the per-turn model-call cap; TURN_LIMIT_NOTE).
   */
  endedBy?: "proposal" | "turn_limit";
};

export type ChatSessionOptions = {
  repo: string;
  model: ModelRef;
  provider: Provider;
  policy: Policy;
  /**
   * Served through one `skill` tool per ChatSession. The session does NOT own the set: the
   * caller disposes it (`disposeSkillSet`) when the TUI exits. Its root is never writable here.
   */
  skills: SkillSet;
  store: SessionStore;
  /**
   * Model text (`assistant_text`, tool summaries) is redacted here but NOT sanitized: the UI
   * strips control sequences before rendering.
   */
  emit: (e: ChatEvent) => void;
  /**
   * Resume this stored session (it must be known to `store`: created or listed by it). Prefer
   * `ChatSession.resume`, which loads it eagerly so `history()` is filled before the first send.
   */
  sessionId?: string;
  /** Model calls per `send` (default 40). */
  maxTurns?: number;
};

let promptCache: string | undefined;
function chatPrompt(): string {
  promptCache ??= readFileSync(join(PACKAGE_ROOT, "prompts", "chat.md"), "utf8");
  return promptCache;
}

const aborted = (): RewireError => new RewireError("aborted", "the chat turn was aborted");
const disposedError = (): RewireError =>
  new RewireError("session_disposed", "the chat session was disposed");

/**
 * Settle as soon as `signal` aborts, even while a tool ignores it (bash runs to its own timeout).
 * The abandoned loop stops at its next abort check and its result is discarded.
 */
function untilAborted<T>(
  work: Promise<T>,
  signal: AbortSignal,
  reason: () => RewireError,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(reason());
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/**
 * The read-only chat agent behind the TUI. Its tools are read, grep, find and bash under the
 * sandbox `chat` profile (no writes under the repo, a private scratch dir, no network), plus
 * `skill` and `propose_run`. It never writes the repo; code changes only through a gated run
 * the user confirms from a proposal.
 *
 * Persistence: only complete turns are stored. A turn's messages go to the store in one append
 * after the turn ends normally. An aborted or failed turn stores nothing (not even its user
 * message) and leaves `history()` as it was, so the next `send` continues cleanly.
 *
 * `send` calls are serialized. Call `dispose()` when done (sandbox client and scratch dir): an
 * in-flight send then rejects with `session_disposed` and nothing more is stored.
 */
export class ChatSession {
  private readonly opts: ChatSessionOptions;
  private readonly skill: AgentTool;
  private messages: ChatMessage[] = [];
  private sid: string | undefined;
  private resumed = false;
  private sandbox: { client: SandboxClient; scratch: string } | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly life = new AbortController();
  /** Skills already reported by a live turn (a load in an abandoned turn is not reported). */
  private readonly reportedSkills = new Set<string>();

  constructor(opts: ChatSessionOptions) {
    this.opts = opts;
    this.sid = opts.sessionId;
    this.resumed = opts.sessionId === undefined;
    // One skill tool per session. Its loads are reported per turn by the wrapper in `turn`, so
    // a load that finishes after its turn was aborted or superseded stays silent.
    this.skill = skillTool(opts.skills, () => {});
  }

  /** A session resumed from `store`, its history loaded (session_corrupt on a bad file). */
  static async resume(opts: ChatSessionOptions & { sessionId: string }): Promise<ChatSession> {
    const s = new ChatSession(opts);
    await s.open();
    return s;
  }

  /** Load a resumed session's history now (idempotent). `send` does it on demand otherwise. */
  async open(): Promise<void> {
    if (this.resumed || this.sid === undefined) return;
    if (this.life.signal.aborted) throw disposedError();
    this.messages = await this.opts.store.load(this.sid);
    this.resumed = true;
  }

  /** The stored session id; undefined until the first completed turn of a new session. */
  id(): string | undefined {
    return this.sid;
  }

  /** A copy of the conversation so far (complete turns only). */
  history(): ChatMessage[] {
    return structuredClone(this.messages);
  }

  send(text: string, signal?: AbortSignal): Promise<ChatTurn> {
    const run = this.queue.then(() => this.turn(text, signal));
    this.queue = run.catch(() => {});
    return run;
  }

  async dispose(): Promise<void> {
    this.life.abort();
    // The in-flight send rejects promptly (session_disposed); wait so it cannot create a client
    // or store anything after the cleanup below.
    await this.queue;
    const s = this.sandbox;
    this.sandbox = undefined;
    if (s === undefined) return;
    try {
      s.client.dispose();
    } finally {
      await rm(s.scratch, { recursive: true, force: true });
    }
  }

  private emit(e: ChatEvent): void {
    try {
      this.opts.emit(e);
    } catch {
      // an observer must not break the turn
    }
  }

  private async client(): Promise<SandboxClient> {
    if (this.sandbox) return this.sandbox.client;
    const root = await realpath(resolve(this.opts.repo));
    const scratch = await realpath(await mkdtemp(join(tmpdir(), "rewire-chat-")));
    try {
      const client = new SandboxClient(profileFor("chat", root, this.opts.policy, scratch));
      this.sandbox = { client, scratch };
      return client;
    } catch (e) {
      await rm(scratch, { recursive: true, force: true });
      throw e;
    }
  }

  private async turn(text: string, signal: AbortSignal | undefined): Promise<ChatTurn> {
    const life = this.life.signal;
    const check = (): void => {
      if (life.aborted) throw disposedError();
      if (signal?.aborted) throw aborted();
    };
    check();
    await this.open();
    check();
    const client = await this.client();
    check();
    // The turn is live until it is aborted or the session is disposed; an abandoned turn's
    // loop may still finish a tool, and then stays silent.
    const live = (): boolean => !life.aborted && !signal?.aborted;
    const emitLive = (e: ChatEvent): void => {
      if (live()) this.emit(e);
    };

    let proposal: { task: string } | undefined;
    const end = new AbortController();
    const propose: AgentTool = {
      spec: {
        name: "propose_run",
        description:
          "Propose a gated rewire run that makes a code change. Ends your turn; the user confirms before it starts. `task` must be a precise, self-contained request that states what must change and what must keep working.",
        inputSchema: {
          type: "object",
          properties: { task: { type: "string", description: "the task for the gated run" } },
          required: ["task"],
        },
      },
      async execute(args) {
        const task = typeof args.task === "string" ? args.task.trim() : "";
        if (task === "") return { content: "propose_run needs a non-empty task", isError: true };
        if (task.length > TASK_MAX) {
          return { content: `the task is too long (max ${TASK_MAX} characters)`, isError: true };
        }
        if (proposal !== undefined) {
          return { content: "a run was already proposed in this turn", isError: true };
        }
        proposal = { task };
        end.abort();
        return {
          content: "Proposal recorded. The user will be asked to confirm the run.",
          isError: false,
        };
      },
    };
    const shared = this.skill;
    const skill: AgentTool = {
      spec: shared.spec,
      execute: async (args, sig) => {
        const r = await shared.execute(args, sig);
        const name = typeof args.name === "string" ? args.name : "";
        if (!r.isError && live() && !this.reportedSkills.has(name)) {
          this.reportedSkills.add(name);
          this.emit({ type: "skill_loaded", name });
        }
        return r;
      },
    };
    const { policy } = this.opts;
    const tools = [
      ...createTools(client, { policy, stage: STAGE, allow: ["read", "grep", "find", "bash"] }),
      skill,
      propose,
    ];
    const inner = this.opts.provider;
    const provider: Provider = {
      chat: async (req: ChatRequest) => {
        const res = await inner.chat(req);
        if (res.message.text !== "") {
          emitLive({ type: "assistant_text", text: redact(res.message.text) });
        }
        return res;
      },
    };
    const prior = this.messages;
    let result: RunAgentResult;
    try {
      result = await untilAborted(
        runAgent({
          provider,
          model: this.opts.model.model,
          system: `${chatPrompt()}\n\n${skillIndex(this.opts.skills)}`,
          prompt: text,
          history: prior,
          tools,
          maxTurns: this.opts.maxTurns ?? DEFAULT_MAX_TURNS,
          emit: (e: RunEvent) => {
            if (e.type !== "tool_call") return;
            const [tool = e.tool, ...rest] = redact(e.summary).split(" ");
            emitLive({
              type: "tool_call",
              tool: e.tool,
              summary: `${tool} ${rest.join(" ").slice(0, SUMMARY_ARG_CAP)}`,
              isError: e.isError,
            });
          },
          runId: this.sid ?? "chat",
          stage: STAGE,
          signal: AbortSignal.any([life, end.signal, ...(signal ? [signal] : [])]),
        }),
        signal ? AbortSignal.any([life, signal]) : life,
        () => (life.aborted ? disposedError() : aborted()),
      );
    } catch (e) {
      if (e instanceof RewireError && e.code === "loop_history_invalid") {
        throw new RewireError(
          "session_corrupt",
          `the stored session ${this.sid ?? "(new)"} cannot be resumed: ${e.message}`,
          "start a new session; the file is kept as it is",
        );
      }
      throw e;
    }

    check();
    if (result.endedBy === "error") {
      throw result.error ?? new RewireError("loop_provider_error", "the chat turn failed");
    }
    if (result.endedBy === "aborted" && proposal === undefined) throw aborted();

    const added = result.messages.slice(prior.length);
    const last = added[added.length - 1];
    let endedBy: ChatTurn["endedBy"];
    if (proposal !== undefined) {
      added.push({ role: "assistant", content: PROPOSAL_NOTE });
      endedBy = "proposal";
    } else if (last?.role !== "assistant" || (last.toolCalls?.length ?? 0) > 0) {
      added.push({ role: "assistant", content: TURN_LIMIT_NOTE });
      endedBy = "turn_limit";
    }
    this.sid ??= await this.opts.store.create(this.opts.repo);
    check(); // disposed (or aborted) while the file was created: store nothing
    await this.opts.store.append(this.sid, added);
    this.messages = [...prior, ...added];
    return {
      text: redact(result.lastText),
      ...(proposal ? { proposal } : {}),
      ...(endedBy ? { endedBy } : {}),
    };
  }
}
