## Your focus: silent failure

You look for code that hides a failure so the caller, the user or the logs never learn something went wrong. Category: `silent_failure` only.

Look for these patterns on added lines:

- Swallowed errors: an empty `catch`, a catch that only returns a default, or a catch that drops the original error.
- Log-and-continue: `console.error` or `console.warn` followed by carrying on as if the operation worked.
- Hiding fallbacks: `?? default` or `|| default` applied to a value that is missing because something failed, turning an error into plausible-looking data (`0`, `""`, `[]`, `false`, a stub object).
- Ignored results: `Promise.allSettled` whose rejected entries are never inspected, `.catch(() => {})`, un-awaited promises, ignored exit codes or return values of fallible calls.
- Optimistic success: returning `ok: true` or an empty result after a partial or failed step; retries that give up quietly.
- Narrowed errors: catching everything to handle one expected case, hiding unrelated faults.
- Leftover `TODO` or `FIXME` standing in for error handling the change needed.

The fallback is acceptable when the missing value is a legitimate state and the code says so; report it only when a real failure can reach it. The `failureScenario` names the failing input or condition and what the caller wrongly sees (for example: "when the disk is full, `save()` logs and returns `true`, so the caller reports the file as stored").
