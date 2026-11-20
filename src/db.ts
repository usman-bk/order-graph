import pg from "pg";

export type Db = pg.Pool;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

export async function q<T extends pg.QueryResultRow>(
  db: Db,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const res = await db.query<T>(text, values);
  return res.rows;
}
