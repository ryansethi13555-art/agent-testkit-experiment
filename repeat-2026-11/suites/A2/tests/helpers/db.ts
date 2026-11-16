// Creates a uniquely named throwaway database per test file and drops it afterwards.
import { randomBytes } from "node:crypto";
import pg from "pg";

export const ADMIN = process.env.MI_PG_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";

export async function createTestDb(label: string): Promise<{ name: string; url: string; drop: () => Promise<void> }> {
  const name = `ta_${label}_${process.pid}_${randomBytes(3).toString("hex")}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(ADMIN);
  u.pathname = `/${name}`;
  return {
    name,
    url: u.href,
    drop: async () => {
      const a = new pg.Client({ connectionString: ADMIN });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
