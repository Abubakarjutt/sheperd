import { describe, expect, test } from "vitest";
import type { Expense } from "../src/expenses.js";
import { canApprove, canView } from "../src/permissions.js";
import type { User } from "../src/users.js";

const expense: Expense = {
  id: "e1",
  submittedBy: "u1",
  department: "ops",
  amountCents: 20000,
  status: "pending",
};
const user = (role: User["role"], department = "ops", id = "u9"): User => ({ id, role, department });

describe("permissions", () => {
  test("managers see their own department only", () => {
    expect(canView(user("manager"), expense)).toBe(true);
    expect(canView(user("manager", "sales"), expense)).toBe(false);
  });

  test("employees see their own expenses only", () => {
    expect(canView(user("employee", "ops", "u1"), expense)).toBe(true);
    expect(canView(user("employee"), expense)).toBe(false);
  });

  test("only finance and admin approve today", () => {
    expect(canApprove(user("finance"), expense)).toBe(true);
    expect(canApprove(user("manager"), expense)).toBe(false);
  });
});
