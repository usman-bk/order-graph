import { createServer } from "node:http";
import { createPool } from "./db.ts";
import { createApp } from "./server.ts";

const url = process.env["DATABASE_URL"];
if (!url) throw new Error("DATABASE_URL is required");

const db = createPool(url);
const app = createApp({
  db,
  allowAdhoc: process.env["ALLOW_ADHOC_QUERIES"] === "true",
  onInternalError: (id, err) => console.error(JSON.stringify({ requestId: id, error: String(err) })),
});

const port = Number(process.env["PORT"] ?? 4000);
createServer(app).listen(port, () => console.log(`listening on ${port}`));
