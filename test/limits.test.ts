import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { client, pool, recordStatements, seed, tokenFor } from "./helpers.ts";

const db = pool();
const api = client({ db });
afterAll(() => db.end());
beforeAll(() => seed(db, { customers: 5, ordersEach: 5, linesEach: 2 }));

// customer -> orders -> customer -> orders ... the schema is a cycle.
function nested(levels: number): string {
  let inner = "id";
  for (let i = 0; i < levels; i++) inner = i % 2 === 0 ? `customer { ${inner} }` : `orders { ${inner} }`;
  return `{ orders(first: 1) { edges { node { ${inner} } } } }`;
}

describe("depth and cost", () => {
  it("runs an ordinary query", async () => {
    const res = await api.query(`{ me { name orders { id lines { item { name } } } } }`, tokenFor(2));
    expect(res.errors).toBeUndefined();
  });

  it("refuses a hostile nested query before it touches the database", async () => {
    const { result, statements } = await recordStatements(() => api.query(nested(29), tokenFor(1)));
    expect(result.errors?.[0]?.extensions?.["code"]).toBe("QUERY_TOO_DEEP");
    // only the token lookup
    expect(statements).toHaveLength(1);
  });

  it("refuses depth hidden behind fragments", async () => {
    const q = `
      query { orders(first: 1) { edges { node { ...A } } } }
      fragment A on Order { customer { ...B } }
      fragment B on Customer { orders { ...C } }
      fragment C on Order { customer { ...D } }
      fragment D on Customer { orders { ...E } }
      fragment E on Order { customer { orders { id } } }`;
    const res = await api.query(q, tokenFor(1));
    expect(res.errors?.[0]?.extensions?.["code"]).toBe("QUERY_TOO_DEEP");
  });

  it("refuses depth hidden behind inline fragments", async () => {
    let inner = "id";
    for (let i = 0; i < 7; i++) inner = i % 2 === 0 ? `... on Order { customer { ${inner} } }` : `... on Customer { orders { ${inner} } }`;
    const res = await api.query(`{ orders(first: 1) { edges { node { ${inner} } } } }`, tokenFor(1));
    expect(res.errors?.[0]?.extensions?.["code"]).toBe("QUERY_TOO_DEEP");
  });

  it("counts a page size that arrives in a variable", async () => {
    const q = `query($n: Int) { orders(first: $n) { edges { node { customer { orders { lines { id } } } } } } }`;
    const res = await api.query(q, tokenFor(1), { n: 100 });
    expect(res.errors?.[0]?.extensions?.["code"]).toBe("QUERY_TOO_EXPENSIVE");
    const small = await api.query(q, tokenFor(1), { n: 2 });
    expect(small.errors).toBeUndefined();
  });

  it("counts aliased copies of the same expensive field", async () => {
    const field = (i: number) =>
      `a${i}: orders(first: 100) { edges { node { customer { orders { lines { id } } } } } }`;
    const q = `{ ${Array.from({ length: 5 }, (_, i) => field(i)).join(" ")} }`;
    const res = await api.query(q, tokenFor(1));
    expect(res.errors?.[0]?.extensions?.["code"]).toBe("QUERY_TOO_EXPENSIVE");
  });

  it("does not loop forever on a fragment cycle", async () => {
    const res = await api.query(
      `{ me { ...A } } fragment A on Customer { orders { customer { ...A } } }`,
      tokenFor(1),
    );
    expect(res.errors?.length).toBeGreaterThan(0);
  });

  it("applies a custom limit when one is configured", async () => {
    const tight = client({ db, limits: { maxDepth: 2, maxCost: 10000 } });
    const res = await tight.query(`{ me { orders { id } } }`, tokenFor(2));
    expect(res.errors?.[0]?.extensions?.["code"]).toBe("QUERY_TOO_DEEP");
  });
});
