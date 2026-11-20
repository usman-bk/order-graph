import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { client, internalErrors, pool, seed, tokenFor } from "./helpers.ts";

const db = pool();
const api = client({ db });
afterAll(() => db.end());
beforeAll(() => seed(db, { customers: 3, ordersEach: 3, linesEach: 2 }));

describe("field level authorisation", () => {
  it("lets a customer read their own email and nobody else's", async () => {
    const own = await api.query(`{ me { email } }`, tokenFor(2));
    expect(own.data.me.email).toBe("c2@example.test");
    const other = await api.query(`{ customer(id: 3) { name } }`, tokenFor(2));
    expect(other.data.customer).toBeNull();
  });

  it("refuses internal notes to a customer on their own order", async () => {
    const res = await api.query(`{ me { orders { id internalNote } } }`, tokenFor(2));
    expect(res.errors?.[0]?.extensions?.["code"]).toBe("FORBIDDEN");
    expect(JSON.stringify(res)).not.toContain("note for");
  });

  it("lets an admin read internal notes", async () => {
    const res = await api.query(`{ order(id: 1) { internalNote } }`, tokenFor(1));
    expect(res.data.order.internalNote).toBe("note for 1/1");
  });

  it("reads someone else's order as absent, not forbidden", async () => {
    const mine = await db.query("SELECT id FROM orders WHERE customer_id = 3 LIMIT 1");
    const res = await api.query(`{ order(id: ${mine.rows[0].id}) { id } }`, tokenFor(2));
    expect(res.errors).toBeUndefined();
    expect(res.data.order).toBeNull();
  });

  it("keeps a customer out of the customer list", async () => {
    const res = await api.query(`{ customers { edges { node { id } } } }`, tokenFor(2));
    expect(res.errors?.[0]?.extensions?.["code"]).toBe("FORBIDDEN");
  });

  it("does not leak another customer's orders through order -> customer -> orders", async () => {
    const res = await api.query(`{ me { orders { customer { orders { id } } } } }`, tokenFor(2));
    const ids = res.data.me.orders.flatMap((o: any) => o.customer.orders.map((x: any) => x.id));
    const owners = await db.query("SELECT DISTINCT customer_id FROM orders WHERE id = ANY($1::bigint[])", [ids]);
    expect(owners.rows.map((r) => r.customer_id)).toEqual(["2"]);
  });

  it("treats an unknown token as no viewer", async () => {
    const me = await api.query(`{ me { name } }`, "token-999");
    expect(me.data.me).toBeNull();
    const orders = await api.query(`{ orders { edges { node { id } } } }`, "token-999");
    expect(orders.errors?.[0]?.extensions?.["code"]).toBe("UNAUTHENTICATED");
  });

  it("does not let one request's cache serve the next caller", async () => {
    const a = await api.query(`{ customer(id: 2) { name orders { id } } }`, tokenFor(2));
    const b = await api.query(`{ customer(id: 2) { name orders { id } } }`, tokenFor(3));
    expect(a.data.customer.orders.length).toBe(3);
    expect(b.data.customer).toBeNull();
  });
});

describe("errors", () => {
  it("does not show SQL, table names or a stack when the database fails", async () => {
    const broken = client({
      db: { query: () => Promise.reject(Object.assign(new Error('relation "customers" does not exist'), { code: "42P01", position: "15" })) } as any,
    });
    const before = internalErrors.length;
    const res = await broken.query(`{ me { name } }`, tokenFor(2));
    const text = JSON.stringify(res);
    expect(res.errors?.[0]?.extensions?.["code"]).toBe("INTERNAL");
    expect(text).not.toMatch(/relation|customers|42P01|SELECT|stack|node_modules/i);
    expect(res.errors?.[0]?.extensions?.["requestId"]).toMatch(/^[0-9a-f-]{36}$/);
    // the detail is kept on the server, keyed by the same id
    expect(internalErrors.length).toBe(before + 1);
  });

  it("does not echo SQL for a real Postgres failure either", async () => {
    await db.query("ALTER TABLE items RENAME TO items_gone");
    try {
      const res = await api.query(`{ order(id: 1) { lines { item { name } } } }`, tokenFor(1));
      expect(JSON.stringify(res)).not.toMatch(/items|relation|SELECT|FROM|position/i);
    } finally {
      await db.query("ALTER TABLE items_gone RENAME TO items");
    }
  });

  it("does not suggest field names to a caller guessing at the schema", async () => {
    const res = await api.query(`{ me { emial } }`, tokenFor(2));
    expect(res.errors?.[0]?.message).not.toMatch(/Did you mean/);
  });

  it("answers a malformed body without a stack", async () => {
    const res = await api.post({ query: "{ me { " }, tokenFor(2));
    expect(JSON.stringify(res)).not.toMatch(/at .*\.(ts|js):\d+/);
  });
});
