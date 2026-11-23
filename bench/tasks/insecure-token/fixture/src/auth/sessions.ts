import { shortId } from "../ids.js";

export type Session = { id: string; userId: string; createdAt: number };

export function newRequestScopedSession(userId: string, now: number): Session {
  return { id: shortId(12), userId, createdAt: now };
}
