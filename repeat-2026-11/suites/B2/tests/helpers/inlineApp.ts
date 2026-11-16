// Boots the inline marketplace against a fake Stripe and a fresh database; returns small HTTP helpers.
import type { AddressInfo } from "node:net";
import pg from "pg";
import { FakeStripe, signStripe, stripeEvent, WHSEC } from "./fakeStripe.ts";
import { createTestDb, type TestDb } from "./pg.ts";

export interface Resp {
  status: number;
  body: Record<string, any>;
}

export async function startInline() {
  const fake = new FakeStripe();
  await fake.start();
  const tdb: TestDb = await createTestDb("ind");
  process.env.DATABASE_URL = tdb.url;
  process.env.PAYMENT_PROVIDER = "stripe";
  process.env.STRIPE_SECRET_KEY = "sk_test_independent";
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
  process.env.MONEYINV_STRIPE_API_BASE = fake.base;
  const app = await import("../../inline-marketplace/src/server.ts");
  await app.migrate();
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const db = new pg.Pool({ connectionString: tdb.url, max: 4 });
  pg.types.setTypeParser(20, (v: string) => BigInt(v));

  const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<Resp> => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await r.text();
    let parsed: Record<string, any> = {};
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: r.status, body: parsed };
  };
  let evn = 0;
  const webhook = (event: Record<string, any>, ts?: number) => {
    const s = signStripe(event, WHSEC, ts);
    return post("/webhooks/stripe", s.payload, { "stripe-signature": s.header });
  };
  const newOrder = async (
    lines: { seller_id: string; amount: number | string }[] = [
      { seller_id: "seller_a", amount: 600 },
      { seller_id: "seller_b", amount: 400 },
    ],
    capture: "automatic" | "manual" = "automatic",
    currency = "INR",
  ) => {
    const o = await post("/orders", { buyer: "b1", currency, lines, capture });
    if (o.status !== 201) throw new Error(`order failed ${o.status} ${JSON.stringify(o.body)}`);
    return o.body as { id: string; total: string; lines: string[] };
  };
  const checkedOut = async (...args: Parameters<typeof newOrder>) => {
    const order = await newOrder(...args);
    const co = await post(`/orders/${order.id}/checkout`);
    if (co.status !== 200) throw new Error(`checkout failed ${co.status} ${JSON.stringify(co.body)}`);
    return { order, pi: String(co.body.payment_intent_id) };
  };
  /** checkout + customer pays + signed payment_intent.succeeded delivered */
  const paidOrder = async (...args: Parameters<typeof newOrder>) => {
    const x = await checkedOut(...args);
    fake.pay(x.pi);
    const r = await webhook(stripeEvent(`evt_pay_${++evn}`, "payment_intent.succeeded", fake.snap(fake.pis.get(x.pi) as never)));
    if (r.status !== 200) throw new Error(`payment webhook ${r.status}`);
    return x;
  };
  const refundEvent = (ref: string, type = "refund.updated", id?: string) =>
    stripeEvent(id ?? `evt_rf_${++evn}`, type, fake.snap(fake.refunds.get(ref) as never));
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const reset = async () => {
    await db.query("TRUNCATE orders, order_lines, refunds, refund_requests, ledger_entries, processed_events CASCADE");
    fake.pis.clear();
    fake.refunds.clear();
    fake.idem.clear();
    fake.log.length = 0;
    fake.faults.length = 0;
    fake.newRefundStatus = "succeeded";
    delete (fake as { gate?: unknown }).gate;
  };
  const stop = async () => {
    await db.end();
    await app.stop();
    await fake.stop();
    await tdb.drop();
  };
  return { app, fake, db, post, webhook, newOrder, checkedOut, paidOrder, refundEvent, one, reset, stop, base };
}
export type Inline = Awaited<ReturnType<typeof startInline>>;
export { stripeEvent };
