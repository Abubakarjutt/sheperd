import { describe, expect, test } from "vitest";
import { countByRole, findById } from "../src/users/repo.js";
import { fakeDb } from "./fakeDb.js";

describe("users repo", () => {
  test("findById binds the id", async () => {
    const db = fakeDb([{ id: 4, name: "Ann", role: "admin", email: "a@x.test" }]);
    await expect(findById(db, 4)).resolves.toEqual({
      id: 4,
      name: "Ann",
      role: "admin",
      email: "a@x.test",
    });
    expect(db.calls[0]?.params).toEqual([4]);
  });

  test("findById returns undefined for no rows", async () => {
    await expect(findById(fakeDb(), 1)).resolves.toBeUndefined();
  });

  test("countByRole", async () => {
    await expect(countByRole(fakeDb([{ n: 3 }]), "admin")).resolves.toBe(3);
  });
});
