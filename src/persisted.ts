import { createHash } from "node:crypto";
import { GraphQLError } from "graphql";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export class PersistedQueries {
  private readonly byHash = new Map<string, string>();

  constructor(queries: string[] = []) {
    for (const text of queries) this.add(text);
  }

  add(text: string): string {
    const hash = sha256(text);
    this.byHash.set(hash, text);
    return hash;
  }

  get(hash: string): string | undefined {
    return this.byHash.get(hash);
  }

  get size(): number {
    return this.byHash.size;
  }
}

export interface PersistedParams {
  query?: string | undefined;
  extensions?: Record<string, unknown> | undefined;
}

// Resolves the request to a query text. With `adhoc` off, only stored queries
// run: whatever text the client sends is ignored unless its hash is stored.
export function resolveQuery(
  params: PersistedParams,
  store: PersistedQueries,
  adhoc: boolean,
): string | undefined {
  const ext = params.extensions?.["persistedQuery"] as { sha256Hash?: unknown } | undefined;
  const hash = typeof ext?.sha256Hash === "string" ? ext.sha256Hash : undefined;
  if (hash) {
    const stored = store.get(hash);
    if (!stored) {
      throw new GraphQLError("PersistedQueryNotFound", {
        extensions: { code: "PERSISTED_QUERY_NOT_FOUND" },
      });
    }
    return stored;
  }
  if (!adhoc) {
    throw new GraphQLError("Only persisted queries are accepted", {
      extensions: { code: "PERSISTED_QUERY_REQUIRED" },
    });
  }
  return params.query;
}
