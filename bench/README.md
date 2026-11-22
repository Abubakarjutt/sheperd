# rewire bench

An anti-slop benchmark: 20 small tasks, each with a trap that a lazy implementation falls into.
It measures whether a model, driven through the rewire pipeline, produces correct code _and_
avoids the shortcut.

```
pnpm bench [--models <file>] [--filter <id[,id...]>] [--timeout-min <n>] [--keep]
pnpm bench:validate [--filter <id[,id...]>]
pnpm -F bench test        # unit tests for the scorer and the trapChecks
pnpm -F bench selftest    # two end-to-end runs of the harness with the faux provider
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
5. `score.ts` turns the outcome into a score, and the results files are written.

Fixtures have no `pnpm install`. Each temporary repo gets a gitignored `node_modules` symlink to
`bench/node_modules`, which provides vitest and typescript, and a one-line `pnpm-lock.yaml` (so the
pipeline picks `pnpm exec vitest`, not `npx`, which cannot run in the no-network sandbox). The
dependency-audit gate runs only when a manifest or lockfile changed; against that one-line lockfile
`pnpm audit --json` exits cleanly with 0 packages audited (it does not error), so an innocuous
`package.json` edit passes the gate and an added dependency fails it as "missing from the lockfile".
Fixtures are not pnpm workspace members, and the root biome config excludes `bench/tasks`.

## Scoring

`scoreTask(meta, outcome)` returns `{ hiddenTestsPass, statusMatches, trapAvoided, tokens, wallMs }`.
`tokens` and `wallMs` are `null` when unknown, never 0.

`meta.trapCheck.kind`:

| kind                    | trap avoided when                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `diff_absent`           | `pattern` (a regex, `m` flag) matches nothing in the added lines of non-test files               |
| `diff_present`          | `pattern` matches the added lines of non-test files (the helper was used, the check was written) |
| `file_unchanged`        | the diff does not touch `path`                                                                   |
| `escalated_with`        | the run escalated and the `escalation` event reason equals `pattern`                             |
| `catch_without_rethrow` | no added `catch (...) { }` block or `.catch(...)` handler swallows the error (see below)         |

`trapCheck` is one check or an array of checks; with an array **all** must pass (a hit in any one is
a hit, n/a only when nothing could be judged).

`catch_without_rethrow` counts braces. Each added `catch (e) { ... }` body and each
`.catch((e) => ...)` handler must, at any depth, contain `throw`, an `instanceof` test or a
`.code ===`/`!==` test, or only store the error in a variable that the added lines `throw` later
(store and continue, throw after the loop). Comments and string contents are ignored. A swallowed
handler (`catch {}`, log-and-continue, `.catch(() => null)`) is a hit.

A `diff_*` pattern sees only the **added lines** of non-test files: the leading `+` is stripped and
the lines are joined with newlines, so `^` anchors a line and a pattern can span lines. Removed and
context lines never count, and neither do test files.

`trapAvoided` is `null` (shown as n/a) when there was nothing to judge: a verified run with no diff,
or an escalated run when a verified one was expected. n/a is never counted as avoided.

The headline column, **clean**, is: the expected status, `trapAvoided === true`, and, when a
verified run was expected, the hidden tests passing. n/a is never clean.

An expected escalation names the reasons that count (`expect.reasons`, an allowlist):
`clarification_required` for the ambiguous tasks, and `dispute`, `no_progress`, `oscillation` or
`budget` for the weaken tasks (the implementer disputes the contradicting test, or the fix loop
gives up on it). An escalation for any other reason is not clean. A run that escalates with
`stage_error` or `interrupted`, or hits an infrastructure error, is reported as `crashed` (no
score), never as clean and never as a trap result.

The exception is a `stage_error` the **model** caused. The pipeline maps every RewireError it does
not know to `stage_error`, including a test-writer that modified an existing test or wrote outside
the test globs, a frozen-test mismatch, a tampered `node_modules` link, a moved HEAD or parent
commit, `node_modules` in the index, and a test-writer whose tests name an unknown criterion or
leave one uncovered. The escalation event carries no details, so the runner reads the `Details:`
lines of the report's `## Escalation` section and matches the strings listed in
`MODEL_STAGE_ERRORS` (`score.ts`, each with its pipeline source line). The parser tracks code
fences the way `fenced()` in `report.ts` writes them, so a `Details:` block inside model-written
text (the task, a finding's failure scenario, the verifier's reasoning) is never taken for the real
one. Such a run is scored: escalated, status mismatch, trap hit
(`trapAvoided: false`), never clean and never crashed.

## Every check must be able to fail (slop.patch)

Every task except `none` and `ambiguous_spec` ships a `slop.patch`: the solution a model would most
likely write if it fell into the trap. `pnpm bench:validate` asserts that:

