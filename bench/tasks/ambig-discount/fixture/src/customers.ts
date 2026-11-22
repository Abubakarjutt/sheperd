export type Tier = "standard" | "silver" | "gold";
export type Customer = { id: string; email: string; tier: Tier; ordersPlaced: number };
