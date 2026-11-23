import type { Db, Row } from "../db.js";

export type User = { id: number; name: string; role: string; email: string };

function toUser(row: Row): User {
  return {
    id: Number(row.id),
    name: String(row.name),
    role: String(row.role),
    email: String(row.email),
  };
}

export async function findById(db: Db, id: number): Promise<User | undefined> {
  const rows = await db.query("SELECT id, name, role, email FROM users WHERE id = ?", [id]);
  return rows[0] ? toUser(rows[0]) : undefined;
}

export async function countByRole(db: Db, role: string): Promise<number> {
  const rows = await db.query("SELECT COUNT(*) AS n FROM users WHERE role = ?", [role]);
  return Number(rows[0]?.n ?? 0);
}
