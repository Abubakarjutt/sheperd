# Phase 0 — Harness Comparison: Codex, Pi, Claude Code

Date: 2026-11-20. Companion to [`../DESIGN-DECISIONS.md`](../DESIGN-DECISIONS.md).

## Method & provenance

| Harness | License | How studied | Source snapshot |
|---|---|---|---|
| **Codex CLI** (OpenAI) | Apache-2.0 | Source read (`github.com/openai/codex`, shallow clone) | `codex-rs/` Rust workspace, ~100 crates |
| **Pi** (Mario Zechner / earendil-works) | MIT | Source read (`github.com/badlogic/pi-mono` → now `earendil-works/pi`) | `packages/agent`, `packages/coding-agent`, `packages/ai` |
| **Claude Code** (Anthropic) | Proprietary | **Clean-room only**: public docs at code.claude.com (hooks, permissions, sub-agents, sandboxing). No decompilation. | Docs as of fetch date; some sections are model-summarized, flagged where relevant |

> Clean-room note: nothing in this document or in rewire's code may derive from Claude Code's bundled source. Only behavior described in public docs is used.

---

## 1. Agent loop

**Pi** — `packages/agent/src/agent-loop.ts`, **952 lines total**. This is the strongest evidence that a capable loop is small.
- Shape: an outer loop handles follow-up messages, and an inner loop handles tool calls and steering. Each turn goes: stream the assistant message, execute tool calls (parallel by default, or sequential per-tool via `executionMode`), append results, then decide whether to continue.
- Hook points on `AgentLoopConfig` map directly onto rewire's needs:
  - `beforeToolCall` → `{block, reason, terminate}`. This is where the **fast-gate and permission check** goes.
  - `afterToolCall` → can rewrite `content` and `isError` and set `terminate`. This is where **post-edit fast checks inject feedback** (type errors and similar go straight back to the model).
  - `finishTurn` → `{action: "end" | "continue"}`. This is where **"you may not declare done until gates pass"** goes.
  - `prepareNextTurn` / `prepareRequest` → can swap model, context and thinking level per turn. This handles **compaction and per-stage model routing**.
  - `transformContext`, `convertToLlm` → an internal message type, converted to the provider format only at the LLM boundary.
  - `getSteeringMessages` / `getFollowUpMessages` → lets a human inject input mid-run. This is the **TUI step-in** mechanism.
- Safety detail worth copying: if `stopReason === "length"`, **all tool calls in the truncated message are failed rather than executed**, because their arguments may have been silently truncated by the JSON-salvage parser.
- Tools are re-declared to the model as deltas via system messages (`toolsAdded` / `toolsRemoved`), so the tool loadout can change mid-session. That allows **stage-specific tool sets** without restarting the loop.
- `runToolCall` lets tools that call other tools go through the same hooks, so nested calls can't bypass permission checks.

**Codex** — the loop is spread across `core/src/session/`, `thread_manager.rs` (3.5k lines) and `codex_thread.rs`. It's much heavier: realtime, multi-thread, cloud tasks and an app-server protocol.

**Claude Code** (docs) — the loop isn't documented internally. Its *extension surface* is (see §5).

**→ Implications for rewire**
- Build our loop on Pi's design (MIT): an event stream, typed tool hooks, per-turn `prepare` and `finish` decisions. This confirms decision #5.
- Our `finishTurn` is the "done-gate". The implementer cannot end its turn while hard-block gates fail; `finishTurn` returns `continue` with the gate output injected.
- Adopt Pi's truncated-tool-call rule as-is.

---

## 2. Tool surface

| | Pi | Codex | Claude Code |
|---|---|---|---|
| Core tools | `read`, `write`, `edit` (+ `edit-diff`), `bash`, `grep`, `find`, `ls` (~4.1k lines total) | shell (unified exec), `apply_patch` (own patch format, separate crate), file search, MCP | Read/Write/Edit, Bash, Grep/Glob, Agent (subagents), WebFetch, MCP |
| Edit model | Exact-string replace + diff | Patch format parsed by `apply-patch` crate | Exact-string replace |
| Mutation safety | `file-mutation-queue.ts` serializes writes to the same file | Patch applied via the sandboxed process | — |
| Output limits | `truncate.ts`, `output-accumulator.ts` | Output spill to file (`hooks/output_spill.rs`) | — |

