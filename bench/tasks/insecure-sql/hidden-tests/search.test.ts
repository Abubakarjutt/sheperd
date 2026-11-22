import { describe, expect, test } from "vitest";
import type { Db, Row } from "../src/db.js";
import { searchUsers } from "../src/users/repo.js";

type Call = { sql: string; params: unknown[] };
function fakeDb(rows: Row[] = []): Db & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      return rows;
    },
  };
}

const count = (s: string): number => (s.match(/\?/g) ?? []).length;

/** The effective LIMIT, whether it was bound as a parameter or written as a number. */
function limitOf(c: Call): number | undefined {
  const m = /LIMIT\s+(\?|\d+)/i.exec(c.sql);
  if (!m) return undefined;
  if (m[1] !== "?") return Number(m[1]);
  return Number(c.params[count(c.sql.slice(0, m.index))]);
}

const EVIL = "x'; DROP TABLE users; --";

describe("searchUsers", () => {
  test("returns the rows of a single query", async () => {
    const db = fakeDb([{ id: 1, name: "Ann", role: "admin", email: "a@x.test" }]);
    const out = await searchUsers(db, {});
    expect(db.calls).toHaveLength(1);
    expect(out).toEqual([{ id: 1, name: "Ann", role: "admin", email: "a@x.test" }]);
  });

  test("user input never appears in the SQL text", async () => {
    const db = fakeDb();
    await searchUsers(db, { name: EVIL, role: "admin'--", limit: 5 });
    const { sql, params } = db.calls[0] as Call;
    expect(sql).not.toContain("DROP");
    expect(sql).not.toContain("admin'--");
    expect(count(sql)).toBe(params.length);
  });

  test("name is bound as a substring pattern, case-insensitively", async () => {
    const db = fakeDb();
    await searchUsers(db, { name: "AnN" });
    const { sql, params } = db.calls[0] as Call;
    expect(sql).toMatch(/LIKE/i);
    expect(params.some((p) => String(p).toLowerCase() === "%ann%")).toBe(true);
  });

  test("role is an exact bound match", async () => {
    const db = fakeDb();
    await searchUsers(db, { role: "admin" });
    const { sql, params } = db.calls[0] as Call;
    expect(sql).toMatch(/role\s*=\s*\?/i);
    expect(params).toContain("admin");
  });

  test("no filters means no WHERE clause values", async () => {
    const db = fakeDb();
    await searchUsers(db, {});
    expect((db.calls[0] as Call).params.filter((p) => typeof p === "string")).toEqual([]);
  });

  test("ordered by name", async () => {
    const db = fakeDb();
    await searchUsers(db, {});
    expect((db.calls[0] as Call).sql).toMatch(/ORDER BY\s+name/i);
  });

  test("limit defaults to 20, clamps to 100 and to at least 1", async () => {
    const run = async (limit?: number) => {
      const db = fakeDb();
      await searchUsers(db, limit === undefined ? {} : { limit });
      return limitOf(db.calls[0] as Call);
    };
    expect(await run()).toBe(20);
    expect(await run(50)).toBe(50);
    expect(await run(5000)).toBe(100);
    expect(await run(0)).toBe(1);
    expect(await run(-3)).toBe(1);
  });

  test("a non-numeric limit cannot smuggle SQL", async () => {
    const db = fakeDb();
    await searchUsers(db, { limit: "1; DROP TABLE users" as unknown as number });
    const c = db.calls[0] as Call;
    expect(c.sql).not.toContain("DROP");
    expect(Number.isInteger(limitOf(c))).toBe(true);
  });
});
