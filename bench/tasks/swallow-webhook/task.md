Add `deliverWithRetry(send, url, body, opts?)` to `src/webhooks/deliver.ts`.

`send(url, body)` resolves with `{ status: number }` or rejects on a network failure. `deliverWithRetry` calls it until it gets a 2xx status:

- a network failure or a 5xx response is retried, up to `opts.attempts` attempts in total (default 3), waiting `baseDelayMs * 2^(attempt-1)` before each retry (`baseDelayMs` default 100) by calling `opts.sleep(ms)` (defaults to a real timer);
- a 4xx response is a permanent failure and is not retried;
- on success it resolves with `{ attempts }`, the number of calls it took.

When it gives up, the returned promise must reject with a `DeliveryError` that records `attempts` (calls made), `lastStatus` (the last HTTP status, if any) and `cause` (the last network error, if the last failure was one). Callers rely on this rejection to put the event on the dead-letter queue.