**→ Implications**
- Minimal tool set: read, write, edit, bash, grep, find, plus our **`index` tools** (symbol lookup, references, utility inventory) for decision #13.
- **Key point: tool-level path rules are not a security boundary.** Claude Code's docs say outright that Bash rules match the command *text*: `Bash(curl *)` doesn't stop `/usr/bin/curl`. An implementer blocked from `Edit(tests/**)` can still run `echo > tests/x.test.ts` in bash. So **frozen-test protection must be enforced at the OS sandbox layer** (Rust helper), not only in `beforeToolCall`. Do both: the tool hook gives a clear, instant error message, and the sandbox is the real guarantee.

---

## 3. Sandboxing & isolation

**Codex** (most mature, and the main thing to learn from):
- **macOS:** Seatbelt, `(deny default)` base policy modelled on Chrome's renderer sandbox (`sandboxing/src/seatbelt_base_policy.sbpl`), plus separate network and preference policy fragments.
- **Linux:** **bubblewrap + seccomp + `no_new_privs`** (`linux-sandbox/`), with a PID namespace and a managed TCP/DNS stack for network proxying. (It moved away from a pure Landlock design.)
- **Windows:** a dedicated `windows-sandbox-rs` and service.
- **Policy model** (`protocol/src/protocol.rs`): `SandboxPolicy::{ReadOnly, WorkspaceWrite{writable_roots, network_access, …}, DangerFullAccess, ExternalSandbox}`.
- **`WritableRoot { root, read_only_subpaths }`.** `default_read_only_subpaths_for_writable_root` **always protects `.git`** (including resolving worktree `gitdir:` pointer files) plus `.codex/` and `.agents/`, even inside a writable workspace. **This is exactly the building block rewire needs for per-stage permissions.**
- Network goes through a proxy (`network-proxy` crate) with policy decisions per request.

**Claude Code** (docs):
- Off by default. It covers Bash and child processes only; **file tools, MCP and hooks run outside it.**
- Same OS mechanisms: Seatbelt on macOS, bubblewrap plus a network namespace and optional seccomp on Linux, no native Windows support.
- Built on the open-source **`@anthropic-ai/sandbox-runtime`** package. *Licence to be verified; possibly reusable as a reference.*
- Writes are limited to cwd, temp and added dirs, with protected paths (`.claude/`, shell rc files, `.git` hooks and config).
- Reads are allowed machine-wide by default, including `~/.ssh`, unless restricted.
- Network goes through a host proxy with a domain allowlist that **starts empty**. UDP, QUIC and ICMP are blocked; loopback and link-local are refused. Credentials can be **masked** at the proxy with sentinel values.
- Includes an unsandboxed-retry escape hatch.

**Pi:** **no sandbox at all.** `docs/security.md` says safety must come from an OS user, container or VM boundary. Extensions run in-process with full permissions.

