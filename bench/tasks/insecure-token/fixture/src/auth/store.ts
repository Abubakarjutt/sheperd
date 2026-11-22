export type TokenRecord = { userId: string; expiresAt: number };

/** In-memory stand-in for the tokens table. Keys are whatever the caller chooses to index by. */
export class TokenStore {
  private readonly rows = new Map<string, TokenRecord>();

  put(key: string, record: TokenRecord): void {
    this.rows.set(key, record);
  }

  take(key: string): TokenRecord | undefined {
    const row = this.rows.get(key);
    this.rows.delete(key);
    return row;
  }

  keys(): string[] {
    return [...this.rows.keys()];
  }
}
