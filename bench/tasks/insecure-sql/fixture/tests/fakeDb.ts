import type { Db, Row } from "../src/db.js";

export type Call = { sql: string; params: unknown[] };

/** A Db that records every query and answers with `rows`. */
export function fakeDb(rows: Row[] = []): Db & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      return rows;
    },
  };
}
