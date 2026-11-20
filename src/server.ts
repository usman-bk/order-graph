import { randomUUID } from "node:crypto";
import { GraphQLError } from "graphql";
import { createYoga, type Plugin } from "graphql-yoga";
import { q, type Db } from "./db.ts";
import { checkLimits, DEFAULT_LIMITS, type Limits } from "./limits.ts";
import { createLoaders } from "./loaders.ts";
import { PersistedQueries, resolveQuery } from "./persisted.ts";
import { buildSchema, type Context, type Viewer } from "./schema.ts";

export interface AppOptions {
  db: Db;
  limits?: Limits;
  persisted?: PersistedQueries;
  /** Accept query text sent in the request body. Off in production. */
  allowAdhoc?: boolean;
  onInternalError?: (requestId: string, error: unknown) => void;
}

async function viewerFor(db: Db, request: Request): Promise<Viewer | null> {
  const header = request.headers.get("authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return null;
  const rows = await q<{ id: string; is_admin: boolean }>(
    db,
    "SELECT id, is_admin FROM customers WHERE api_token = $1",
    [m[1]],
  );
  const row = rows[0];
  return row ? { id: row.id, isAdmin: row.is_admin } : null;
}

export function createApp(opts: AppOptions) {
  const schema = buildSchema();
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const store = opts.persisted ?? new PersistedQueries();
  const adhoc = opts.allowAdhoc ?? true;

  const plugins: Plugin[] = [
    {
      onParams({ params, setParams }) {
        const query = resolveQuery(params, store, adhoc);
        setParams({ ...params, query });
      },
      onExecute({ args, setResultAndStopExecution }) {
        const err = checkLimits(
          args.document,
          args.schema,
          args.variableValues as Record<string, unknown> | undefined,
          args.operationName,
          limits,
        );
        if (err) setResultAndStopExecution({ errors: [err] });
      },
    },
  ];

  return createYoga<{ request: Request }, Context>({
    schema,
    plugins,
    graphqlEndpoint: "/graphql",
    logging: false,
    landingPage: false,
    maskedErrors: {
      maskError(error) {
        const e = error as GraphQLError;
        const inner = e.originalError ?? e;
        if (inner instanceof GraphQLError) return e;
        const requestId = randomUUID();
        opts.onInternalError?.(requestId, inner);
        return new GraphQLError("Internal error", { extensions: { code: "INTERNAL", requestId } });
      },
    },
    context: async ({ request }) => ({
      db: opts.db,
      loaders: createLoaders(opts.db),
      viewer: await viewerFor(opts.db, request),
    }),
  });
}
