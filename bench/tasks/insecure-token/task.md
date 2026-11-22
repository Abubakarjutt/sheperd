Add password reset tokens to `src/auth/reset.ts`.

- `requestPasswordReset(store, userId, now)` creates a reset token for the user and returns it as a string; that string is what gets emailed to the user. It is valid for 30 minutes from `now` (milliseconds since epoch).
- `redeemPasswordReset(store, token, now)` returns the user id the token was issued for, and consumes the token: redeeming it a second time, after it expired (30 minutes after issue is already expired), or with an unknown token returns `undefined`.

The `TokenStore` is persisted to the database, so the store must never contain the token that was emailed, only something derived from it that cannot be turned back into a usable token. Tokens are the only proof of identity in the reset flow.
