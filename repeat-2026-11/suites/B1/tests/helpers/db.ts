// Per-file disposable Postgres database helpers.
import pg from "pg";

export const ADMIN = process.env.MI_PG_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";

export async function createDb(tag: string): Promise<{ name: string; url: string }> {
  const name = `mt_${tag}_${process.pid}_${Date.now().toString(36)}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
  const u = new URL(ADMIN);
  u.pathname = `/${name}`;
  return { name, url: u.href };
}

export async function dropDb(name: string): Promise<void> {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await c.end();
}
