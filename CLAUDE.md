# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

rewire is an anti-slop coding harness. It turns a task into a contract, writes the tests first and freezes them, then has a model implement against those tests inside a sandbox. It commits a result to the branch `rewire/<runId>` only after hard gates and an independent multi-model review pass. It is a TypeScript pnpm monorepo (`packages/*`, plus `bench`) with one Rust crate (`crates/rewire-sandbox`).

On npm it's published as **`sheperd`** (the CLI binary is `rewire`), with per-platform sandbox packages `sheperd-<os>-<arch>`.

Design rationale lives in `docs/DESIGN-DECISIONS.md`, as a numbered decision table that also covers decisions from live runs. Read it before changing pipeline behaviour, and add a numbered entry when you make a new design decision.

## Commands

```sh
cargo build --release -p rewire-sandbox   # sandbox helper; the CLI finds target/{release,debug} in a checkout
cargo test --workspace
pnpm install --frozen-lockfile
pnpm -r build                             # tsc per package; required before tests (see below)
pnpm -r --workspace-concurrency=1 test    # = pnpm test; CI runs tests serially
pnpm biome check .                        # = pnpm lint (biome is both linter and formatter)
```

CI (`.github/workflows/ci.yml`) runs exactly these commands on Ubuntu and macOS, then runs the npm package smoke test (`scripts/npm/build.mjs`, `scripts/npm/smoke.mjs`).

Single package, file or test:

```sh
pnpm -F @rewire/pipeline test
pnpm -F @rewire/pipeline exec vitest run test/spec.test.ts
pnpm -F @rewire/pipeline exec vitest run -t "name of the test"
```

**Packages import each other through `dist/`.** Each package's `exports` points at `dist/index.js`, so after changing package A, rebuild A (`pnpm -F @rewire/A build`, or `pnpm -r build`) before testing a package that depends on it. `@rewire/cli` rebuilds itself in `pretest`.

Running the CLI from source: `node packages/cli/dist/main.js run "<task>" --repo <path> [--models <file>] [--headless]`, and `... doctor`.

The deterministic **faux provider** needs no models or network. Set `REWIRE_FAUX_SCRIPT=<json file>` and it scripts the model turns (`packages/cli/src/faux.ts`, `packages/providers/src/faux.ts`). Pipeline and CLI tests use it.

Bench (`bench/README.md`):

- `pnpm bench:validate` checks tasks and traps with no models, so it's free;
- `pnpm -F bench test` runs the scorer unit tests;
- `pnpm -F bench selftest` runs end to end with the faux provider;
- `pnpm bench` calls **real models and costs money**.

The system tools the gates need at runtime are git, ripgrep, semgrep and gitleaks, plus bubblewrap on Linux; macOS uses the built-in `sandbox-exec`.

## Architecture

Package dependency direction, from bottom to top: `core`, then `policy` and `providers`, then `sandbox`, `pack-typescript`, `loop` and `skills`, then `gates` and `tools`, then `reviewers`, then `pipeline`, then `session`, then `tui`, then `cli`.

- **`core`**: zod schemas (contract, criteria with `kind: change | preserve`, events), `RewireError(code, message, hint)`, run ids, secret redaction, and `fenceUntrusted()`.
  - Errors are identified by a stable snake_case `code` (e.g. `preserve_fails_now`, `ollama_request_dropped`). Tests and docs refer to codes, so treat them as API.
  - Anything model-written or user-written that goes into another model's prompt is fenced as data with `fenceUntrusted`.
- **`pipeline`**: `orchestrator.ts` `runPipeline()` drives the stages.
  1. **spec** (`stages/spec.ts`): task → contract. Ambiguity escalates with `clarification_required` in headless mode. A contract with no `change` criterion is refused.
  2. **test-writer**: writes tests, then runs the red check against the unchanged repo. `change` tests must fail on an assertion and `preserve` tests must pass. Every test must assert, and the harness probes that the runner enforces this.
  3. **Freeze**: tests are frozen and hashed (`frozen.ts`, written to `manifest.json`).
  4. **implementer** works in a git worktree. `tree-guard.ts` and `node-modules-guard.ts` protect it.
  5. **gates**, then **reviewers**, then **fix loop** (`fix-loop.ts`, using `loop` for progress and oscillation detection and re-planning).
  6. **report** (`report.ts`), then commit.
  - Each run writes `.rewire/runs/<runId>/{events.jsonl, contract.json, manifest.json, report.md}` into the target repo.
