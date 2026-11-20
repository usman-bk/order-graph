import pg from "pg";
import { createApp, type AppOptions } from "../src/server.ts";
import { createPool, type Db } from "../src/db.ts";
import { testUrl } from "./global-setup.ts";

export function pool(): Db {
  return createPool(testUrl());
}

export interface Seed {
  customers: number;
  ordersEach: number;
  linesEach: number;
  items?: number;
}

/** Customer 1 is the admin, the rest are named by their position. */
export async function seed(db: Db, s: Seed) {
  await db.query("TRUNCATE order_lines, orders, items, customers RESTART IDENTITY CASCADE");
  const itemCount = s.items ?? 12;
  await db.query(
    `INSERT INTO items (sku, name, price_cents)
     SELECT 'sku-' || g, 'Item ' || g, 100 * g FROM generate_series(1, $1::int) g`,
    [itemCount],
  );
  await db.query(
    `INSERT INTO customers (name, email, api_token, is_admin)
     SELECT CASE WHEN g = 1 THEN 'Admin' ELSE 'Customer ' || g END,
            'c' || g || '@example.test', 'token-' || g, g = 1
     FROM generate_series(1, $1::int) g`,
    [s.customers],
  );
  await db.query(
    `INSERT INTO orders (customer_id, internal_note)
     SELECT c.id, 'note for ' || c.id || '/' || o
     FROM customers c, generate_series(1, $1::int) o ORDER BY o, c.id`,
    [s.ordersEach],
  );
  await db.query(
    `INSERT INTO order_lines (order_id, item_id, quantity)
     SELECT o.id, ((o.id + l) % $2::int) + 1, l
     FROM orders o, generate_series(1, $1::int) l`,
    [s.linesEach, itemCount],
  );
}

export const adminToken = "token-1";
export const tokenFor = (customerId: number) => `token-${customerId}`;

export interface GqlResult<T = any> {
  data?: T;
  errors?: { message: string; extensions?: Record<string, any> }[];
}

export const internalErrors: unknown[] = [];

export function client(opts: AppOptions) {
  const app = createApp({ onInternalError: (_id, e) => internalErrors.push(e), ...opts });
  return {
    async post<T = any>(
      body: Record<string, unknown>,
      token?: string,
    ): Promise<GqlResult<T> & { status: number }> {
      const res = await app.fetch("http://test/graphql", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      return { ...(await res.json()), status: res.status };
    },
    query<T = any>(query: string, token?: string, variables?: Record<string, unknown>) {
      return this.post<T>({ query, variables }, token);
    },
  };
}

/** Counts statements at the driver, so nothing reaches Postgres unseen. */
export async function recordStatements<T>(fn: () => Promise<T>) {
  const proto = pg.Client.prototype as any;
  const original = proto.query;
  const seen: string[] = [];
  proto.query = function (this: unknown, ...args: any[]) {
    const first = args[0];
    seen.push(typeof first === "string" ? first : first?.text ?? "?");
    return original.apply(this, args);
  };
  try {
    const result = await fn();
    return { result, statements: seen };
  } finally {
    proto.query = original;
  }
}
