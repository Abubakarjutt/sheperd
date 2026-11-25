import {
  type CheckpointDecision,
  type CheckpointKind,
  RewireError,
  type RunEvent,
  redact,
} from "@rewire/core";
import {
  type Checkpoint,
  type PipelineSeams,
  type RoleRouting,
  type RunOutcome,
  type RunPipelineInput,
  runPipeline,
} from "@rewire/pipeline";
import type { Policy } from "@rewire/policy";
import type { ModelRef, Provider } from "@rewire/providers";
import type { SkillSet } from "@rewire/skills";

export type PendingPrompt =
  | { kind: "checkpoint"; checkpoint: Checkpoint }
  | { kind: "clarify"; questions: string[] };

export type RunHandle = {
  /** Every event of the run, buffered from the start. Completes when `done` settles. */
  events: AsyncIterable<RunEvent>;
  /** The prompt waiting for the user, if any. Undefined once `done` has settled. */
  pending(): PendingPrompt | undefined;
  /**
   * Answer `p`. A checkpoint takes a `CheckpointDecision` (passed to the pipeline as given: it
   * validates and escalates `stage_error` on an invalid one). A clarification takes the answers,
   * or `null` to decline. Answering a prompt that is not the current one (stale, already
   * answered, or after the run ended) is a no-op.
   */
  answer(p: PendingPrompt, value: CheckpointDecision | string[] | null): void;
  /** Abort the run (idempotent). `done` then resolves escalated/interrupted. */
  abort(): void;
  /** Never rejects: a thrown pipeline error becomes an escalated outcome. */
  done: Promise<RunOutcome>;
};

export type RunControllerOptions = {
  repo: string;
  routing: RoleRouting;
  providers: (ref: ModelRef) => Provider;
  policy: Policy;
  /** For the author stages. The caller owns the set; the controller never disposes it. */
  skills?: SkillSet;
  faux?: boolean;
  seams?: PipelineSeams;
  /** Test seam; defaults to `runPipeline`. */
  pipeline?: (input: RunPipelineInput) => Promise<RunOutcome>;
};

const ERROR_TEXT_CAP = 500;

/** A buffered event stream: every iterator sees every event from the start, then ends. */
class EventStream implements AsyncIterable<RunEvent> {
  private readonly buf: RunEvent[] = [];
  private ended = false;
  private waiters: Array<() => void> = [];

