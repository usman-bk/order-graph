import { GraphQLError } from "graphql";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { q, type Db } from "./db.ts";
import type { CustomerRow, ItemRow, LineRow, Loaders, OrderRow } from "./loaders.ts";

export interface Viewer {
  id: string;
  isAdmin: boolean;
}
export interface Context {
  db: Db;
  loaders: Loaders;
  viewer: Viewer | null;
}

export const typeDefs = `
  enum OrderStatus {
    PLACED
    PAID
    SHIPPED
    CANCELLED
  }

  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  type Item {
    id: ID!
    sku: String!
    name: String!
    priceCents: Int!
  }

  type OrderLine {
    id: ID!
    quantity: Int!
    item: Item!
  }

  type Order {
    id: ID!
    status: OrderStatus!
    createdAt: String!
    customer: Customer!
    lines: [OrderLine!]!
    totalCents: Int!
    internalNote: String
  }

  type Customer {
    id: ID!
    name: String!
    email: String
    "The 20 most recent orders."
    orders: [Order!]!
  }

  type OrderEdge {
    cursor: String!
    node: Order!
  }
  type OrderConnection {
    edges: [OrderEdge!]!
    pageInfo: PageInfo!
  }
  type CustomerEdge {
    cursor: String!
    node: Customer!
  }
  type CustomerConnection {
    edges: [CustomerEdge!]!
    pageInfo: PageInfo!
  }

  type Query {
    me: Customer
    customer(id: ID!): Customer
    customers(first: Int = 20, after: String): CustomerConnection!
    order(id: ID!): Order
    orders(first: Int = 20, after: String, status: OrderStatus): OrderConnection!
  }
`;

function fail(message: string, code: string): never {
  throw new GraphQLError(message, { extensions: { code } });
}

function requireViewer(ctx: Context): Viewer {
  if (!ctx.viewer) fail("Authentication required", "UNAUTHENTICATED");
  return ctx.viewer;
}

function canSeeOrder(v: Viewer, o: OrderRow): boolean {
  return v.isAdmin || o.customer_id === v.id;
}

export function encodeCursor(id: string): string {
  return Buffer.from(`id:${id}`).toString("base64url");
}
export function decodeCursor(cursor: string): string {
  const match = /^id:(\d{1,18})$/.exec(Buffer.from(cursor, "base64url").toString());
  if (!match) fail("Invalid cursor", "BAD_USER_INPUT");
  return match[1]!;
}

function pageSize(first: number): number {
  if (first < 1 || first > 100) fail("first must be between 1 and 100", "BAD_USER_INPUT");
  return first;
}

function connection<T extends { id: string }>(rows: T[], n: number) {
  const page = rows.slice(0, n);
  return {
    edges: page.map((node) => ({ cursor: encodeCursor(node.id), node })),
    pageInfo: {
      hasNextPage: rows.length > n,
      endCursor: page.length ? encodeCursor(page[page.length - 1]!.id) : null,
    },
  };
}

export const resolvers = {
  Query: {
    me: (_: unknown, __: unknown, ctx: Context) =>
      ctx.viewer ? ctx.loaders.customer.load(ctx.viewer.id) : null,

    customer: (_: unknown, { id }: { id: string }, ctx: Context) => {
      const v = requireViewer(ctx);
      if (!v.isAdmin && v.id !== id) return null;
      return ctx.loaders.customer.load(id);
    },

    customers: async (_: unknown, args: { first: number; after?: string }, ctx: Context) => {
      const v = requireViewer(ctx);
      if (!v.isAdmin) fail("Admins only", "FORBIDDEN");
      const n = pageSize(args.first);
      const after = args.after ? decodeCursor(args.after) : "0";
      const rows = await q<CustomerRow>(
        ctx.db,
        "SELECT id, name, email, is_admin FROM customers WHERE id > $1 ORDER BY id LIMIT $2",
        [after, n + 1],
      );
      return connection(rows, n);
    },

    order: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const v = requireViewer(ctx);
      const rows = await q<OrderRow>(
        ctx.db,
        "SELECT id, customer_id, status, internal_note, created_at FROM orders WHERE id = $1",
        [id],
      );
      const row = rows[0];
      // Someone else's order reads as absent, so ids cannot be probed.
      return row && canSeeOrder(v, row) ? row : null;
    },

    orders: async (
      _: unknown,
      args: { first: number; after?: string; status?: string },
      ctx: Context,
    ) => {
      const v = requireViewer(ctx);
      const n = pageSize(args.first);
      const params: unknown[] = [];
      const where: string[] = [];
      if (args.after) {
        params.push(decodeCursor(args.after));
        where.push(`id < $${params.length}`);
      }
      if (args.status) {
        params.push(args.status);
        where.push(`status = $${params.length}`);
      }
      if (!v.isAdmin) {
        params.push(v.id);
        where.push(`customer_id = $${params.length}`);
      }
      params.push(n + 1);
      const rows = await q<OrderRow>(
        ctx.db,
        `SELECT id, customer_id, status, internal_note, created_at FROM orders
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY id DESC LIMIT $${params.length}`,
        params,
      );
      return connection(rows, n);
    },
  },

  Customer: {
    email: (c: CustomerRow, _: unknown, ctx: Context) => {
      const v = requireViewer(ctx);
      if (!v.isAdmin && v.id !== c.id) fail("Not allowed to read this email", "FORBIDDEN");
      return c.email;
    },
    orders: async (c: CustomerRow, _: unknown, ctx: Context) => {
      const v = requireViewer(ctx);
      const rows = await ctx.loaders.ordersByCustomer.load(c.id);
      return rows.filter((o) => canSeeOrder(v, o));
    },
  },

  Order: {
    createdAt: (o: OrderRow) => o.created_at.toISOString(),
    customer: (o: OrderRow, _: unknown, ctx: Context) => ctx.loaders.customer.load(o.customer_id),
    lines: (o: OrderRow, _: unknown, ctx: Context) => ctx.loaders.linesByOrder.load(o.id),
    totalCents: async (o: OrderRow, _: unknown, ctx: Context) => {
      const lines = await ctx.loaders.linesByOrder.load(o.id);
      const items = await ctx.loaders.item.loadMany(lines.map((l) => l.item_id));
      return lines.reduce((sum, l, i) => {
        const item = items[i] as ItemRow;
        return sum + item.price_cents * l.quantity;
      }, 0);
    },
    internalNote: (o: OrderRow, _: unknown, ctx: Context) => {
      const v = requireViewer(ctx);
      if (!v.isAdmin) fail("Not allowed to read internal notes", "FORBIDDEN");
      return o.internal_note;
    },
  },

  Item: {
    priceCents: (i: ItemRow) => i.price_cents,
  },

  OrderLine: {
    item: (l: LineRow, _: unknown, ctx: Context) => ctx.loaders.item.load(l.item_id),
  },
};

export function buildSchema() {
  return makeExecutableSchema({ typeDefs, resolvers });
}
