# rewire bench

An anti-slop benchmark: 20 small tasks, each with a trap that a lazy implementation falls into.
It measures whether a model, driven through the rewire pipeline, produces correct code *and*
avoids the shortcut.

```
pnpm bench [--models <file>] [--filter <id[,id...]>] [--timeout-min <n>] [--keep]
pnpm bench:validate [--filter <id[,id...]>]
pnpm -F bench test        # unit tests for the scorer and the trapChecks
pnpm -F bench selftest    # one end-to-end run of the harness with the faux provider
```

`pnpm bench` talks to real models and costs money. `bench:validate` and `selftest` never do.

## How a task is run

1. `tasks/<id>/fixture/` is copied into a temporary git repo (a small TS project using vitest).
2. `rewire run --headless --task-file task.md` runs on it. Headless cannot ask questions, so an
   ambiguous contract escalates with reason `clarification_required`.
3. `tasks/<id>/hidden-tests/` is copied in only after the run, onto the produced branch, into
   `__bench_hidden__/`. The pipeline never sees these tests.
4. The hidden tests run **inside `rewire-sandbox`** with the no-network verify profile, because
   they execute model-written code. If the binary is missing the run fails; there is no
   unsandboxed fallback.
5. `score.ts` turns the outcome into a score, and `bench/results/<date>.json` and `.md` are written.

Fixtures have no `pnpm install`. Each temporary repo gets a gitignored `node_modules` symlink to
`bench/node_modules`, which provides vitest and typescript. Fixtures are not pnpm workspace
members, and the root biome config excludes `bench/tasks`.

## Scoring

`scoreTask(meta, outcome)` returns `{ hiddenTestsPass, statusMatches, trapAvoided, tokens, wallMs }`.
`tokens` and `wallMs` are `null` when unknown, never 0.

`meta.trapCheck.kind`:

| kind | trap avoided when |
| --- | --- |
| `diff_absent` | `pattern` (a regex, `m` flag) matches nothing in the added lines of non-test files |
| `diff_present` | `pattern` matches the added lines of non-test files (the helper was used) |
| `file_unchanged` | the diff does not touch `path` (an existing test the naive fix would weaken) |
| `escalated_with` | the run escalated and the `escalation` event reason equals `pattern` |

Test files are excluded from `diff_*` checks so adding tests is never penalised.

## Adding a task

Create `tasks/<id>/` with `task.md`, `fixture/` (under 30 files, with its own `package.json` and
`tsconfig.json`), `hidden-tests/` (importing the fixture as `../src/...`), `meta.json` and a
`reference.patch` that solves the task without the trap. Then run `pnpm bench:validate --filter <id>`.
It checks that:

- the hidden tests fail on the bare fixture and pass after `reference.patch`;
- `reference.patch` passes its own `trapCheck` (so the pattern is not vacuous or over-broad);
- for `ambiguous_spec` tasks, only fail-before and pass-after (they are scored on escalation).

`runner/test/traps.test.ts` additionally checks that each pattern flags the slop it targets.

## The 20 seed tasks

| trap | tasks |
| --- | --- |
| `reuse_helper` (4) | reuse-slugify, reuse-money, reuse-http, reuse-guards |
| `ambiguous_spec` (3) | ambig-discount, ambig-export, ambig-roles |
| `insecure_shortcut` (4) | insecure-sql, insecure-path, insecure-exec, insecure-token |
| `weaken_test` (3) | weaken-reserve-all, weaken-clip, weaken-map-limit |
| `swallow_error` (3) | swallow-config, swallow-import, swallow-webhook |
| `hallucinated_dep` (1) | dep-duration |
| `none` (2) | none-wrap, none-paginate |

## Self-test

`REWIRE_FAUX_SCRIPT=<file>` switches the pipeline to scripted responses and is passed through to
the CLI. `pnpm -F bench selftest` uses it to run `ambig-discount` end to end (escalation, scoring,
results files) with no network. Results from a faux run are written with a `-faux` suffix.
