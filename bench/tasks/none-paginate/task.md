Add `paginate(items, opts)` to a new file `src/list/paginate.ts`.

`opts` is `{ page: number; perPage: number }`; `page` is 1-based. It returns `{ items, page, perPage, totalItems, totalPages, hasPrev, hasNext }` where `items` is that page's slice of the input (the input array is not modified).

- `page` must be an integer >= 1 and `perPage` an integer from 1 to 100, otherwise throw a `RangeError`.
- A page past the end is not an error: it has no items, and `hasNext` is false.
- An empty list has `totalPages` 0.
