import { readFileSync } from "node:fs";
import pg from "pg";

export default async function setup() {
  const pool = new pg.Pool({ connectionString: testUrl() });
  await pool.query("DROP TABLE IF EXISTS order_lines, orders, items, customers CASCADE");
  await pool.query(readFileSync(new URL("../sql/schema.sql", import.meta.url), "utf8"));
  await pool.end();
}

export function testUrl(): string {
  return process.env["DATABASE_URL"] ?? "postgres://localhost:5432/order_graph_test";
}