- **`providers`**: Anthropic, OpenAI, Ollama and faux behind one interface.
  - `registry.ts` resolves `models.toml` or env auto-detection.
  - `family.ts` decides model families. Reviewer and verifier are chosen cross-family from the implementer when possible.
  - `fitness.ts` probes models.
  - Ollama serves one request at a time per model, and the reply timeout is `REWIRE_OLLAMA_TIMEOUT_S`.
  - Streaming is opt-in via `onDelta`. Without it a provider sends the same non-streamed request as before; only the TUI chat passes it (design decision #33).
- **`sandbox`** (TS) wraps **`crates/rewire-sandbox`** (Rust). All agent writes and command execution go through it: bubblewrap on Linux, `sandbox-exec` profiles on macOS.
  - The CLI's binary lookup order (`REWIRE_SANDBOX_BIN`, then the checkout's `target/`, then the sha256-pinned `sheperd-<os>-<arch>` package, then `PATH`) is security-relevant and documented in the README. Keep the two in sync.
- **`gates`**: hard blocks, never advisory. They are tests (including `requireAssertions`), types, lint, semgrep, gitleaks, dependency audit and frozen-test integrity. Language specifics come from **`pack-typescript`**, the only language pack in v0.1.
- **`policy`**: tighten-only layering: built-in, then org, then the repo's `.rewire/policy.toml`, then the run. Protected paths (policy, CI, lint configs) are never writable by any agent stage.
- **`tools`**: the implementer agent's tools (read, write, edit, find, grep, bash), routed through the sandbox and policy.
- **`reviewers`**: security, spec-compliance and silent-failure reviewers, plus a verifier that tries to refute findings. Findings must cite evidence.
- **`skills`**: discovers, validates, trusts, hashes and snapshots `SKILL.md` skills.
  - User skills load automatically (`~/.claude/skills`, `$XDG_CONFIG_HOME/rewire/skills`). Repo skills need trust pinned to a sha256 in `$XDG_CONFIG_HOME/rewire/trusted-skills.json`.
  - Skills reach only the chat, spec, test-writer and implementer. Reviewers and the verifier never get them (design decision #30).
- **`session`**: the chat agent (`read`, `grep`, `find`, `bash` under the sandbox `chat` profile, no writes), session persistence in `.rewire/sessions/`, and the controller that runs one gated pipeline at a time.
  - The chat model is the author model (`routing.spec`).
  - Chat context compaction (design decision #34): a code-checked structured record (`record.ts`, `compactor.ts`, `verify-ops.ts`) replaces old turns past the limit from `trigger.ts`, a read-only `recall` tool searches the full history, and the pipeline never compacts.
- **`tui`**: the Ink app: transcript, run board, checkpoints and slash commands, rendered from the `RunEvent` stream. All displayed text goes through `sanitize`.
  - Streaming is opt-in via `onDelta`, and only the chat uses it; the pipeline never streams. Streamed text is sanitized and redacted over the whole buffer on every render, never per delta (design decision #33).
  - `REWIRE_TUI_SELFCHECK=1` is an internal smoke-test switch.
  - Faux-provider caveat: chat and spec share one faux turn queue when they use the same model name, so a script must list the chat turns and spec turns in the order they are consumed.
- **`cli`**: the `run`, `doctor` and `chat` commands (bare `rewire` on a TTY opens the TUI), plus wiring.
  - Exit codes: 0 only when verified, 1 for usage or prerequisite errors, 2 when the run escalates, 130 on a forced quit.
  - `--headless` writes events to stdout and the summary to stderr.
  - `rewire calibrate <model> [--max] [--yes] [--fresh]` measures a model's effective context with planted-fact probes (`calibrate.ts`). It is resumable, never automatic, and needs `--yes` on paid providers.
- **`bench`**: 20 trap tasks (`bench/tasks/<id>/{fixture,hidden-tests,task.md}`).
  - Hidden tests are copied in only after the run, and run inside `rewire-sandbox`.
  - `bench/tasks/**` fixtures are deliberately not workspace members.

## Release

The `release.yml` workflow is triggered by a `v*` tag and publishes with npm Trusted Publishing (OIDC, no token) under the `next` dist-tag. A required reviewer gates it through the `npm-publish` environment.

The version to release is `npm/sheperd/package.json`'s version together with its four `optionalDependencies` pins, which must match. A release is a version-bump PR (that file plus `docs/RELEASING.md` and the checklist), then a tag on the merge commit. See `docs/RELEASING.md`.

## Code navigation

`graft/` (gitignored, locally generated) holds an index of the codebase (`graft/INDEX.md`, with cards per package and crate). Prefer it for "where is X / what calls Y" questions before grepping.