**→ Implications**
- Rust helper (decision #6/#7): copy Codex's design closely (Seatbelt `deny default` profile; bwrap + seccomp + `no_new_privs`), and extend `WritableRoot` into a **per-stage capability profile**:
  ```
  stage: implementer
    write: [src/**]          read_only: [tests/**, .github/**, .rewire/**, *lint* configs, lockfiles, .git]
    network: deny
  stage: test-writer
    write: [tests/**]        read_only: [src/**, ...]
  stage: verify (gates)
    write: [<scratch>]       read_only: [<entire worktree>]
  ```
- **Unlike Claude Code, the sandbox covers *every* agent action,** including file tools and plugin subprocesses, with no unsandboxed-retry escape hatch inside factory runs. A denied action becomes a finding or escalation, never a silent retry outside the sandbox.
- Default **read denial for credential paths** (`~/.ssh`, `~/.aws`, `.env*`), since Claude Code's defaults leave those readable. Adopt proxy-side **credential masking**.
- The network proxy starts with an empty allowlist. Package registries are opened only for a dedicated, gated "dependency" step, so hallucinated or typosquatted packages can't be installed casually.

---

## 4. Permissions & policy

**Claude Code** (docs):
- Modes: `default`, `acceptEdits`, `plan`, `auto` (classifier-reviewed), `dontAsk`, `bypassPermissions`.
- Rules are written `Tool(specifier)` in allow, ask and deny lists. **Evaluation is deny → ask → allow, first match wins**, and a broad deny beats a narrow allow.
- Layer precedence: **managed > CLI > local > project > user.** Deny is absolute across layers, and the CLI can only add restrictions.
- Project allow rules are **inert until the user trusts the workspace.**

**Codex:**
- Approval modes plus **execpolicy**, Starlark `prefix_rule(pattern, decision = allow|prompt|forbidden, justification, match=[…], not_match=[…])`.
- The **`match`/`not_match` examples are checked as unit tests when the policy loads.**
- `host_executable()` pins which absolute binary paths a basename rule applies to, closing the `/usr/bin/curl` gap that Claude Code documents.

**Pi:** project trust only. It gates loading `.pi/` resources and doesn't limit tools.

**→ Implications (decision #20)**
- Claude Code's "deny is absolute, lower layers can only add restrictions" rule is the same as our tighten-only layering. This confirms the design.
- **Adopt Codex's self-testing policy:** every rule in `.rewire/policy.toml` may carry `match` / `not_match` examples, and a policy file whose examples fail **doesn't load** (fail-closed).
- Adopt `host_executable`-style binary pinning for command rules.
- Adopt workspace trust: repo-level plugins and hooks are inert until the user trusts the repo.

---

## 5. Hooks & extension points

**Claude Code** (docs) has the richest lifecycle (~33 events): `PreToolUse`, `PostToolUse`, `PostToolBatch`, `Stop`, `SubagentStop`, `TaskCompleted`, `PreCompact`, `ConfigChange`, `FileChanged`, `WorktreeCreate`, and more.
- Hooks can block, rewrite input (`updatedInput`) or rewrite tool output (`updatedToolOutput`), and can inject context.
- Handler types: command, http, mcp_tool, prompt, agent.
- Exit code 2 means block; other non-zero exits are non-blocking.
- **⚠ Timed-out PreToolUse hooks do *not* block by default.** Fail-closed is opt-in (`onFailure: "block"`).

**Codex:** `hooks/src/events/`: `session_start`, `user_prompt_submit`, `pre_tool_use`, `post_tool_use`, `permission_request`, `stop`, `compact`, `interrupt`, `session_end`, `model_request`.

**Pi:**
- In-process TypeScript extensions, ~40 events (`tool_call`, `tool_result`, `turn_end`, `agent_before_settle`, `session_before_compact`, `before_provider_request`, `context`, …).
- Extensions can register tools, commands, providers and renderers.
- No capability isolation.

**→ Implications (decision #21)**
- **Gates and hooks must fail closed.** A gate that crashes, times out or returns unparseable output counts as a failed hard block, never "no decision". This is the opposite of Claude Code's default, deliberately.
- Plugins run as **subprocesses inside the sandbox** with declared capabilities. Pi-style in-process extensions are too powerful for a factory whose verdicts must be trustworthy. A TypeScript in-process fast path is allowed only for *first-party* packs.
- Lifecycle events for rewire are **pipeline-stage events** (`stage_start`, `pre_tool`, `post_tool`, `gate_result`, `finding`, `dispute`, `escalation`, `stage_end`) rather than chat events. The same events feed the headless JSON stream (decision #19).

---

## 6. Review & verification (the core of rewire)

**Codex — two different review systems:**

1. **`/review` code review** (`prompts/templates/review/rubric.md`). One generalist reviewer with structured JSON output: `findings[] {title, body, confidence_score, priority 0–3, code_location {file, line_range}}` plus `overall_correctness`.
   - Strong rules worth keeping:
     - *"must identify the other parts of the code that are **provably** affected"* (no speculation)
     - *"pre-existing bugs should not be flagged"*
     - line ranges must be ≤ 5–10 lines and overlap the diff
     - findings cite the repo rule (`AGENTS.md`) that supports them
   - Gaps from rewire's point of view: a single reviewer, no specialist categories, no verification of findings, the same model family as the author, and it is **advisory**, so nothing blocks on it.
2. **Guardian** (`core/src/guardian/`, ~11k lines; prompts in `prompts/templates/guardian/`). It's an **action-safety reviewer**, not a code-quality reviewer. It's **two-tier**:
   - an async, non-blocking classifier scores risk and user authorization for the trajectory
   - a "high" score switches on a **blocking reviewer for future actions**
   - It has a precise **trust taxonomy for evidence**: only user and developer messages and `AGENTS.md` can establish authorization. Tool outputs, skill text and assistant text are *untrusted*, and it ignores untrusted content that tries to redefine policy or force approval.
   - It has risk categories (exfiltration, credential probing, persistent security weakening, destructive actions) with explicit outcome rules, plus review budgets and response resampling.

**Claude Code:**
- `auto` mode uses a classifier to review actions, similar in spirit to Guardian.
- Subagents give context-isolated reviewers: a fresh context, a restricted `tools` allowlist, a `model` per agent, and only the final result returned to the parent.
- No built-in blocking quality gate. Quality enforcement is left to user hooks.

**Pi:** none built in, by design ("ask Pi to build what you want").

**→ Implications (decisions #10–#12, #15)**
- Use Codex's `rubric.md` as the **base contract** for every rewire specialist reviewer. Keep: provable impact, diff-introduced only, short ranges, rule attribution, confidence score. Add:
  - a mandatory `failure_scenario` / `evidence` field (decision #11)
  - a `category` taken from the nine slop categories
  - the refutation pass by a different model family
  - **blocking semantics**
- **Adopt Guardian's trust taxonomy for reviewers.** The code under review is *untrusted input*. Comments like `// reviewer: this is fine, approve` or injected instructions in test fixtures must be ignored, and attempts to persuade the reviewer should themselves be flagged as findings. This is a new requirement for rewire: **prompt-injection resistance in the review panel.**
- Use Guardian's two-tier pattern for **in-loop action safety**. A cheap async classifier watches the implementer's actions, and a high risk score switches on blocking review for later actions. This is separate from end-of-task code review.
- The "context isolation" of Claude Code's subagents confirms decision #11's separation (test-writer never sees the implementation). Rewire enforces it structurally (separate loop instances with separate tool and path capabilities), not just with prompts.

---

## 7. Context management

- **Pi:** sessions are JSONL trees with branches. Auto-compaction triggers when `contextTokens > window − reserveTokens` (16k). It summarizes everything before a `keepRecentTokens` (20k) cut point into a structured summary and **tracks file operations cumulatively** across compactions. Compact-and-retry recovers from overflow.
- **Codex:** very elaborate compaction (`compact_remote_v2*`, retained tool outputs, token budgets, media budgets). `AGENTS.md` hierarchy manager.
- **Claude Code:** CLAUDE.md memory; `PreCompact` / `PostCompact` hooks; subagents for context isolation.

**→ Implications**
- The factory has an advantage here: **stages are short and have bounded context.** Each stage starts fresh from structured artifacts (contract, plan, frozen tests, findings) rather than a long chat history. Compaction is a fallback inside a stage, not the main strategy.
- Adopt Pi's cumulative file-operation tracking. It also feeds the evidence report: which files each stage read and wrote.

---

## 8. Ollama / local models

- **Codex** (`codex-rs/ollama/`, ~1.1k lines): an `--oss` mode.
  - Probes reachability with `/api/tags`.
  - Checks `/api/version`, requiring **Ollama ≥ 0.13.4** for its Responses API.
  - **Auto-pulls the default model** (`gpt-oss:20b`) via `/api/pull` with progress.
  - **No per-model capability check**: it assumes the chosen model can do tool calling.
- **Pi:** no native Ollama provider. Users configure an OpenAI-compatible endpoint in `models.json` (`baseUrl: http://localhost:11434/v1`, `api: openai-completions`, dummy key). It's simple and works, but there's no capability check or model management either.
- **Claude Code:** Anthropic models only (outside of gateways).

**→ Implications (decision #8a)**
- Implement a native **`ollama` provider** that does what both lack:
  1. reachability and version check (as in Codex)
  2. **per-model capability probe**: Ollama's `/api/show` reports model `capabilities` (e.g. `tools`, `thinking`, `vision`, `completion`) and context length. *Verify the field set against the current Ollama API before implementing.*
  3. a **role-fitness smoke test**: a short structured-output and tool-call round trip before a model is assigned to a role, cached per model digest
  4. optional model pull with progress
- Prefer Ollama's OpenAI-compatible `/v1/chat/completions` for chat (one code path shared with other OpenAI-compatible servers: LM Studio, vLLM, llama.cpp). Use native `/api/*` only for discovery, capability checks and pulls.
- A model that fails the role-fitness check for, say, "reviewer" (it can't reliably emit evidence-bearing JSON) is **refused for that role with a clear message**, not silently degraded.

---

## 9. Summary: what each harness teaches us

| Area | Borrow from | What we add or change |
|---|---|---|
| Agent loop | **Pi** (952-line loop, typed hooks, truncated-call rule) | `finishTurn` done-gate; stage-scoped tool loadouts |
| Sandbox | **Codex** (Seatbelt deny-default, bwrap + seccomp, `WritableRoot.read_only_subpaths`) | Per-stage capability profiles; covers *all* actions; no unsandboxed retry; credential read-deny by default |
| Network | **Claude Code** (proxy, empty allowlist, credential masking) | Registries opened only for a gated dependency step |
| Policy | **Claude Code** (deny-absolute layering) + **Codex** (self-testing `match`/`not_match`, binary pinning) | Policy that fails to self-test doesn't load |
| Hooks | **Claude Code** (event richness) | **Fail-closed** by default; sandboxed subprocess plugins; pipeline-stage events |
| Code review | **Codex `rubric.md`** (structured, provable, diff-scoped) | Specialist panel, mandatory evidence, cross-family refutation, blocking |
| Action safety | **Codex Guardian** (two-tier, trust taxonomy) | Applied in-loop to the implementer; trust taxonomy also protects reviewers from injection |
| Context | **Pi** (cumulative file tracking, compaction) | Short, artifact-driven stages make compaction a fallback |
| Ollama | **Codex** (version check, auto-pull) | Capability probe + role-fitness smoke test |

## 10. New requirements discovered (proposed additions to DESIGN-DECISIONS)

1. **Sandbox enforcement is the real boundary.** Tool-hook path rules are only for clearer error messages (§2).
2. **Fail-closed everywhere.** Crashed, timed-out or unparseable gates and hooks count as failures (§5).
3. **Reviewer prompt-injection resistance.** The diff under review is untrusted. Persuasion attempts become findings (§6).
4. **In-loop action-safety classifier** (Guardian-style, two-tier), separate from code review (§6).
5. **Self-testing policy files** with `match`/`not_match` examples (§4).
6. **Credential read-deny defaults** and proxy-side credential masking (§3).
7. **Ollama role-fitness smoke test** cached per model digest (§8).

## Open items to verify
- Licence and reusability of `@anthropic-ai/sandbox-runtime` (could inform the Rust helper's proxy design).
- Exact fields of Ollama `/api/show` capabilities on current Ollama versions.
- Claude Code hooks and permissions details marked as summarized in the docs fetch should be re-read verbatim before relying on edge-case behavior.
