// Boots inline-marketplace against a throwaway Postgres DB and a fake provider HTTP server.
// The app reads its env at import time, so every test file gets exactly one booted app.
import type { AddressInfo } from "node:net";
import pg from "pg";
import { createTestDb } from "./db.ts";
import { FakeStripe, WHSEC } from "./fake-stripe.ts";

export interface Resp {
  status: number;
  body: Record<string, unknown>;
}

export async function bootInline(opts: { provider: "stripe" | "razorpay"; apiBase: string; extraEnv?: Record<string, string> }) {
  const tdb = await createTestDb(`inl_${opts.provider}`);
  process.env.DATABASE_URL = tdb.url;
  process.env.PAYMENT_PROVIDER = opts.provider;
  if (opts.provider === "stripe") {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
    process.env.MONEYINV_STRIPE_API_BASE = opts.apiBase;
  } else {
    process.env.RAZORPAY_KEY_ID = "rzp_test_x";
    process.env.RAZORPAY_KEY_SECRET = "secret_x";
    process.env.RAZORPAY_WEBHOOK_SECRET = "rzp_whsec_independent";
    process.env.MONEYINV_RAZORPAY_API_BASE = opts.apiBase;
  }
  Object.assign(process.env, opts.extraEnv ?? {});
  const app = await import("../../inline-marketplace/src/server.ts");
  await app.migrate();
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const db = new pg.Client({ connectionString: tdb.url });
  await db.connect();
  // bigint results as bigint
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await db.query(sql, params)).rows as T[];

  const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<Resp> => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const get = async (path: string): Promise<Resp> => {
    const r = await fetch(base + path);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const reset = async () => {
    await db.query("TRUNCATE orders, order_lines, refunds, refund_requests, ledger_entries, processed_events CASCADE");
  };
  const stop = async () => {
    await db.end();
    await app.stop();
    await tdb.drop();
  };
  return { app, base, db, q, post, get, reset, stop };
}
export type Inline = Awaited<ReturnType<typeof bootInline>>;

/** Ledger facts used by many tests. All values are bigint. */
export async function ledgerFacts(h: Inline) {
  const sum = async (where = "true", params: unknown[] = []) =>
    BigInt((await h.q<{ s: string }>(`SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE ${where}`, params))[0]?.s ?? "0");
  const unbalancedTxns = (
    await h.q("SELECT txn_id, currency FROM ledger_entries GROUP BY txn_id, currency HAVING sum(amount) <> 0")
  ).length;
  return { sum, unbalancedTxns, count: async () => Number((await h.q<{ c: string }>("SELECT count(*)::text c FROM ledger_entries"))[0]?.c) };
}
