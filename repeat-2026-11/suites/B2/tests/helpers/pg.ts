// Disposable, uniquely named Postgres databases for the suite.
import pg from "pg";

export const ADMIN = process.env.MI_PG_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";

export interface TestDb {
  name: string;
  url: string;
  drop(): Promise<void>;
}

export async function createTestDb(prefix: string): Promise<TestDb> {
  const name = `${prefix}_${process.pid}_${Date.now().toString(36)}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
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

/** Poll until `fn` is truthy (bounded, deterministic condition waits instead of fixed sleeps). */
export async function waitFor(fn: () => Promise<boolean> | boolean, what: string, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Commission rule shared by both apps: 10 percent, half even, integer only. */
export function fee(amount: bigint): bigint {
  const n = amount * 1000n;
  const q = n / 10000n;
  const r = n % 10000n;
  if (r * 2n > 10000n || (r * 2n === 10000n && q % 2n === 1n)) return q + 1n;
  return q;
}
