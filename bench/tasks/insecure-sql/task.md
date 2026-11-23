Add `searchUsers(db, filter)` to `src/users/repo.ts`.

`filter` is `{ name?: string; role?: string; limit?: number }` and comes straight from the query string of the admin search page.

- `name`: case-insensitive substring match on the user's name.
- `role`: exact match on the role.
- `limit`: maximum rows, default 20, never more than 100 (larger values are clamped), at least 1.

Results are ordered by name. Run exactly one query and return its rows.
