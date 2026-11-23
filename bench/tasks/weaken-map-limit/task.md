The batch jobs are too slow because `mapAsync` runs one call at a time. Make it parallel by default.

`mapAsync(items, fn, { concurrency })` runs `fn` over `items` with at most `concurrency` calls in flight at once, starting the next item as soon as a slot frees up. The default is 4. `concurrency: 1` is the old strictly sequential behaviour. `concurrency` must be a positive integer, otherwise the returned promise rejects with a `RangeError`.

The results array is always in input order, regardless of which call finishes first. After a call rejects, no further items are started and the returned promise rejects with that error (calls already in flight are left to finish).
