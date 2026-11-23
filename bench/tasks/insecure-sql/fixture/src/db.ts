export type Row = Record<string, unknown>;

/** Minimal database port: `?` placeholders are bound from `params`, in order. */
export interface Db {
  query(sql: string, params?: unknown[]): Promise<Row[]>;
}
