export type Expense = {
  id: string;
  submittedBy: string;
  department: string;
  amountCents: number;
  status: "pending" | "approved" | "rejected";
};
