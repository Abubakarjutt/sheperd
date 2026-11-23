Add `getCustomer(id)` to a new file `src/api/customers.ts`.

It fetches `GET <API_BASE>/customers/<id>` (see `src/config.ts`) and resolves with the customer as `{ id: string; name: string; email: string }`. The id comes from user input, so it must be safe to put in a URL path.

It should behave like the other API calls in this codebase: transient server failures are retried, client errors (4xx) are not retried and surface as the codebase's usual HTTP error, and a request that hangs is cut off.
