// Throwaway, uniquely named Postgres databases for the money-correctness suite.
import pg from "pg";

export const ADMIN = process.env.MI_PG_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";

export async function createDb(tag: string) {
  const name = `mit_${tag}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(ADMIN);
  u.pathname = `/${name}`;
  return {
    name,
    url: u.href,
    async drop() {
      const a = new pg.Client({ connectionString: ADMIN });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Commission as specified: 10 %, half-even, integer only (independent re-implementation). */
export function expectedFee(amount: bigint): bigint {
  const n = amount * 1000n;
  const q = n / 10000n;
  const r = n % 10000n;
  if (r * 2n > 10000n) return q + 1n;
  if (r * 2n === 10000n) return q % 2n === 1n ? q + 1n : q;
  return q;
}
