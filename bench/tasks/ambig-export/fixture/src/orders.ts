export type Order = {
  id: string;
  placedAt: string;
  customer: string;
  currency: string;
  totalCents: number;
  status: "paid" | "refunded" | "open";
};
