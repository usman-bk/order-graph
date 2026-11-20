import DataLoader from "dataloader";
import { q, type Db } from "./db.ts";

export interface CustomerRow {
  id: string;
  name: string;
  email: string;
  is_admin: boolean;
}
export interface ItemRow {
  id: string;
  sku: string;
  name: string;
  price_cents: number;
}
export interface OrderRow {
  id: string;
  customer_id: string;
  status: string;
  internal_note: string | null;
  created_at: Date;
}
export interface LineRow {
  id: string;
  order_id: string;
  item_id: string;
  quantity: number;
}

export const CUSTOMER_ORDERS_LIMIT = 20;

// A loader is built per request. It caches, and a cache that outlived the
// request would hand one caller's rows to the next.
export function createLoaders(db: Db) {
  return {
    customer: new DataLoader<string, CustomerRow | undefined>(async (ids) => {
      const rows = await q<CustomerRow>(
        db,
        "SELECT id, name, email, is_admin FROM customers WHERE id = ANY($1::bigint[])",
        [ids],
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      return ids.map((id) => byId.get(id));
    }),
    item: new DataLoader<string, ItemRow | undefined>(async (ids) => {
      const rows = await q<ItemRow>(
        db,
        "SELECT id, sku, name, price_cents FROM items WHERE id = ANY($1::bigint[])",
        [ids],
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      return ids.map((id) => byId.get(id));
    }),
    linesByOrder: new DataLoader<string, LineRow[]>(async (ids) => {
      const rows = await q<LineRow>(
        db,
        "SELECT id, order_id, item_id, quantity FROM order_lines WHERE order_id = ANY($1::bigint[]) ORDER BY id",
        [ids],
      );
      const grouped = new Map<string, LineRow[]>();
      for (const r of rows) {
        const list = grouped.get(r.order_id) ?? [];
        list.push(r);
        grouped.set(r.order_id, list);
      }
      return ids.map((id) => grouped.get(id) ?? []);
    }),
    ordersByCustomer: new DataLoader<string, OrderRow[]>(async (ids) => {
      const rows = await q<OrderRow>(
        db,
        `SELECT id, customer_id, status, internal_note, created_at FROM (
           SELECT o.*, row_number() OVER (PARTITION BY customer_id ORDER BY id DESC) AS rn
           FROM orders o WHERE customer_id = ANY($1::bigint[])
         ) t WHERE rn <= $2 ORDER BY customer_id, id DESC`,
        [ids, CUSTOMER_ORDERS_LIMIT],
      );
      const grouped = new Map<string, OrderRow[]>();
      for (const r of rows) {
        const list = grouped.get(r.customer_id) ?? [];
        list.push(r);
        grouped.set(r.customer_id, list);
      }
      return ids.map((id) => grouped.get(id) ?? []);
    }),
  };
}
export type Loaders = ReturnType<typeof createLoaders>;
