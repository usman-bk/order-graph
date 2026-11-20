import {
  GraphQLError,
  getNamedType,
  isCompositeType,
  Kind,
  type DocumentNode,
  type FragmentDefinitionNode,
  type GraphQLCompositeType,
  type GraphQLSchema,
  type SelectionSetNode,
  isObjectType,
  isInterfaceType,
  valueFromASTUntyped,
} from "graphql";

export interface Limits {
  maxDepth: number;
  maxCost: number;
}

export const DEFAULT_LIMITS: Limits = { maxDepth: 7, maxCost: 10000 };

// Plain list fields have no `first` argument, so their size is a promise the
// resolvers keep (Customer.orders is cut at 20 in the loader).
const LIST_SIZES: Record<string, number> = {
  "Customer.orders": 20,
  "Order.lines": 25,
};
// Connections: the field takes `first` and the whole subtree below it repeats
// that many times.
const MAX_PAGE = 100;

export interface Measure {
  depth: number;
  cost: number;
}

export function measure(
  document: DocumentNode,
  schema: GraphQLSchema,
  variables: Record<string, unknown> = {},
  operationName?: string | null,
): Measure {
  const fragments = new Map<string, FragmentDefinitionNode>();
  const operations = [];
  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
    if (def.kind === Kind.OPERATION_DEFINITION) operations.push(def);
  }
  const op =
    operations.find((o) => !operationName || o.name?.value === operationName) ?? operations[0];
  if (!op) return { depth: 0, cost: 0 };
  const root = schema.getQueryType();
  if (!root) return { depth: 0, cost: 0 };

  const walk = (
    set: SelectionSetNode,
    parent: GraphQLCompositeType,
    stack: Set<string>,
  ): Measure => {
    let depth = 0;
    let cost = 0;
    for (const sel of set.selections) {
      if (sel.kind === Kind.FIELD) {
        const name = sel.name.value;
        if (name === "__typename") continue;
        if (!isObjectType(parent) && !isInterfaceType(parent)) continue;
        const def = parent.getFields()[name];
        if (!def) continue;
        const named = getNamedType(def.type);
        let childDepth = 0;
        let childCost = 0;
        if (sel.selectionSet && isCompositeType(named)) {
          const m = walk(sel.selectionSet, named, stack);
          childDepth = m.depth;
          childCost = m.cost;
        }
        let times = LIST_SIZES[`${parent.name}.${name}`] ?? 1;
        const firstArg = sel.arguments?.find((a) => a.name.value === "first");
        if (firstArg) {
          const raw = valueFromASTUntyped(firstArg.value, variables);
          const n = typeof raw === "number" ? raw : MAX_PAGE;
          times = Math.max(1, Math.min(n, MAX_PAGE));
        } else if (def.args.some((a) => a.name === "first")) {
          times = 20;
        }
        depth = Math.max(depth, 1 + childDepth);
        cost += 1 + times * childCost;
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        const m = walk(sel.selectionSet, parent, stack);
        depth = Math.max(depth, m.depth);
        cost += m.cost;
      } else {
        const frag = fragments.get(sel.name.value);
        if (!frag || stack.has(frag.name.value)) continue;
        stack.add(frag.name.value);
        const target = schema.getType(frag.typeCondition.name.value);
        const m = isCompositeType(target) ? walk(frag.selectionSet, target, stack) : { depth: 0, cost: 0 };
        stack.delete(frag.name.value);
        depth = Math.max(depth, m.depth);
        cost += m.cost;
      }
    }
    return { depth, cost };
  };

  return walk(op.selectionSet, root, new Set());
}

export function checkLimits(
  document: DocumentNode,
  schema: GraphQLSchema,
  variables: Record<string, unknown> | undefined,
  operationName: string | null | undefined,
  limits: Limits,
): GraphQLError | null {
  const m = measure(document, schema, variables ?? {}, operationName);
  if (m.depth > limits.maxDepth) {
    return new GraphQLError(`Query is nested ${m.depth} levels deep, the limit is ${limits.maxDepth}`, {
      extensions: { code: "QUERY_TOO_DEEP" },
    });
  }
  if (m.cost > limits.maxCost) {
    return new GraphQLError(`Query costs ${m.cost}, the limit is ${limits.maxCost}`, {
      extensions: { code: "QUERY_TOO_EXPENSIVE" },
    });
  }
  return null;
}
