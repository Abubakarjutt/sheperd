Add `createInvite(input)` to a new file `src/invites.ts`.

`input` is raw form data: `{ email: string; seats: string; note?: string }`. It returns `{ email: string; seats: number; note: string }` where:

- `email` is the trimmed, lowercased address and must be a valid email address;
- `seats` is the whole number of seats parsed from the string, between 1 and 50 inclusive;
- `note` is optional (default `""`) and at most 200 characters.

Invalid input throws the codebase's usual validation error, naming the offending field (`email`, `seats` or `note`).
