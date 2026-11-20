import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PersistedQueries, sha256 } from "../src/persisted.ts";
import { client, pool, seed, tokenFor } from "./helpers.ts";

const db = pool();
afterAll(() => db.end());
beforeAll(() => seed(db, { customers: 2, ordersEach: 2, linesEach: 1 }));

const ME = `{ me { name } }`;
const store = new PersistedQueries([ME]);
const locked = client({ db, persisted: store, allowAdhoc: false });
const open = client({ db, persisted: store, allowAdhoc: true });
const hashBody = (hash: string) => ({ extensions: { persistedQuery: { version: 1, sha256Hash: hash } } });

describe("persisted queries", () => {
  it("runs a stored query by hash", async () => {
    const res = await locked.post(hashBody(sha256(ME)), tokenFor(2));
    expect(res.data.me.name).toBe("Customer 2");
  });

  it("refuses query text when ad hoc queries are off", async () => {
    const res = await locked.post({ query: ME }, tokenFor(2));
    expect(res.errors?.[0]?.extensions?.["code"]).toBe("PERSISTED_QUERY_REQUIRED");
    expect(res.data).toBeUndefined();
  });

  it("ignores text sent beside a hash, and runs what is stored", async () => {
    const res = await locked.post(
      { query: `{ customers { edges { node { email } } } }`, ...hashBody(sha256(ME)) },
      tokenFor(2),
    );
    expect(res.errors).toBeUndefined();
    expect(Object.keys(res.data)).toEqual(["me"]);
  });

  it("answers an unknown hash with the code clients retry on", async () => {
    const res = await locked.post(hashBody(sha256("{ nope }")), tokenFor(2));
    expect(res.errors?.[0]?.message).toBe("PersistedQueryNotFound");
  });

  it("still takes query text when ad hoc is on", async () => {
    const res = await open.post({ query: ME }, tokenFor(2));
    expect(res.data.me.name).toBe("Customer 2");
  });

  it("applies the same limits to a stored query", async () => {
    const deep = `{ orders(first: 100) { edges { node { customer { orders { lines { id } } } } } } }`;
    const s = new PersistedQueries([deep]);
    const c = client({ db, persisted: s, allowAdhoc: false });
    const res = await c.post(hashBody(sha256(deep)), tokenFor(1));
    expect(res.errors?.[0]?.extensions?.["code"]).toBe("QUERY_TOO_EXPENSIVE");
  });
});
