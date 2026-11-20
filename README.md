# order-graph

_Built with AI assistance._

A GraphQL API over customers, orders, order lines and items. It is small on
purpose. The point is the parts around the schema: batching that is proven by
counting statements, a query that is refused for being too deep or too wide,
pages that do not shift while rows are being added, stored queries, and errors
that say nothing about the database.

Node 24, TypeScript in strict mode, graphql-yoga, DataLoader, `pg`, PostgreSQL.
39 tests run against a real scratch database, `order_graph_test`.

```
src/schema.ts     types, resolvers, who may see what
src/loaders.ts    one set of DataLoaders per request
src/limits.ts     depth and cost, worked out from the parsed query
src/persisted.ts  stored queries by sha256
src/server.ts     yoga setup, token lookup, error masking
queries/          the stored queries the service accepts
```

## Batching, counted at the driver

`recordStatements` in `test/helpers.ts` replaces `pg.Client.prototype.query`
for the length of one request and keeps every statement text. A pool wrapper
could miss a path that uses a client directly. This cannot.

    orders(first: 20) { totalCents customer { name } lines { item { name } } }

That query runs 5 statements: the token lookup, the page of orders, the
customers, the lines, the items. With 2 orders or with 40 it is still 5
(`does not grow with the page size`). Customers with their orders, lines and
items for 8 customers is also 5. Over 200 runs against 48 orders, p50 was
1.4 ms and p95 1.9 ms through `fetch` into yoga, no network (M, one laptop).

Loaders are built per request. A module level loader would cache a row read
for one caller and give it to the next, which is an authorisation hole, not a
speed problem. `does not let one request's cache serve the next caller` pins it.

## Limits

`src/limits.ts` walks the parsed document with the schema, following named and
inline fragments (with a guard against cycles), and returns a depth and a cost.
A list field multiplies what is under it by its `first`, or by a fixed size
where the schema has no argument (20 for `Customer.orders`, 25 for
`Order.lines`). Defaults are depth 7 and cost 10000. The 20 orders query above
measures depth 6 and cost 2141 (M).

Three places a naive limiter loses, each with a test:

- **Fragments.** Depth hidden behind `...A`, `...B`, and behind inline
  fragments, is still counted.
- **Variables.** `first: $n` cannot be read while validating, because variables
  are not coerced yet. The check runs at execution time with the real values.
  `n: 100` is refused as too expensive, `n: 2` runs.
- **Aliases.** Five aliased copies of one expensive field cost five times.

A refused query never reaches Postgres. The test for it counts statements and
finds one, the token lookup.

## Cursors

A cursor is `id:<n>` in base64url and orders are `ORDER BY id DESC`. A row
inserted while someone is paging gets a higher id, so it sits ahead of the
cursor and cannot push anything onto the next page. The test walks 30 orders in
pages of 7, inserts 9 after the first page, and gets the original 30 exactly
once each. The same insert under `OFFSET` repeats rows, and a test shows that
too, so the claim is not only that the cursor works.

## Stored queries

A request carrying `extensions.persistedQuery.sha256Hash` runs the stored text.
With `ALLOW_ADHOC_QUERIES` unset, query text in the body is refused, and text
sent beside a hash is ignored. Stored queries pass through the same depth and
cost checks. Hashes are taken over the file with surrounding whitespace
trimmed.

## Who sees what

Tokens map to a customer row. Admins see everything. A customer sees their own
orders, their own email, and never `internalNote`. Another customer's order
reads as `null`, not as an error, so ids cannot be probed. Walking
`order -> customer -> orders` does not widen access, because `Customer.orders`
filters again.

## Problems the tests found

**`Item.priceCents` was null.** The column is `price_cents` and a default
resolver looks for `priceCents`. The batching test asked for prices and the
non-null field failed the whole order. Fixed with an explicit resolver.

**A garbage cursor was an internal error.** `after: "not-a-cursor"` decoded to
text that Postgres could not cast to `bigint`, so the caller got a masked
500-style error and a log line. It is now a `BAD_USER_INPUT` before any SQL, and
the decoder accepts only `id:` followed by up to 18 digits.

**Typos revealed the schema.** graphql-js answers a misspelt field with
`Did you mean "email"?`, which leaks names even with introspection closed. The
suggestion is stripped from validation errors.

Under vitest, graphql was loaded twice, once from its ESM build and once from
the CommonJS build yoga requires, and every request failed with "Cannot use
GraphQLObjectType from another module or realm". The config inlines graphql and
its neighbours so there is one copy.

## Errors

Anything that is not a `GraphQLError` becomes `{"message": "Internal error",
code: INTERNAL, requestId}`. The original goes to `onInternalError` with the
same id. One test breaks the pool with a Postgres style error naming a table,
another renames `items` under a live query, and both check that the response
contains no SQL, table name or stack.

## Run it

    createdb order_graph_test
    npm ci
    npm test

    DATABASE_URL=postgres://localhost/order_graph npm start

Apply `sql/schema.sql` to a new database first. The tests recreate their own
tables in `order_graph_test`.

## What it does not do

- Costs use fixed list sizes. A real order with 300 lines is not counted as 300,
  and `Order.lines` is not paged.
- Tokens are looked up in a column as plain text. There is no expiry, hashing or
  rotation, and no login.
- The cursor orders by id. A transaction that takes an id and commits late
  appears behind a reader that has already passed it, so a walk can miss it.
- Stored queries come from files at startup. Nothing registers a new one at
  runtime.
- No mutations, no subscriptions, no rate limit per caller.
- The cost model was tuned by hand on this schema. It has not been checked
  against traffic.
