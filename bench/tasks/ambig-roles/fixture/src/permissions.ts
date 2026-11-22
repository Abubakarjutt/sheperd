import type { Expense } from "./expenses.js";
import type { User } from "./users.js";

/** Who may read an expense. */
export function canView(user: User, expense: Expense): boolean {
  if (user.role === "admin" || user.role === "finance") return true;
  if (user.role === "manager") return user.department === expense.department;
  return user.id === expense.submittedBy;
}

/** Who may approve an expense. Today only finance and admins can. */
export function canApprove(user: User, _expense: Expense): boolean {
  return user.role === "finance" || user.role === "admin";
}