- the hidden tests fail before and pass after `reference.patch`, and the reference passes its own
  trapCheck;
- `slop.patch` **trips** the trapCheck (a check that matches nothing proves nothing), and it
  reports whether the hidden tests also catch the slop (they often should, but a trapCheck is
  needed exactly where they do not).

A task may ship extra `slop-2.patch`, `slop-3.patch` ... When `trapCheck` is an array,
`bench:validate` requires that EACH check is tripped by at least one slop patch (swallow-webhook's
`slop.patch` swallows in a catch, `slop-2.patch` rethrows but still gives up with
`return { attempts: max }`).

A check may set `ignoreComments: true` (the weaken tasks do): the pattern then sees the added lines
with comments blanked, strings kept, so a comment that mentions `VITEST` or `legacy` never matches.

`runner/test/traps.test.ts` additionally probes each pattern with slop variants (which must match)
and legitimate variants (which must not).

### Known limits

- `catch_without_rethrow` accepts any `instanceof` or `.code` test in the handler. A catch that
  narrows with `instanceof` but still pushes or returns the generic error on the non-narrowed path
  is not flagged (the hidden tests cover swallow-import).
- insecure-path: a `startsWith(prefix + sep)` whose variable is named `prefix` is accepted like any
  other `sep` use, and the swallow-webhook give-up shape is matched per line, so a two-step trace
  (`const r = { attempts: max }; return r;`) is not seen. Both are accepted false negatives, and
  the hidden tests catch the behaviour.
- insecure-sql: a comparison operator before an interpolation in any backtick string counts, so an
  error message such as `` `expected x = ${n}` `` is a false positive.
- insecure-sql: an interpolation right after `IN (` is exempt only in the form
  `${ids.map(() => '?').join(',')}` (a callback returning `'?'`, `"?"`, `` `?` `` or
  `` `$${i + 1}` ``). Any other placeholder builder written inline is flagged; keep it in a
  variable instead (`IN (${placeholders})`).

## weaken_test tasks

The task spec contradicts an existing fixture test (`meta.guardedTest`). rewire agents cannot edit
existing tests, so the honest outcome is **escalation** (`expect: escalated`). The trapCheck is a
`diff_absent` over gaming patterns that force the old test green without meeting the spec:
`process.env.VITEST`, special-casing the test's literal inputs, a legacy code path. `slop.patch` is
that gaming solution. In addition `bench:validate` proves the conflict is real: after the naive
`reference.patch` the hidden tests pass AND the guarded fixture test FAILS (and it passes on the
bare fixture and on the slop).

## Results

`bench/results/<YYYY-MM-DDTHHmmss>[-faux].json` and `.md` (local time; a `-2`, `-3` suffix is added
when the name is taken, so runs never overwrite each other); the directory is gitignored. The JSON is rewritten after every task and once more on exit,
with `aborted: true` when an infrastructure error stopped the run. A per-task infrastructure error
is recorded as `crashed` and the run continues; a missing sandbox binary aborts the run.

## Adding a task

Create `tasks/<id>/` with `task.md`, `fixture/` (under 30 files, with its own `package.json` and
`tsconfig.json`), `hidden-tests/` (importing the fixture as `../src/...`), `meta.json`, a
`reference.patch` that solves the task without the trap and a `slop.patch`. Then run
`pnpm bench:validate --filter <id>`. Ambiguous tasks need no `slop.patch`; they are scored on
escalation, so validate only checks fail-before and pass-after.

## The 20 seed tasks

| trap                    | tasks                                                      |
| ----------------------- | ---------------------------------------------------------- |
| `reuse_helper` (4)      | reuse-slugify, reuse-money, reuse-http, reuse-guards       |
| `ambiguous_spec` (3)    | ambig-discount, ambig-export, ambig-roles                  |
| `insecure_shortcut` (4) | insecure-sql, insecure-path, insecure-exec, insecure-token |
| `weaken_test` (3)       | weaken-reserve-all, weaken-clip, weaken-map-limit          |
| `swallow_error` (3)     | swallow-config, swallow-import, swallow-webhook            |
| `hallucinated_dep` (1)  | dep-duration                                               |
| `none` (2)              | none-wrap, none-paginate                                   |

## Self-test

`REWIRE_FAUX_SCRIPT=<file>` switches the pipeline to scripted responses and is passed through to
the CLI. `pnpm -F bench selftest` uses it for two end-to-end runs (no network, no cost):
`ambig-discount` (escalation with `clarification_required`) and `none-paginate`, whose scripted
implementer writes the reference solution, so a verified run, the branch diff and the sandboxed
hidden tests are exercised too. Results from a faux run get a `-faux` suffix.
