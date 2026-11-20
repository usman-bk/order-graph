import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { client, internalErrors, pool, recordStatements, seed, tokenFor } from "./helpers.ts";

const db = pool();
const api = client({ db });
afterAll(() => { if (internalErrors.length) console.error(internalErrors); });

afterAll(() => db.end());

const ORDERS_WITH_EVERYTHING = `{
  orders(first: 20) {
    edges { node { id totalCents customer { name } lines { quantity item { name priceCents } } } }
  }
}`;

describe("batching", () => {
  beforeAll(() => seed(db, { customers: 8, ordersEach: 6, linesEach: 4 }));

  it("fetches 20 orders, their customers, lines and items in a fixed number of statements", async () => {
    const { result, statements } = await recordStatements(() =>
      api.query(ORDERS_WITH_EVERYTHING, tokenFor(1)),
    );
    expect(result.errors).toBeUndefined();
    expect(result.data.orders.edges).toHaveLength(20);
    // token lookup, orders page, customers, lines, items. Not one per order.
    expect(statements).toHaveLength(5);
  });

  it("does not grow with the page size", async () => {
    const small = await recordStatements(() =>
      api.query(ORDERS_WITH_EVERYTHING.replace("first: 20", "first: 2"), tokenFor(1)),
    );
    const large = await recordStatements(() =>
      api.query(ORDERS_WITH_EVERYTHING.replace("first: 20", "first: 40"), tokenFor(1)),
    );
    expect(large.statements.length).toBe(small.statements.length);
  });

  it("batches customer -> orders -> lines -> items across many customers", async () => {
    const { result, statements } = await recordStatements(() =>
      api.query(
        `{ customers(first: 8) { edges { node { name orders { id lines { item { sku } } } } } } }`,
        tokenFor(1),
      ),
    );
    expect(result.errors).toBeUndefined();
    expect(result.data.customers.edges).toHaveLength(8);
    // token, customers page, orders per customer, lines, items
    expect(statements).toHaveLength(5);
  });

  it("returns every row in the order it was asked for", async () => {
    const res = await api.query(
      `{ customers(first: 8) { edges { node { id orders { id customer { id } } } } } }`,
      tokenFor(1),
    );
    for (const { node } of res.data.customers.edges) {
      for (const o of node.orders) expect(o.customer.id).toBe(node.id);
    }
  });

  it("computes totals from the batched item prices", async () => {
    const res = await api.query(`{ order(id: 1) { totalCents lines { quantity item { priceCents } } } }`, tokenFor(1));
    const expected = res.data.order.lines.reduce(
      (s: number, l: any) => s + l.quantity * l.item.priceCents,
      0,
    );
    expect(res.data.order.totalCents).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });
});
