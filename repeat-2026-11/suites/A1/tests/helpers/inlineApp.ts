// Boots the inline-marketplace app (real HTTP server + real Stripe adapter) against a FakeStripe and a fresh database.
import type { AddressInfo } from "node:net";
import pg from "pg";
import { createDb } from "./pgdb.ts";
import { FakeStripe, WHSEC } from "./fakeStripe.ts";

export interface Res {
  status: number;
  body: Record<string, any>;
}
export async function startInline(fake: FakeStripe) {
  const dbi = await createDb("mi_inline");
  process.env.DATABASE_URL = dbi.url;
  process.env.PAYMENT_PROVIDER = "stripe";
  process.env.STRIPE_SECRET_KEY = "sk_test_money";
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
  process.env.MONEYINV_STRIPE_API_BASE = fake.base;
  const app = await import("../../inline-marketplace/src/server.ts");
  await app.migrate();
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const db = new pg.Client({ connectionString: dbi.url });
  await db.connect();
  const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<Res> => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const deliver = (ev: { payload: string; header: string }): Promise<Res> =>
    post("/webhooks/stripe", ev.payload, { "stripe-signature": ev.header });
  const q = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.query(sql, params)).rows as T[];
  const reset = async () => {
    await db.query("TRUNCATE orders, order_lines, refunds, refund_requests, ledger_entries, processed_events CASCADE");
    fake.reset();
  };
  /** order + checkout (+ provider payment + success webhook when `paid`) */
  const newOrder = async (
    opts: { lines?: { seller_id: string; amount: number | string }[]; currency?: string; capture?: "manual" | "automatic"; paid?: boolean } = {},
  ) => {
    const lines = opts.lines ?? [
      { seller_id: "seller_a", amount: 600 },
      { seller_id: "seller_b", amount: 400 },
    ];
    const o = await post("/orders", { buyer: "b1", currency: opts.currency ?? "INR", lines, capture: opts.capture ?? "automatic" });
    if (o.status !== 201) throw new Error(`order create failed ${JSON.stringify(o)}`);
    const co = await post(`/orders/${o.body.id}/checkout`, {});
    if (co.status !== 200) throw new Error(`checkout failed ${JSON.stringify(co)}`);
    const pi = String(co.body.payment_intent_id);
    const out = { id: String(o.body.id), lines: o.body.lines as string[], pi, total: BigInt(o.body.total) };
    if (opts.paid) {
      const obj = fake.pay(pi);
      const r = await deliver(fake.signedEvent("payment_intent.succeeded", obj));
      if (r.status !== 200) throw new Error(`payment webhook failed ${JSON.stringify(r)}`);
    }
    return out;
  };
  const ledgerRows = () => q("SELECT txn_id, account, currency, amount::text AS amount, cause_ref, kind, effect_ref FROM ledger_entries ORDER BY id");
  const balance = async (account: string, currency = "INR") =>
    BigInt((await q("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE account=$1 AND currency=$2", [account, currency]))[0].s);
  const orderStatus = async (id: string) => (await q("SELECT status FROM orders WHERE id=$1", [id]))[0]?.status as string;
  /** Structural invariants that must hold after ANY sequence of operations. */
  const assertLedgerSound = async () => {
    const unbalanced = await q("SELECT txn_id FROM ledger_entries GROUP BY txn_id, currency HAVING sum(amount) <> 0");
    if (unbalanced.length) throw new Error(`unbalanced ledger txns ${JSON.stringify(unbalanced)}`);
    const dup = await q(
      "SELECT cause_ref, kind, effect_ref, account, count(*) FROM ledger_entries GROUP BY cause_ref, kind, effect_ref, account, currency HAVING count(*) > 1",
    );
    if (dup.length) throw new Error(`duplicate ledger effects ${JSON.stringify(dup)}`);
    const total = (await q("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries"))[0].s;
    if (total !== "0") throw new Error(`ledger does not sum to zero: ${total}`);
  };
  const stop = async () => {
    await db.end();
    await app.stop();
    await dbi.drop();
  };
  return { app, base, db, post, deliver, q, reset, newOrder, ledgerRows, balance, orderStatus, assertLedgerSound, stop };
}
export type Inline = Awaited<ReturnType<typeof startInline>>;
