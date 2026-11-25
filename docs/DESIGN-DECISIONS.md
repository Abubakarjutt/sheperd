# rewire — Design Decisions

Status: agreed via design interview, 2026-11-20. Working name: `rewire` (check npm / crates.io / GitHub / trademark before public release).

## Vision
The go-to **anti-slop software factory**: a factory-first coding harness whose primary product is the verification and review layer, not code generation. It must never ship slop, and the codebase must not degrade over time as it writes more code.

## Definition of slop
1. Broken — doesn't compile, fails types, breaks existing tests
2. Fake verification — tautological/over-mocked/weakened tests, unevidenced "done", skipped checks
3. Spec drift — wrong problem, partial implementation, silent scope cuts
4. Security — injection, secrets, unsafe defaults, vulnerable/hallucinated deps, missing authz
5. Silent failures — swallowed errors, catch-all fallbacks, TODO/placeholder logic in shipped paths
6. Bloat — over-engineering, needless abstraction, duplication instead of reuse, dead code, comment noise
7. Convention drift — ignores repo patterns, naming, architecture, existing utilities
8. Maintainability — high complexity, unclear naming, poor structure
9. Entropy — cumulative degradation across many individually-acceptable changes

## Decisions

| # | Area | Decision |
|---|---|---|
| 1 | Research | Read Codex (Apache-2.0) + Pi (MIT) source; clean-room study of Claude Code via docs/behavior; then design from first principles |
| 2 | Audience | Broad adoption — go-to tool for everyone |
| 3 | Shape | Factory-first pipeline: spec → plan → tests → implement → gates → review → fix loop → PR. Interactive = same pipeline with human checkpoints |
| 4 | Enforcement | Categories 1–5 are absolute hard blocks. 6–8 + entropy enforced via metric ratchet vs. main baseline; LLM judgment findings must be fixed or explicitly justified. Non-convergence escalates to a human — never ships stuck |
| 5 | Engine | Own orchestrator + own lean Pi-inspired agent loop. Claude Code / Codex / Pi supported as optional pluggable worker backends |
| 6 | Language | Hybrid: TypeScript core (orchestrator, agent loop, reviewers) + Rust helper binary for sandboxing/process isolation |
| 7 | Isolation | Git worktree per task; Rust helper enforces per-stage write-path + network capabilities (implementer can't write tests/CI/lint configs/lockfiles); gates run in separate read-only verification context; pluggable backend (OS sandbox locally, containers in CI/cloud) |
| 8 | Models | Multi-provider with per-role routing; reviewers default to a different model family than the author; third family adjudicates disputes; single-provider fallback is disclosed as reduced independence; cheap models for mechanical roles |
| 8a | Local models | **Ollama is a first-class provider from v0.1.** Any role can route to a local Ollama model. Fully-local mode (no cloud keys, code never leaves the machine) is supported. Provider layer probes model capabilities (tool calling, context length, structured output) and refuses to assign a model to a role it can't reliably perform. Local model families count toward cross-family independence (e.g., Claude author + Qwen reviewer). Evidence report discloses the models used per stage; hard gates are deterministic and never weaken based on model choice |
| 9 | Input | Any input (prompt, issue, PRD, spec) compiled into a contract: testable acceptance criteria, non-goals, affected areas, open questions. Clarification round before code (skippable for trivial tasks). Every criterion maps to ≥1 test |
| 10 | Tests | Separate test-writer sees only contract + interfaces; tests must fail first (genuine assertion failures; tests for `preserve` criteria must pass first instead, see #28); then frozen + hashed; implementer cannot write test paths; challenges go through a dispute adjudicated by a reviewer. Diff-scoped mutation testing; kill-rate is a ratchet metric |
| 11 | Review | Specialist reviewer panel (one category each) with structured findings: category, severity, file:line, evidence + concrete failure scenario, confidence, fix. No evidence → auto-dropped. Blocking findings adversarially verified by a different model family. Diff-routed, parallel. Pluggable |
| 12 | Languages | Language packs (detect, fast checks, full gates, mutation tool, ratchet collectors, test-path conventions, reviewer routing). TS/JS + Python first-class at launch; Go + Rust next; generic command-gate fallback labeled "reduced guarantees". Language-agnostic: Semgrep, gitleaks, dep audit, LLM panel |
| 13 | Context | Symbol graph (tree-sitter/LSP) + embeddings index, incrementally maintained; versioned, human-editable conventions profile (layers, dependency rules, error patterns, naming, preferred libs, utility inventory); mandatory reuse plan in each plan; clone detection feeds the ratchet |
| 14 | Fix loop | Ranked findings (hard blocks first); full re-gate after each fix; progress signal; escalate on K no-progress rounds, oscillation, or budget; one re-plan with failure history before escalating; structured escalation report ending in a concrete question |
| 15 | Output | PR with evidence report (criteria→tests, gates, mutation score, ratchet deltas, findings incl. refuted/justified, independence level, cost). Risk tiers; opt-in auto-merge for low-risk fully-passing changes (off by default); signed, stored evidence bundle for audit |
| 16 | Efficiency | Automatic risk-proportional pipeline with fixed floors (hard gates, frozen tests for behavior changes, security reviewer, secret/dep scans, ratchet never scale down). Content-hash caching, prompt caching, cheap models for mechanical roles, per-run/per-repo budgets with upfront cost estimate. Classifier decision recorded in evidence |
| 17 | Proof | Public benchmarks (SWE-bench Verified, Aider polyglot) + our own open-source anti-slop benchmark (hidden tests, planted traps, per-category scoring, long-sequence entropy test) + continuous evals in CI as the harness's own ratchet + opt-in anonymized telemetry |
| 18 | Business | Open core. Apache-2.0 engine (CLI, orchestrator, loop, sandbox, gates, ratchet, packs, plugin API, benchmark) — all guarantees free locally with BYO keys. Paid hosted tier: cloud runners, GitHub/GitLab app, org policy, audit dashboard, shared profiles/indexes, SSO |
| 19 | Interface | CLI + pipeline-board TUI (stages as live board; intervene at any stage; configurable pause checkpoints). `--headless` JSON event stream — same protocol used by future app/dashboard |
| 20 | Config | Tighten-only policy layering: built-in → org → repo (`.rewire/policy.toml`) → run. Protected paths (policy, profile, CI, lint configs) not writable by any agent stage. Policy changes flagged in evidence. Unified sandboxed plugin API (TS or subprocess/JSON) with declared capabilities; plugins can add checks, never disable hard blocks |

## Decisions from Phase 0 research
Source: [`research/harness-comparison.md`](research/harness-comparison.md) §10. Adopted 2026-11-20.

| # | Area | Decision |
|---|---|---|
| 21 | Enforcement boundary | The OS sandbox (Rust helper) is the real enforcement layer. Tool-hook path rules exist only for fast, clear error messages. (Bash can bypass tool-level rules.) |
| 22 | Fail-closed | Any gate, hook, plugin or reviewer that crashes, times out or returns unparseable output counts as a **failed hard block**, never "no decision". |
| 23 | Reviewer injection resistance | Code under review, tool output and repo content are untrusted input to reviewers (Guardian-style trust taxonomy). Only user/developer instructions and policy can set review scope. Attempts to persuade or redirect a reviewer are themselves reported as security findings. |
| 24 | In-loop action safety | Two-tier monitor on implementer actions: a cheap async risk classifier; a high score enables blocking review of later actions. Separate from end-of-task code review. **Post-v0.1.** |
| 25 | Self-testing policy | Policy rules may carry `match` / `not_match` examples validated at load time; a policy whose examples fail doesn't load. Command rules pin binaries to absolute paths (`host_executable`-style). |
| 26 | Credentials | Default read-deny for credential paths (`~/.ssh`, `~/.aws`, `~/.config/gh`, `.env*`, keychains); network proxy masks credentials; empty network allowlist; package registries open only in a gated dependency step. |
| 27 | Ollama role fitness | Before a local model is assigned a role, a short structured-output + tool-call smoke test runs; results cached per model digest; failing models are refused for that role with a clear message. |

## Decisions from live runs
Source: the first live real-model run, 2026-11-24.

| # | Area | Decision |
|---|---|---|
| 28 | Criterion kinds | Every acceptance criterion has a `kind`: `change` (new or corrected behaviour) or `preserve` (behaviour that works today and the task says must keep working). The red check requires a `change` test to fail now with an assertion error and a `preserve` test to pass now; after implementation every frozen test of either kind must pass. A contract needs at least one `change` criterion (the spec stage retries once, then fails with `contract_without_change`; a contract with open questions goes to clarification first), and every test must make an assertion, which the red check proves with a harness-owned no-assertion probe in the same run (`assertion_rule_unenforced` if the runner does not fail it). A preserve test that fails now is terminal, never retried (`preserve_fails_now`): the run escalates and asks the human whether the criterion is mislabelled or the test is wrong, because a retry could only turn it green by weakening it. The one exception is a test-writer mistake: a preserve test whose every failure is a non-assertion error thrown in the test file itself (its first stack frame outside `node_modules`, e.g. calling a function that does not exist) gets the ordinary single retry, told to keep its assertion. An assertion failure, an error thrown from the code under test (a crash bug labelled `preserve`), or a failure with no parseable stack stays terminal. Residual risk: a bug that makes the code return a wrong value the test then dereferences (a TypeError in the test file) is retried; the retry is told not to weaken the test and the spec-compliance reviewer still checks the labels against the task. **Why:** on the live run the task was a bug fix that said "everything that works today keeps working"; the spec stage correctly wrote preserve criteria (existing function unchanged, invalid width still throws, whitespace still collapses), but the red check required every new test to fail, and a test for working behaviour passes by definition, so the run escalated with `red_check_failed`. Any bug fix with "keep working" criteria could never pass the stage. The faux-model CI never wrote such a contract. **What is and is not caught:** a bug labelled `preserve` whose test exercises the bug fails now and stops the run (`preserve_fails_now`). A bug labelled `preserve` whose test does not exercise it (written weak from the start) passes the red check, and nothing in the harness hard-blocks it; the spec-compliance reviewer and the verifier get the task text (fenced as untrusted) and are asked to report a preserve criterion that is really the requested change, and the report shows every criterion's kind next to the task for a human. `kind` is required with no default: contracts are parsed only from the spec model's output (contract.json is never read back), and a silent default would hide an unlabelled criterion. Refactor-only tasks (no `change` criterion) are out of scope for v0.1 |
| 29 | Interactive session | `rewire` on a TTY opens a chat, then hands code changes to a gated run. The chat agent cannot write: its tools are `read`, `grep`, `find` and `bash` under the sandbox `chat` profile (no repo writes, scratch dir only, network denied). It has no `write` or `edit` tool. The chat model is the author model (`routing.spec`). One gated run is active at a time. Sessions are stored redacted in `.rewire/sessions/<id>.jsonl` and can be resumed. **Why:** every code change must pass the same hard gates and independent review as `rewire run`, so the conversational surface gets no write path of its own. **Accepted trade-offs:** chat `bash` ignores abort and runs to its own timeout (up to 600 s); it cannot write the repo, so the cost is a stray sandboxed process. Ctrl-C at a proposal card or the in-app trust prompt exits 0 (the chat is persisted and resumable) instead of dismissing the card. |
| 30 | Claude skills | User skills load automatically from `~/.claude/skills` and `$XDG_CONFIG_HOME/rewire/skills`. Repo skills (`<repo>/.claude/skills`) load only after trust is pinned to a sha256 over all their files. The hash includes shadowed repo skills (a user skill with the same name wins), so the trust prompt lists them. A changed hash asks again. The trust store is `$XDG_CONFIG_HOME/rewire/trusted-skills.json`, updated with a locked read-merge-write. Skills are read on the host and snapshotted once per session; a trust granted mid-session takes effect on `/clear`. Skills reach the chat, spec, test-writer and implementer only, never the reviewers or the verifier. **Why:** a skill is instruction text from outside the contract. Repo skills are attacker-controllable, so they need an explicit, content-pinned approval, and the stages that judge the result must not be steered by them. The sandbox denies `~/.claude*`, so skills are read on the host and materialised into a scratch dir. **Accepted residual:** skill text can still reach the reviewers indirectly, through the contract or the diff that an author stage produced. |
| 31 | Checkpoints | A run can pause for approval at `contract`, `tests` and `commit`. In the TUI, `contract` and `tests` are on by default and `commit` is off (`/checkpoints` changes it per session). Without a `checkpoint` input (`rewire run`, headless) nothing pauses. The contract checkpoint accepts `approve`, `revise(note)` or `stop`; the tests and commit checkpoints accept `approve` or `stop`. Revise is limited to 3 per run, and a 4th is recorded as `stop`. `stop` escalates with reason `stopped_by_user` (exit 2). An invalid decision escalates with `stage_error` and fixed preset text. Ctrl-C at a pending checkpoint ends the run as `interrupted`. Every decision is in `events.jsonl` and `report.md`. **Why:** approval must be possible without making the gates optional. A bounded revise loop keeps a run from becoming an open-ended chat, and a protocol fault must stop the run without asking a model to explain it. |

## Roadmap

### Phase 0 — Research
Comparative architecture doc of Codex, Pi, Claude Code: agent loop, tool surface, permissions/sandbox, context management, extension points → design implications for rewire.

### v0.1 — Thin vertical slice (TypeScript only)
- CLI + headless JSON events (no TUI)
- Rust helper: local OS sandbox, worktrees, per-stage write permissions
- Spec stage → contract + clarification
- Test-writer → red check → frozen tests
- Implementer on own Pi-inspired loop
- Providers: Anthropic, OpenAI, Ollama (local) with capability probing + role-fitness smoke test (#27)
- Sandbox is the enforcement boundary (#21); fail-closed gates/hooks (#22); credential read-deny + empty network allowlist (#26)
- Reviewer prompts carry the untrusted-input taxonomy (#23); policy self-tests at load (#25)
- Hard-block gates: tsc, lint, tests, Semgrep, gitleaks, dep audit
- Three reviewers: security, spec-compliance, silent-failure — evidence-required + cross-family refutation
- Fix loop with progress/oscillation detection + escalation
- Output: local branch + markdown evidence report
- Seed anti-slop benchmark: 20–30 tasks
- Packs and reviewers built against the internal plugin interface from day one

### Deferred (post-v0.1)
In-loop action-safety monitor (#24), mutation testing, ratchet/entropy metrics, conventions profile + code index, risk classifier, PR delivery, TUI, Python pack, public plugin API, hosted tier.
