import { describe, expect, test } from "vitest";
import type { Expense } from "../src/expenses.js";
import { canApprove } from "../src/permissions.js";
import type { User } from "../src/users.js";

const expense = (over: Partial<Expense> = {}): Expense => ({
  id: "e1",
  submittedBy: "u1",
  department: "ops",
  amountCents: 20000,
  status: "pending",
  ...over,
});
const user = (role: User["role"], department = "ops", id = "u9"): User => ({ id, role, department });

describe("canApprove for managers", () => {
  test("approves pending expenses in their department up to $500", () => {
    expect(canApprove(user("manager"), expense({ amountCents: 50000 }))).toBe(true);
  });

  test("not above $500", () => {
    expect(canApprove(user("manager"), expense({ amountCents: 50001 }))).toBe(false);
  });

  test("not other departments", () => {
    expect(canApprove(user("manager", "sales"), expense())).toBe(false);
  });

  test("never their own expense", () => {
    expect(canApprove(user("manager", "ops", "u1"), expense())).toBe(false);
  });

  test("not once decided", () => {
    expect(canApprove(user("manager"), expense({ status: "approved" }))).toBe(false);
  });

  test("employees still cannot approve, finance still can", () => {
    expect(canApprove(user("employee"), expense())).toBe(false);
    expect(canApprove(user("finance"), expense({ amountCents: 9_000_000 }))).toBe(true);
  });
});
