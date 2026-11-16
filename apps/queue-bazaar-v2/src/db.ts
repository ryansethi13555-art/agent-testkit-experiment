// Postgres access: pool, schema and a transaction helper. Money columns are bigint (int8 → JS bigint, exact).
import pg from "pg";

pg.types.setTypeParser(20, (v: string) => BigInt(v)); // int8 → bigint

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(url: string | undefined): Db {
  const pool = new pg.Pool({ connectionString: url, max: 20 });
  pool.on("error", (e: Error) => console.error("pg pool error", e.message));
  return pool;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sellers (id text PRIMARY KEY, name text NOT NULL);
INSERT INTO sellers VALUES ('seller_a', 'Asha Crafts'), ('seller_b', 'Bharat Books') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS orders (
  id text PRIMARY KEY,
  buyer text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total bigint NOT NULL CHECK (total > 0),
  capture_method text NOT NULL CHECK (capture_method IN ('automatic', 'manual')),
  status text NOT NULL,
  payment_ref text,
  checkout_create_started boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());

ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_create_started boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS order_lines (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  position int NOT NULL,
  seller_id text NOT NULL REFERENCES sellers(id),
  currency text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  UNIQUE (order_id, position));

-- Provider payment objects known for an order (normally one; a retried checkout may leave more than one).
CREATE TABLE IF NOT EXISTS payments (
  provider_ref text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  status text NOT NULL CHECK (status IN ('pending', 'failed', 'requires_capture', 'succeeded', 'canceled')),
  amount bigint NOT NULL,
  amount_captured bigint NOT NULL DEFAULT 0 CHECK (amount_captured >= 0),
  currency text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS payments_order ON payments (order_id);

-- What the shop asked the provider to refund. 'requested': call in flight; 'sent': the provider has it (linked to a
-- refunds row); 'unknown': no definite answer yet (amount stays reserved); 'rejected': the provider refused it.
CREATE TABLE IF NOT EXISTS refund_requests (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  line_id text NOT NULL REFERENCES order_lines(id),
  currency text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  state text NOT NULL CHECK (state IN ('requested', 'sent', 'unknown', 'rejected')),
  provider_ref text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS refund_requests_line ON refund_requests (line_id);

-- Refunds as the provider knows them (one row per provider refund object), whoever initiated them.
CREATE TABLE IF NOT EXISTS refunds (
  id text PRIMARY KEY,
  provider_ref text NOT NULL UNIQUE,
  request_id text UNIQUE REFERENCES refund_requests(id),
  order_id text NOT NULL REFERENCES orders(id),
  line_id text REFERENCES order_lines(id),
  payment_ref text NOT NULL,
  currency text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  status text NOT NULL CHECK (status IN ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')),
  origin text NOT NULL CHECK (origin IN ('shop', 'provider')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS refunds_order ON refunds (order_id);
CREATE INDEX IF NOT EXISTS refunds_line ON refunds (line_id);

-- Double-entry ledger, debit-positive. cause_ref: the provider object whose outcome justifies the entry.
-- effect_ref: the posting slot within that cause; the unique index makes every slot postable once.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id bigserial PRIMARY KEY,
  txn_id text NOT NULL,
  account text NOT NULL,
  currency text NOT NULL,
  amount bigint NOT NULL CHECK (amount <> 0),
  cause_ref text NOT NULL,
  kind text NOT NULL,
  effect_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS ledger_effect_once ON ledger_entries (cause_ref, effect_ref, account, currency);
CREATE INDEX IF NOT EXISTS ledger_txn ON ledger_entries (txn_id);

-- Every ledger transaction balances per currency, checked at commit.
CREATE OR REPLACE FUNCTION ledger_txn_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM ledger_entries WHERE txn_id = NEW.txn_id GROUP BY currency HAVING sum(amount) <> 0) THEN
    RAISE EXCEPTION 'ledger transaction % does not balance', NEW.txn_id;
  END IF;
  RETURN NULL;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ledger_balanced' AND tgrelid = 'ledger_entries'::regclass) THEN
    CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON ledger_entries
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_txn_balanced();
  END IF;
END $$;

-- How a captured payment was allocated to the order lines (and the commission split of each line).
CREATE TABLE IF NOT EXISTS allocations (
  id text PRIMARY KEY,
  cause_ref text NOT NULL,
  order_id text NOT NULL REFERENCES orders(id),
  line_id text NOT NULL REFERENCES order_lines(id),
  currency text NOT NULL,
  amount bigint NOT NULL,
  seller_amount bigint NOT NULL,
  commission_amount bigint NOT NULL,
  rate_num bigint NOT NULL,
  rate_den bigint NOT NULL,
  rounding text NOT NULL,
  CHECK (seller_amount + commission_amount = amount),
  UNIQUE (cause_ref, line_id));

-- The job queue between webhooks (and recovery work) and the money logic.
CREATE TABLE IF NOT EXISTS jobs (
  id bigserial PRIMARY KEY,
  provider_event_id text UNIQUE,
  type text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  run_after timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs (run_after, id) WHERE state = 'queued';
`;

export async function migrate(db: Db): Promise<void> {
  const c = await db.connect();
  try {
    // serialise concurrent migrations (e.g. two processes starting at once)
    await c.query("SELECT pg_advisory_lock(7262001)");
    await c.query(SCHEMA);
  } finally {
    await c.query("SELECT pg_advisory_unlock(7262001)").catch(() => {});
    c.release();
  }
}

export async function tx<T>(db: Db, fn: (c: Tx) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
