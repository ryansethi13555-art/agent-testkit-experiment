// Boots the worker-marketplace app (real HTTP server, real Stripe adapter, durable job table) against a FakeStripe.
import type { AddressInfo } from "node:net";
import pg from "pg";
import { createPool, migrate } from "../../worker-marketplace/src/db.ts";
import { providerFromEnv } from "../../worker-marketplace/src/provider.ts";
import { createApp } from "../../worker-marketplace/src/server.ts";
import { FakeStripe, WHSEC } from "./fakeStripe.ts";
import { createDb } from "./pgdb.ts";

export interface Res {
  status: number;
  body: Record<string, any>;
}
export const stripeEnv = (fake: FakeStripe) => ({
  PAYMENT_PROVIDER: "stripe",
  STRIPE_SECRET_KEY: "sk_test_money",
  STRIPE_WEBHOOK_SECRET: WHSEC,
  MONEYINV_STRIPE_API_BASE: fake.base,
});

export async function startWorkerApp(fake: FakeStripe) {
  const dbi = await createDb("mi_worker");
  pg.types.setTypeParser(20, (v: string) => BigInt(v));
  const pool = createPool(dbi.url);
  await migrate(pool);
  const provider = providerFromEnv(stripeEnv(fake));
  let app = createApp(pool, provider);
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const base = () => `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<Res> => {
    const r = await fetch(base() + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const deliver = (ev: { payload: string; header: string }) => post("/webhooks/stripe", ev.payload, { "stripe-signature": ev.header });
  const q = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
  /** Run every job that is due, repeatedly, until none is queued/running (waits out short retry backoff). */
  const drain = async (maxMs = 8000) => {
    const end = Date.now() + maxMs;
    for (;;) {
      while (await app.worker.runOnce()) {}
      const left = await q("SELECT 1 FROM jobs WHERE state IN ('queued','running')");
      if (!left.length || Date.now() > end) return left.length;
      await new Promise((r) => setTimeout(r, 60));
    }
  };
  const reset = async () => {
    await pool.query("TRUNCATE jobs, ledger_entries, allocations, refunds, refund_requests, payments, order_lines, orders RESTART IDENTITY CASCADE");
    fake.reset();
  };
  const payEvent = (pi: string, type = "payment_intent.succeeded", id?: string) => fake.signedEvent(type, { ...fake.pis.get(pi)!, status: fake.pis.get(pi)!.status }, id);
  const refundEvent = (reId: string, type = "refund.updated", id?: string) => fake.signedEvent(type, fake.refunds.get(reId)!, id);
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
    const out = { id: String(o.body.id), lines: o.body.lines as string[], pi: String(co.body.payment_ref), total: BigInt(o.body.total) };
    if (opts.paid) {
      fake.pay(out.pi);
      const r = await deliver(payEvent(out.pi));
      if (r.status !== 200) throw new Error(`webhook failed ${JSON.stringify(r)}`);
      await drain();
    }
    return out;
  };
  const balance = async (account: string, currency = "INR") =>
    BigInt((await q("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE account=$1 AND currency=$2", [account, currency]))[0].s);
  const orderStatus = async (id: string) => (await q("SELECT status FROM orders WHERE id=$1", [id]))[0]?.status as string;
  const refundLedger = async () => q("SELECT kind, account, amount::text a, cause_ref, effect_ref FROM ledger_entries WHERE kind LIKE 'refund%' ORDER BY id");
  const assertSound = async () => {
    const unbalanced = await q("SELECT txn_id FROM ledger_entries GROUP BY txn_id, currency HAVING sum(amount) <> 0");
    if (unbalanced.length) throw new Error(`unbalanced txns ${JSON.stringify(unbalanced)}`);
    const dup = await q("SELECT cause_ref, effect_ref, account, count(*) FROM ledger_entries GROUP BY 1,2,3,currency HAVING count(*) > 1");
    if (dup.length) throw new Error(`duplicate effects ${JSON.stringify(dup)}`);
    const alloc = await q("SELECT order_id, sum(amount)::text s FROM allocations GROUP BY order_id");
    for (const a of alloc) {
      const o = (await q("SELECT total::text t FROM orders WHERE id=$1", [a.order_id]))[0];
      if (o.t !== a.s) throw new Error(`allocations ${a.s} != order total ${o.t}`);
    }
    const sum = (await q("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries"))[0].s;
    if (sum !== "0") throw new Error(`ledger sum ${sum}`);
  };
  /** Simulate a process restart: a brand new app instance over the same database (old one is abandoned). */
  const restart = async () => {
    await app.stop().catch(() => {});
    app = createApp(pool, provider);
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
    return app;
  };
  const stop = async () => {
    await app.stop().catch(() => {});
    await pool.end();
    await dbi.drop();
  };
  return {
    get app() {
      return app;
    },
    pool,
    provider,
    post,
    deliver,
    q,
    drain,
    reset,
    payEvent,
    refundEvent,
    newOrder,
    balance,
    orderStatus,
    refundLedger,
    assertSound,
    restart,
    stop,
  };
}
export type WorkerT = Awaited<ReturnType<typeof startWorkerApp>>;
