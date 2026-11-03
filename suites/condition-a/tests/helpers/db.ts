import pg from "pg";

export const ADMIN_URL = process.env.MI_PG_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";

export async function isPgUp(): Promise<boolean> {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await c.connect();
    await c.query("SELECT 1");
    await c.end();
    return true;
  } catch {
    return false;
  }
}

export interface TestDatabase {
  readonly dbName: string;
  readonly connectionString: string;
  readonly drop: () => Promise<void>;
  createClient(): Promise<pg.Client>;
}

let dbCounter = 0;

export async function createTestDb(prefix = "test"): Promise<TestDatabase> {
  const sanitized = prefix.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const dbName = `test_${sanitized}_${process.pid}_${++dbCounter}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  const connectionString = url.toString();

  return {
    dbName,
    connectionString,
    async createClient() {
      const client = new pg.Client({ connectionString });
      await client.connect();
      return client;
    },
    async drop() {
      const c = new pg.Client({ connectionString: ADMIN_URL });
      try {
        await c.connect();
        await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } catch (err) {
        console.error(`Failed to drop database ${dbName}:`, err);
      } finally {
        await c.end().catch(() => {});
      }
    },
  };
}
