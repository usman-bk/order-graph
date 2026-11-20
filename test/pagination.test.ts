import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { client, pool, seed, tokenFor } from "./helpers.ts";

const db = pool();
const api = client({ db });
afterAll(() => db.end());

const PAGE = `query($first: Int, $after: String) {
  orders(first: $first, after: $after) {
    edges { cursor node { id } }
    pageInfo { hasNextPage endCursor }
  }
}`;

async function walk(first: number, token: string, between?: () => Promise<void>) {
  const ids: string[] = [];
  let after: string | undefined;
  let step = 0;
  for (;;) {
    const res = await api.query(PAGE, token, { first, after });
    expect(res.errors).toBeUndefined();
    ids.push(...res.data.orders.edges.map((e: any) => e.node.id));
    if (!res.data.orders.pageInfo.hasNextPage) break;
    after = res.data.orders.pageInfo.endCursor;
    if (step++ === 0 && between) await between();
  }
  return ids;
}

describe("cursor pagination", () => {
  beforeEach(() => seed(db, { customers: 3, ordersEach: 10, linesEach: 1 }));

  it("walks every order once, newest first", async () => {
    const ids = await walk(7, tokenFor(1));
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
    expect(ids.map(Number)).toEqual([...ids.map(Number)].sort((a, b) => b - a));
  });

  it("shows neither repeats nor gaps when orders are inserted between pages", async () => {
    const ids = await walk(7, tokenFor(1), async () => {
      await db.query("INSERT INTO orders (customer_id) SELECT 2 FROM generate_series(1, 9)");
    });
    // The 30 that existed at the start, each exactly once. The nine new ones
    // sit ahead of the cursor and are not part of this walk.
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
    expect(Math.max(...ids.map(Number))).toBe(30);
  });

  it("is where offset paging goes wrong under the same insert", async () => {
    const seen: string[] = [];
    const page = async (offset: number) =>
      (await db.query("SELECT id FROM orders ORDER BY id DESC LIMIT 7 OFFSET $1", [offset])).rows.map(
        (r) => r.id as string,
      );
    seen.push(...(await page(0)));
    await db.query("INSERT INTO orders (customer_id) SELECT 2 FROM generate_series(1, 9)");
    seen.push(...(await page(7)));
    expect(new Set(seen).size).toBeLessThan(seen.length);
  });

  it("a customer sees only their own orders and paging respects that", async () => {
    const ids = await walk(4, tokenFor(2));
    expect(ids).toHaveLength(10);
    const owners = await db.query("SELECT DISTINCT customer_id FROM orders WHERE id = ANY($1::bigint[])", [ids]);
    expect(owners.rows.map((r) => r.customer_id)).toEqual(["2"]);
  });

  it("rejects a page size outside 1..100", async () => {
    for (const first of [0, -1, 101]) {
      const res = await api.query(PAGE, tokenFor(1), { first });
      expect(res.errors?.[0]?.extensions?.["code"]).toBe("BAD_USER_INPUT");
    }
  });

  it("answers a garbage cursor as a bad request, not an internal fault", async () => {
    for (const after of ["not-a-cursor", "aWQ6MSBPUiAxPTE", "aWQ6", Buffer.from("id:99999999999999999999999").toString("base64url")]) {
      const res = await api.query(PAGE, tokenFor(1), { first: 5, after });
      expect(res.errors?.[0]?.extensions?.["code"], after).toBe("BAD_USER_INPUT");
    }
  });

  it("filters by status and keeps paging inside the filter", async () => {
    await db.query("UPDATE orders SET status = 'PAID' WHERE id % 3 = 0");
    const res = await api.query(
      `{ orders(first: 100, status: PAID) { edges { node { id status } } } }`,
      tokenFor(1),
    );
    expect(res.data.orders.edges).toHaveLength(10);
    expect(res.data.orders.edges.every((e: any) => e.node.status === "PAID")).toBe(true);
  });
});