  push(e: RunEvent): void {
    if (this.ended) return;
    this.buf.push(e);
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RunEvent> {
    let i = 0;
    for (;;) {
      if (i < this.buf.length) {
        yield this.buf[i++] as RunEvent;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
}

type Slot = { prompt: PendingPrompt; settle: (v: unknown) => void };

/**
 * Starts one gated pipeline run at a time for the TUI. The pipeline's `checkpoint` and `ask`
 * callbacks become a `PendingPrompt` the UI shows and answers with `answer`; each pending prompt
 * has exactly one deferred, settled at most once. `abort()` ends the run as interrupted: the
 * pipeline races a pending checkpoint against the signal, and a pending clarification is
 * declined (`null`) so the spec stage returns and the pipeline sees the abort.
 *
 * Checkpoint payloads are passed through unchanged (unredacted, may contain NUL): the UI
 * sanitizes them before rendering.
 */
export class RunController {
  private active = false;

  constructor(private readonly opts: RunControllerOptions) {}

  /** True while a run's `done` has not settled. */
  running(): boolean {
    return this.active;
  }

  start(task: string, opts: { checkpoints: Set<CheckpointKind> }): RunHandle {
    if (this.active) {
      throw new RewireError(
        "run_in_progress",
        "a gated run is already in progress",
        "answer its prompt or abort it (Ctrl-C) before starting another",
      );
    }
    this.active = true;

    const ac = new AbortController();
    const stream = new EventStream();
    // Snapshot: a later /checkpoints change applies to the next run, not this one.
    const kinds: CheckpointKind[] = [...opts.checkpoints];
    let slot: Slot | undefined;
    let runId = "";

    const wait = <T>(prompt: PendingPrompt, onAbort: T): Promise<T> =>
      new Promise<T>((resolve) => {
        if (ac.signal.aborted) return resolve(onAbort);
        slot = { prompt, settle: (v) => resolve(v as T) };
      });
    // Settle the current deferred once and clear it.
    const settle = (v: unknown): void => {
      const s = slot;
      slot = undefined;
      s?.settle(v);
    };
    const release = (): void => {
      // On abort a pending checkpoint has already lost the pipeline's race; `stop` only frees
      // the deferred. A pending clarification gets `null` (declined).
      settle(slot?.prompt.kind === "clarify" ? null : { action: "stop" });
    };

    const input: RunPipelineInput = {
      task,
      repo: this.opts.repo,
      routing: this.opts.routing,
      providers: this.opts.providers,
      policy: this.opts.policy,
      signal: ac.signal,
      emit: (e) => {
        if (e.type === "run_start") runId = e.runId;
        stream.push(e);
      },
      ask: (questions) => wait<string[] | null>({ kind: "clarify", questions }, null),
      checkpoint: (checkpoint) =>
        wait<CheckpointDecision>({ kind: "checkpoint", checkpoint }, { action: "stop" }),
      checkpointKinds: kinds,
      ...(this.opts.skills ? { skills: this.opts.skills } : {}),
      ...(this.opts.faux ? { faux: true } : {}),
      ...(this.opts.seams ? { seams: this.opts.seams } : {}),
    };
    const pipeline = this.opts.pipeline ?? runPipeline;

    const done = (async (): Promise<RunOutcome> => {
      try {
        return await Promise.resolve().then(() => pipeline(input));
      } catch (e) {
        return thrownOutcome(e, runId, ac.signal.aborted);
      } finally {
        release();
        stream.end();
        this.active = false;
      }
    })();

    return {
      events: stream,
      pending: () => slot?.prompt,
      answer: (p, value) => {
        if (slot === undefined || slot.prompt !== p) return;
        if (p.kind === "clarify") {
          const ok = Array.isArray(value) && value.every((a) => typeof a === "string");
          settle(ok ? value : null);
        } else {
          settle(value);
        }
      },
      abort: () => {
        if (ac.signal.aborted) return;
        ac.abort();
        release();
      },
      done,
    };
  }
}

function thrownOutcome(e: unknown, runId: string, aborted: boolean): RunOutcome {
  const raw =
    e instanceof RewireError
      ? `${e.code}: ${e.message}`
      : e instanceof Error
        ? `internal_error: ${e.message}`
        : `internal_error: ${String(e)}`;
  const detail = redact(raw).slice(0, ERROR_TEXT_CAP);
  return {
    runId,
    status: "escalated",
    branch: "",
    worktree: "",
    reportPath: "",
    escalation: {
      reason: aborted ? "interrupted" : "stage_error",
      tried: [],
      unresolved: [],
      hypothesis: "The run failed with an error before it could write a report.",
      question: "Check the error and re-run the task.",
      details: [detail],
    },
  };
}

/**
 * The chat-history note added after a run: status, branch or escalation reason, the question,
 * and the report path. Not sanitized: the UI does that before rendering.
 */
export function outcomeMessage(o: RunOutcome): string {
  const id = o.runId ? ` ${o.runId}` : "";
  const report = o.reportPath ? `Report: ${o.reportPath}` : "Report: none (no report was written)";
  if (o.status === "verified") {
    return [`Run${id} verified.`, `Branch: ${o.branch}`, report].join("\n");
  }
  const esc = o.escalation;
  const lines = [`Run${id} escalated (${esc?.reason ?? "unknown"}).`];
  if (esc?.question) lines.push(`Question: ${esc.question}`);
  lines.push(report);
  return lines.join("\n");
}
