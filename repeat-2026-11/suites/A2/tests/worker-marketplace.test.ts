// Money-correctness tests for worker-marketplace: webhook -> durable job -> worker -> ledger, over real Postgres,
// with an in-memory provider that can lose responses, apply-then-fail, report partial captures and replay idempotently.
import { randomBytes } from "node:crypto";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Db, migrate } from "../worker-marketplace/src/db.ts";
import { enqueue, Worker } from "../worker-marketplace/src/jobs.ts";
import type { PaymentStatus, RefundStatus } from "../worker-marketplace/src/money.ts";
import {
  type PaymentProvider,
  type PaymentSnapshot,
  ProviderError,
  providerFromEnv,
  type RefundSnapshot,
} from "../worker-marketplace/src/provider.ts";
import { createApp } from "../worker-marketplace/src/server.ts";
import { Shop } from "../worker-marketplace/src/shop.ts";
import { createTestDb, sleep } from "./helpers/db.ts";
import { FakeRazorpay, RZP_WHSEC } from "./helpers/fake-razorpay.ts";

const WHSEC = "whsec_worker_independent";
const realStripe = providerFromEnv({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: WHSEC });
const realRzp = providerFromEnv({ PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: "k", RAZORPAY_KEY_SECRET: "s", RAZORPAY_WEBHOOK_SECRET: RZP_WHSEC });

interface FPay { status: PaymentStatus; amount: bigint; captured: bigint; currency: string; orderId: string | undefined; manual: boolean }
interface FRef { paymentRef: string; amount: bigint; currency: string; status: RefundStatus; requestId: string | undefined }

class Fake implements PaymentProvider {
  readonly name: "stripe" | "razorpay";
  payments = new Map<string, FPay>();
  refunds = new Map<string, FRef>();
  idem = new Map<string, string>();
  n = 0;
  createPaymentCalls = 0;
  createRefundCalls = 0;
  captureCalls = 0;
  refundMode: "ok" | "lose" | "reject" | "not_applied" | "crash" = "ok";
  captureMode: "ok" | "lose" | "reject" = "ok";
  createPaymentMode: "ok" | "lose" = "ok";
  newRefundStatus: RefundStatus = "succeeded";
  refundRequestError?: (amount: bigint, currency: string) => string | undefined;
  constructor(name: "stripe" | "razorpay" = "stripe") {
    this.name = name;
  }
  #pay(ref: string): PaymentSnapshot {
    const p = this.payments.get(ref);
    if (!p) throw new ProviderError("rejected", 404, "no such payment");
    return { ref, status: p.status, amount: p.amount, amountCaptured: p.captured, currency: p.currency, orderId: p.orderId, clientSecret: `${ref}_secret` };
  }
  #ref(ref: string): RefundSnapshot {
    const r = this.refunds.get(ref);
    if (!r) throw new ProviderError("rejected", 404, "no such refund");
    return { ref, paymentRef: r.paymentRef, amount: r.amount, currency: r.currency, status: r.status, requestId: r.requestId };
  }
  async createPayment(p: { orderId: string; amount: bigint; currency: string; capture: "automatic" | "manual" }) {
    this.createPaymentCalls++;
    const key = `checkout_${p.orderId}`;
    let ref = this.idem.get(key);
    if (!ref) {
      ref = `pi_${++this.n}`;
      this.idem.set(key, ref);
      this.payments.set(ref, { status: "pending", amount: p.amount, captured: 0n, currency: p.currency, orderId: p.orderId, manual: p.capture === "manual" });
    }
    if (this.createPaymentMode === "lose") throw new ProviderError("unknown", undefined, "response lost");
    return this.#pay(ref);
  }
  async retrievePayment(ref: string) {
    return this.#pay(ref);
  }
  async capture(ref: string) {
    this.captureCalls++;
    if (this.captureMode === "reject") throw new ProviderError("rejected", 400, "cannot capture");
    const p = this.payments.get(ref);
    if (p?.status === "requires_capture") Object.assign(p, { status: "succeeded", captured: p.amount });
    if (this.captureMode === "lose") throw new ProviderError("unknown", undefined, "timeout after apply");
    return this.#pay(ref);
  }
  async createRefund(paymentRef: string, p: { amount: bigint; idempotencyKey: string; metadata: Record<string, string> }) {
    this.createRefundCalls++;
    if (this.refundMode === "crash") throw new Error("process died");
    if (this.refundMode === "reject") throw new ProviderError("rejected", 400, "provider says no");
    if (this.refundMode === "not_applied") throw new ProviderError("unknown", undefined, "timeout before apply");
    let ref = this.idem.get(`refund:${p.idempotencyKey}`);
    if (!ref) {
      const pay = this.payments.get(paymentRef);
      if (!pay || pay.status !== "succeeded") throw new ProviderError("rejected", 400, "payment not captured");
      const used = [...this.refunds.values()].filter((r) => r.paymentRef === paymentRef && ["pending", "requires_action", "succeeded"].includes(r.status)).reduce((s, r) => s + r.amount, 0n);
      if (p.amount > pay.captured - used) throw new ProviderError("rejected", 400, "amount too large");
      ref = `re_${++this.n}`;
      this.idem.set(`refund:${p.idempotencyKey}`, ref);
      this.refunds.set(ref, { paymentRef, amount: p.amount, currency: pay.currency, status: this.newRefundStatus, requestId: p.metadata.refund_request_id });
    }
    if (this.refundMode === "lose") throw new ProviderError("unknown", undefined, "response lost");
    return this.#ref(ref);
  }
  async retrieveRefund(ref: string) {
    return this.#ref(ref);
  }
  parseWebhook(raw: string, headers: http.IncomingHttpHeaders) {
    return (this.name === "stripe" ? realStripe : realRzp).parseWebhook(raw, headers);
  }
  // ---- test controls
  pay(ref: string) {
    const p = this.payments.get(ref) as FPay;
    if (p.manual) p.status = "requires_capture";
    else Object.assign(p, { status: "succeeded", captured: p.amount });
  }
  dashboardRefund(paymentRef: string, amount: bigint, status: RefundStatus = "succeeded") {
    const pay = this.payments.get(paymentRef) as FPay;
    const ref = `re_dash${++this.n}`;
    this.refunds.set(ref, { paymentRef, amount, currency: pay.currency, status, requestId: undefined });
    return ref;
  }
  lastRefund(): [string, FRef] {
    const e = [...this.refunds.entries()].at(-1);
    if (!e) throw new Error("no refunds at provider");
    return e;
  }
}

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let fake: Fake;
let app: ReturnType<typeof createApp>;
let base = "";

beforeAll(async () => {
  tdb = await createTestDb("wk");
  db = createPool(tdb.url);
  await migrate(db);
});
afterAll(async () => {
  await app?.stop().catch(() => {});
  await db?.end();
  await tdb?.drop();
});
async function boot(f: Fake) {
  await app?.stop().catch(() => {});
  await db.query("TRUNCATE jobs, ledger_entries, allocations, refunds, refund_requests, payments, order_lines, orders RESTART IDENTITY CASCADE");
  fake = f;
  app = createApp(db, fake); // worker is NOT started: tests drain the queue deterministically
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}
beforeEach(async () => {
  await boot(new Fake());
});

// ------------------------------------------------------------------------------------------------ helpers
type Resp = { status: number; body: Record<string, unknown> };
const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<Resp> => {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const get = async (path: string): Promise<Resp> => {
  const r = await fetch(base + path);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const drain = async () => {
  let n = 0;
  while (await app.worker.runOnce()) n++;
  return n;
};
const rewind = () => db.query("UPDATE jobs SET run_after = now() WHERE state = 'queued'");
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
const count = async (table: string, where = "true") => Number((await q<{ c: string }>(`SELECT count(*)::text c FROM ${table} WHERE ${where}`))[0]?.c);
const sum = async (where = "true", params: unknown[] = []) => BigInt((await q<{ s: string }>(`SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE ${where}`, params))[0]?.s ?? "0");
const orderStatus = async (id: string) => String((await q("SELECT status FROM orders WHERE id=$1", [id]))[0]?.status);

let evn = 0;
const stripeHook = (type: string, obj: Record<string, unknown>, id = `evt_${++evn}_${randomBytes(3).toString("hex")}`, secret = WHSEC) => {
  const payload = JSON.stringify({ id, object: "event", type, data: { object: obj } });
  return post("/webhooks/stripe", payload, { "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload, secret }) });
};
const payEvt = (ref: string, id?: string) => stripeHook("payment_intent.succeeded", { id: ref, object: "payment_intent" }, id);
const refEvt = (ref: string, pi: string, id?: string, type = "refund.updated") => stripeHook(type, { id: ref, object: "refund", payment_intent: pi }, id);

const TWO = [
  { seller_id: "seller_a", amount: 1000 },
  { seller_id: "seller_b", amount: 500 },
];
async function newOrder(lines: unknown[] = TWO, extra: Record<string, unknown> = {}) {
  const r = await post("/orders", { buyer: "b", lines, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: String(r.body.id), lines: r.body.lines as string[] };
}
async function checkout(id: string) {
  const r = await post(`/orders/${id}/checkout`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return String(r.body.payment_ref);
}
async function paid(lines: unknown[] = TWO, extra: Record<string, unknown> = {}) {
  const o = await newOrder(lines, extra);
  const ref = await checkout(o.id);
  fake.pay(ref);
  expect((await payEvt(ref)).status).toBe(200);
  await drain();
  return { ...o, ref };
}

async function consistent() {
  expect((await q("SELECT txn_id FROM ledger_entries GROUP BY txn_id, currency HAVING sum(amount) <> 0")).length).toBe(0);
  expect(await sum()).toBe(0n);
  // clearing = captured and allocated money - live refunds
  const captured = BigInt((await q<{ s: string }>("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE account='provider:clearing' AND kind='sale'"))[0]?.s ?? "0");
  const live = BigInt((await q<{ s: string }>("SELECT coalesce(sum(amount),0)::text s FROM refunds WHERE status IN ('pending','requires_action','succeeded')"))[0]?.s ?? "0");
  expect(await sum("account='provider:clearing'")).toBe(captured - live);
  for (const r of await q<{ provider_ref: string; amount: string; status: string }>("SELECT * FROM refunds")) {
    const holds = ["pending", "requires_action", "succeeded"].includes(r.status);
    expect(await sum("cause_ref=$1 AND account='provider:clearing'", [r.provider_ref]), `refund ${r.provider_ref}`).toBe(holds ? -BigInt(r.amount) : 0n);
    expect(await sum("cause_ref=$1", [r.provider_ref])).toBe(0n);
  }
  // each provider object is recognised at most once per slot
  expect((await q("SELECT 1 FROM ledger_entries GROUP BY cause_ref, effect_ref, account, currency HAVING count(*) > 1")).length).toBe(0);
}

// ------------------------------------------------------------------------------------------------ orders
describe("orders", () => {
  it.each([
    ["no lines", { lines: [] }],
    ["not an array", { lines: "x" }],
    ["21 lines", { lines: Array.from({ length: 21 }, () => ({ seller_id: "seller_a", amount: 1 })) }],
    ["zero", { lines: [{ seller_id: "seller_a", amount: 0 }] }],
    ["negative", { lines: [{ seller_id: "seller_a", amount: -1 }] }],
    ["fraction", { lines: [{ seller_id: "seller_a", amount: 1.25 }] }],
    ["string with decimals", { lines: [{ seller_id: "seller_a", amount: "1.00" }] }],
    ["exponent", { lines: [{ seller_id: "seller_a", amount: "1e3" }] }],
    ["too large", { lines: [{ seller_id: "seller_a", amount: 1_000_000_000_000 }] }],
    ["sum too large", { lines: [{ seller_id: "seller_a", amount: 999_999_999_999 }, { seller_id: "seller_b", amount: 1 }] }],
    ["unknown seller", { lines: [{ seller_id: "seller_zzz", amount: 10 }] }],
    ["missing seller", { lines: [{ amount: 10 }] }],
    ["bad currency", { currency: "RS", lines: [{ seller_id: "seller_a", amount: 10 }] }],
    ["bad capture", { capture: "sometimes", lines: [{ seller_id: "seller_a", amount: 10 }] }],
  ])("rejects %s and writes nothing", async (_n, body) => {
    expect((await post("/orders", body)).status).toBe(400);
    expect(await count("orders")).toBe(0);
    expect(await count("order_lines")).toBe(0);
  });
  it("non-object and invalid JSON bodies are 400", async () => {
    expect((await post("/orders", "[1,2]")).status).toBe(400);
    expect((await post("/orders", "{nope")).status).toBe(400);
  });
  it("stores exact bigint money and normalises currency; GET shows lines and refunds", async () => {
    const o = await post("/orders", { currency: "usd", lines: [{ seller_id: "seller_a", amount: "999999999999" }] });
    expect(o.status).toBe(201);
    expect(o.body.total).toBe("999999999999");
    expect(o.body.currency).toBe("USD");
    const g = await get(`/orders/${o.body.id}`);
    expect(g.status).toBe(200);
    expect(g.body.status).toBe("pending_payment");
    expect(await get("/orders/ord_nothere")).toMatchObject({ status: 404 });
  });
});

// ------------------------------------------------------------------------------------------------ webhooks & queue
describe("webhooks only enqueue; the provider object decides", () => {
  it("acknowledges a valid webhook, books nothing until the worker runs", async () => {
    const o = await newOrder();
    const ref = await checkout(o.id);
    fake.pay(ref);
    expect((await payEvt(ref)).status).toBe(200);
    expect(await count("ledger_entries")).toBe(0);
    expect(await count("jobs", "state='queued'")).toBe(1);
    await drain();
    expect(await orderStatus(o.id)).toBe("paid");
    await consistent();
  });
  it("rejects bad signatures, bad secrets and malformed bodies without enqueueing", async () => {
    const o = await newOrder();
    const ref = await checkout(o.id);
    expect((await stripeHook("payment_intent.succeeded", { id: ref, object: "payment_intent" }, "evt_bad", "whsec_other")).status).toBe(400);
    expect((await post("/webhooks/stripe", "{}", {})).status).toBe(400);
    expect((await post("/webhooks/stripe", "not json", { "stripe-signature": "t=1,v1=00" })).status).toBe(400);
    expect(await count("jobs")).toBe(0);
  });
  it("ignores objects it does not track", async () => {
    expect((await stripeHook("customer.created", { id: "cus_1", object: "customer" })).status).toBe(200);
    expect(await count("jobs")).toBe(0);
  });
  it("a body that claims success while the provider says pending books nothing", async () => {
    const o = await newOrder();
    const ref = await checkout(o.id);
    await payEvt(ref);
    await drain();
    expect(await count("ledger_entries")).toBe(0);
    expect(await orderStatus(o.id)).toBe("pending_payment");
  });
  it("redelivery of one event id creates one job; many ids and concurrent reconciles still book once", async () => {
    const o = await newOrder();
    const ref = await checkout(o.id);
    fake.pay(ref);
    await Promise.all(Array.from({ length: 6 }, () => payEvt(ref, "evt_same")));
    expect(await count("jobs")).toBe(1);
    for (let i = 0; i < 4; i++) await payEvt(ref);
    await drain();
    await Promise.all(Array.from({ length: 8 }, () => app.shop.reconcilePayment(ref)));
    await post(`/orders/${o.id}/confirm`);
    await payEvt(ref, "evt_same"); // a late redelivery after the job completed
    await drain();
    expect(await count("ledger_entries", "kind='sale'")).toBe(1 + 2);
    expect(await count("ledger_entries", "kind='commission'")).toBe(2);
    expect(await count("allocations")).toBe(2);
    await consistent();
  });
  it("a charge event is mapped to its payment intent", async () => {
    const o = await newOrder();
    const ref = await checkout(o.id);
    fake.pay(ref);
    await stripeHook("charge.succeeded", { id: "ch_1", object: "charge", payment_intent: ref });
    await drain();
    expect(await orderStatus(o.id)).toBe("paid");
  });
  it("confirm without any payment is 409", async () => {
    const o = await newOrder();
    expect((await post(`/orders/${o.id}/confirm`)).status).toBe(409);
  });
});

describe("job queue", () => {
  const mk = (handlers: Partial<Record<string, (p: Record<string, string>) => Promise<void>>>, maxAttempts?: { default: number }) =>
    new Worker(db, new Proxy({}, { get: (_t, k) => handlers[String(k)] ?? (async () => {}) }) as never, maxAttempts ? { maxAttempts } : {});
  it("dedupes by key, but re-queues a job that failed for good", async () => {
    await enqueue(db, "payment", { ref: "x" }, "k1");
    await enqueue(db, "payment", { ref: "x" }, "k1");
    expect(await count("jobs")).toBe(1);
    await db.query("UPDATE jobs SET state='failed', attempts=25");
    await enqueue(db, "payment", { ref: "x" }, "k1");
    expect(await count("jobs")).toBe(1);
    const j = (await q<{ state: string; attempts: number }>("SELECT * FROM jobs"))[0];
    expect(j?.state).toBe("queued");
    expect(j?.attempts).toBe(0);
    await db.query("UPDATE jobs SET state='done'");
    await enqueue(db, "payment", { ref: "x" }, "k1");
    expect((await q<{ state: string }>("SELECT state FROM jobs"))[0]?.state).toBe("done");
  });
  it("retries a failing handler with backoff and parks it as failed after the attempt budget", async () => {
    await enqueue(db, "payment", { ref: "x" }, "k2");
    let calls = 0;
    const w = mk({ payment: async () => { calls++; throw new Error("boom"); } }, { default: 3 });
    expect(await w.runOnce()).toBe(true);
    expect(await w.runOnce()).toBe(false); // not due yet (backoff)
    for (let i = 0; i < 2; i++) {
      await rewind();
      await w.runOnce();
    }
    expect(calls).toBe(3);
    const j = (await q<{ state: string; last_error: string }>("SELECT * FROM jobs"))[0];
    expect(j?.state).toBe("failed");
    expect(j?.last_error).toBe("boom");
    await rewind();
    expect(await w.runOnce()).toBe(false);
  });
  it("recover() re-queues jobs a crashed process left running", async () => {
    await enqueue(db, "payment", { ref: "x" }, "k3");
    await db.query("UPDATE jobs SET state='running'");
    const w = mk({});
    expect(await w.recover()).toBe(1);
    expect(await w.runOnce()).toBe(true);
    expect((await q<{ state: string }>("SELECT state FROM jobs"))[0]?.state).toBe("done");
  });
  it("concurrent workers never run the same job twice", async () => {
    for (let i = 0; i < 40; i++) await enqueue(db, "payment", { ref: `p${i}` }, `bulk${i}`);
    const seen: string[] = [];
    const handler = async (p: Record<string, string>) => {
      seen.push(String(p.ref));
      await sleep(2);
    };
    const workers = Array.from({ length: 5 }, () => mk({ payment: handler }));
    await Promise.all(
      workers.map(async (w) => {
        while (await w.runOnce()) {}
      }),
    );
    expect(seen.length).toBe(40);
    expect(new Set(seen).size).toBe(40);
    expect(await count("jobs", "state='done'")).toBe(40);
  });
});

// ------------------------------------------------------------------------------------------------ sale booking
describe("recording a sale", () => {
  it("posts clearing = sellers + commission, allocation rows that add up, balanced per transaction", async () => {
    const o = await paid([
      { seller_id: "seller_a", amount: 15 },
      { seller_id: "seller_b", amount: 25 },
      { seller_id: "seller_a", amount: 4 },
    ]);
    expect(await sum("account='provider:clearing'")).toBe(44n);
    expect(await sum("account='seller:seller_a'")).toBe(-(15n - 2n) - 4n); // fee(15)=2 (tie, odd -> up), fee(4)=0
    expect(await sum("account='seller:seller_b'")).toBe(-(25n - 2n)); // fee(25)=2 (tie, even stays)
    expect(await sum("account='platform:commission'")).toBe(-4n);
    const al = await q<{ amount: string; seller_amount: string; commission_amount: string }>("SELECT * FROM allocations");
    expect(al).toHaveLength(3);
    for (const a of al) expect(BigInt(a.seller_amount) + BigInt(a.commission_amount)).toBe(BigInt(a.amount));
    expect(await orderStatus(o.id)).toBe("paid");
    await consistent();
  });
  it("USD sale books only USD", async () => {
    await paid([{ seller_id: "seller_a", amount: 777 }], { currency: "USD" });
    expect((await q<{ currency: string }>("SELECT DISTINCT currency FROM ledger_entries")).map((r) => r.currency)).toEqual(["USD"]);
    await consistent();
  });
  it("a stale or contradictory snapshot after success cannot undo or change the booked sale", async () => {
    const o = await paid();
    const p = fake.payments.get(o.ref) as FPay;
    const before = await count("ledger_entries");
    Object.assign(p, { status: "pending", captured: 0n });
    await app.shop.reconcilePayment(o.ref).catch(() => {});
    Object.assign(p, { status: "pending", captured: 1500n }); // same captured, older status
    await app.shop.reconcilePayment(o.ref).catch(() => {});
    Object.assign(p, { status: "succeeded", captured: 1499n }); // money changed after the fact
    await expect(app.shop.reconcilePayment(o.ref)).rejects.toThrow();
    expect(await count("ledger_entries")).toBe(before);
    expect(await orderStatus(o.id)).toBe("paid");
    expect((await q<{ status: string; amount_captured: string }>("SELECT * FROM payments"))[0]).toMatchObject({ status: "succeeded", amount_captured: 1500n });
  });
  it("refuses a snapshot in another currency", async () => {
    const o = await newOrder();
    const ref = await checkout(o.id);
    fake.pay(ref);
    (fake.payments.get(ref) as FPay).currency = "USD";
    await expect(app.shop.reconcilePayment(ref)).rejects.toThrow();
    expect(await count("ledger_entries")).toBe(0);
    expect(await orderStatus(o.id)).toBe("pending_payment");
  });
  it("a partial capture is not booked as the order's sale: it goes to suspense and nothing is allocated to sellers", async () => {
    const o = await newOrder();
    const ref = await checkout(o.id);
    Object.assign(fake.payments.get(ref) as FPay, { status: "succeeded", captured: 600n });
    await app.shop.reconcilePayment(ref);
    expect(await sum("account='platform:unallocated_receipts'")).toBe(-600n);
    expect(await sum("account='provider:clearing'")).toBe(600n);
    expect(await count("allocations")).toBe(0);
    expect(await sum("account LIKE 'seller:%'")).toBe(0n);
    // no line can be refunded against money that was never allocated to it
    const r = await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 });
    expect(r.status).toBe(409);
    expect(fake.createRefundCalls).toBe(0);
  });
  it("a second captured payment for an already paid order goes to suspense, never to the sellers again", async () => {
    const o = await paid();
    fake.payments.set("pi_dup", { status: "succeeded", amount: 1500n, captured: 1500n, currency: "INR", orderId: o.id, manual: false });
    await app.shop.reconcilePayment("pi_dup");
    expect(await sum("account='seller:seller_a'")).toBe(-900n);
    expect(await sum("account='platform:unallocated_receipts'")).toBe(-1500n);
    expect(await count("allocations")).toBe(2);
    await app.shop.reconcilePayment("pi_dup");
    expect(await count("ledger_entries", "cause_ref='pi_dup'")).toBe(2);
    await consistent();
  });
  it("a payment belonging to no known order is ignored and books nothing", async () => {
    fake.payments.set("pi_alien", { status: "succeeded", amount: 100n, captured: 100n, currency: "INR", orderId: "ord_unknown", manual: false });
    expect(await app.shop.reconcilePayment("pi_alien")).toBeUndefined();
    expect(await count("ledger_entries")).toBe(0);
  });
  it("a payment whose metadata names a different order than the one it is stored under is refused", async () => {
    const o1 = await newOrder();
    const o2 = await newOrder();
    const ref = await checkout(o1.id);
    fake.pay(ref);
    (fake.payments.get(ref) as FPay).orderId = o2.id;
    await expect(app.shop.reconcilePayment(ref)).rejects.toThrow();
    expect(await count("ledger_entries")).toBe(0);
  });
  it("reports authorised and cancelled orders from money facts", async () => {
    const m = await newOrder(TWO, { capture: "manual" });
    const ref = await checkout(m.id);
    fake.pay(ref);
    await app.shop.reconcilePayment(ref);
    expect(await orderStatus(m.id)).toBe("authorized");
    expect(await count("ledger_entries")).toBe(0);
    (fake.payments.get(ref) as FPay).status = "canceled";
    await app.shop.reconcilePayment(ref);
    expect(await orderStatus(m.id)).toBe("canceled");
  });
});

// ------------------------------------------------------------------------------------------------ checkout / capture
describe("checkout and capture", () => {
  it("a lost create response never causes a second provider payment, even across restarts", async () => {
    const o = await newOrder();
    fake.createPaymentMode = "lose";
    expect((await post(`/orders/${o.id}/checkout`)).status).toBe(502);
    fake.createPaymentMode = "ok";
    expect((await post(`/orders/${o.id}/checkout`)).status).toBe(502);
    const restarted = new Shop(db, fake);
    await expect(restarted.checkout(o.id)).rejects.toThrow(/unknown/);
    expect(fake.createPaymentCalls).toBe(1);
    expect(fake.payments.size).toBe(1);
    // once the provider object is observed the identity is recovered
    await app.shop.reconcilePayment([...fake.payments.keys()][0] as string);
    expect(await checkout(o.id)).toBe([...fake.payments.keys()][0]);
    expect(fake.createPaymentCalls).toBe(1);
  });
  it("concurrent checkouts create exactly one provider payment", async () => {
    const o = await newOrder();
    await Promise.all(Array.from({ length: 12 }, () => post(`/orders/${o.id}/checkout`)));
    expect(fake.createPaymentCalls).toBe(1);
  });
  it("a paid order cannot be checked out again", async () => {
    const o = await paid();
    expect((await post(`/orders/${o.id}/checkout`)).status).toBe(409);
  });
  it("manual capture books once; a repeat capture does not capture or book again", async () => {
    const o = await newOrder(TWO, { capture: "manual" });
    const ref = await checkout(o.id);
    expect((await post(`/orders/${o.id}/capture`)).status).toBe(409); // nothing authorised yet
    fake.pay(ref);
    const c = await post(`/orders/${o.id}/capture`);
    expect(c.status).toBe(200);
    expect(c.body.status).toBe("paid");
    expect((await post(`/orders/${o.id}/capture`)).body.status).toBe("paid");
    expect(fake.captureCalls).toBe(1);
    expect(await count("ledger_entries", "kind='sale'")).toBe(3);
    await consistent();
  });
  it("a capture whose outcome is unknown is reconciled from the provider object by the queue, booking once", async () => {
    const o = await newOrder(TWO, { capture: "manual" });
    const ref = await checkout(o.id);
    fake.pay(ref);
    fake.captureMode = "lose";
    expect((await post(`/orders/${o.id}/capture`)).status).toBe(502);
    expect(await count("ledger_entries")).toBe(0);
    expect(await count("jobs", "type='reconcile_payment' AND state='queued'")).toBe(1);
    fake.captureMode = "ok";
    await drain();
    expect(await orderStatus(o.id)).toBe("paid");
    expect(await count("ledger_entries", "kind='sale'")).toBe(3);
    await payEvt(ref);
    await drain();
    expect(await count("ledger_entries", "kind='sale'")).toBe(3);
    await consistent();
  });
  it("a rejected capture books nothing", async () => {
    const o = await newOrder(TWO, { capture: "manual" });
    const ref = await checkout(o.id);
    fake.pay(ref);
    fake.captureMode = "reject";
    expect((await post(`/orders/${o.id}/capture`)).status).toBe(409);
    expect(await count("ledger_entries")).toBe(0);
    expect(await orderStatus(o.id)).toBe("authorized");
  });
});

// ------------------------------------------------------------------------------------------------ refunds
describe("refund requests", () => {
  it.each([[0], [-5], [1.5], ["abc"], ["1e2"], [null], [1_000_000_000_000]])("rejects amount %j before reserving anything", async (amount) => {
    const o = await paid();
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount })).status).toBe(400);
    expect(await count("refund_requests")).toBe(0);
    expect(fake.createRefundCalls).toBe(0);
  });
  it("rejects unknown lines, other orders' lines, unpaid orders and unknown orders", async () => {
    const o = await paid();
    const other = await paid();
    expect((await post(`/orders/${o.id}/refunds`, { line_id: "x", amount: 10 })).status).toBe(404);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: other.lines[0], amount: 10 })).status).toBe(404);
    expect((await post(`/orders/ord_nope/refunds`, { line_id: "x", amount: 10 })).status).toBe(404);
    const unpaid = await newOrder();
    expect((await post(`/orders/${unpaid.id}/refunds`, { line_id: unpaid.lines[0], amount: 10 })).status).toBe(409);
    expect(fake.createRefundCalls).toBe(0);
  });
  it("partial refund reverses the right seller, links the request and updates the order", async () => {
    const o = await paid();
    const r = await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 300 });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("succeeded");
    expect(await sum("kind='refund' AND account='seller:seller_a'")).toBe(300n);
    expect(await sum("kind='refund' AND account='seller:seller_b'")).toBe(0n);
    expect((await q<{ state: string; provider_ref: string }>("SELECT * FROM refund_requests"))[0]).toMatchObject({ state: "sent" });
    expect((await q<{ origin: string; line_id: string }>("SELECT * FROM refunds"))[0]).toMatchObject({ origin: "shop", line_id: o.lines[0] });
    expect(await orderStatus(o.id)).toBe("partially_refunded");
    await consistent();
  });
  it("full refunds of every line end in refunded and block further refunds", async () => {
    const o = await paid();
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 1000 })).status).toBe(200);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 500 })).status).toBe(200);
    expect(await orderStatus(o.id)).toBe("refunded");
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 1 })).status).toBe(400);
    expect(fake.createRefundCalls).toBe(2);
    await consistent();
  });
  it("never exceeds the line over successive requests", async () => {
    const o = await paid();
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 200 })).status).toBe(200);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 301 })).status).toBe(400);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 300 })).status).toBe(200);
  });
  it("parallel refunds cannot over-refund a line", async () => {
    const o = await paid([{ seller_id: "seller_a", amount: 500 }]);
    const rs = await Promise.all(Array.from({ length: 12 }, () => post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 })));
    expect(rs.filter((r) => r.status === 200).length).toBe(5);
    expect(rs.filter((r) => r.status === 400).length).toBe(7);
    expect(fake.createRefundCalls).toBe(5);
    expect(await orderStatus(o.id)).toBe("refunded");
    await consistent();
  });
  it("parallel refunds on different lines respect the whole payment too", async () => {
    const o = await paid();
    await Promise.all([
      ...Array.from({ length: 5 }, () => post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 400 })),
      ...Array.from({ length: 5 }, () => post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 400 })),
    ]);
    const total = BigInt((await q<{ s: string }>("SELECT coalesce(sum(amount),0)::text s FROM refunds"))[0]?.s ?? "0");
    expect(total).toBe(1200n); // 2 x 400 on the 1000 line, 1 x 400 on the 500 line
    await consistent();
  });
  it("refunds taken in the provider dashboard reduce what the shop may still refund", async () => {
    const o = await paid();
    fake.dashboardRefund(o.ref, 1200n);
    const ref = fake.lastRefund()[0];
    await refEvt(ref, o.ref);
    await drain();
    expect(await sum("account='platform:unallocated_refunds'")).toBe(1200n);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 301 })).status).toBe(400);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 300 })).status).toBe(200);
    expect(await orderStatus(o.id)).toBe("refunded");
    await consistent();
  });
  it("a refund event before the payment event reconciles the payment first, in any delivery order", async () => {
    const o = await newOrder();
    const ref = await checkout(o.id);
    fake.pay(ref);
    const rid = fake.dashboardRefund(ref, 100n);
    await refEvt(rid, ref);
    await drain();
    expect(await orderStatus(o.id)).toBe("partially_refunded");
    expect(await count("ledger_entries", "kind='sale'")).toBe(3);
    expect(await count("ledger_entries", "kind='refund'")).toBe(2);
    await payEvt(ref);
    await refEvt(rid, ref);
    await drain();
    expect(await count("ledger_entries", "kind='refund'")).toBe(2);
    await consistent();
  });
  it("a refund for a payment of no known order is not recorded", async () => {
    fake.payments.set("pi_alien", { status: "succeeded", amount: 100n, captured: 100n, currency: "INR", orderId: undefined, manual: false });
    const rid = fake.dashboardRefund("pi_alien", 50n);
    await refEvt(rid, "pi_alien");
    await drain();
    expect(await count("refunds")).toBe(0);
    expect(await count("ledger_entries")).toBe(0);
  });
  it("sends the request id as idempotency key and identifying metadata", async () => {
    const o = await paid();
    const seen: { key: string; meta: Record<string, string> }[] = [];
    const orig = fake.createRefund.bind(fake);
    fake.createRefund = async (p, a) => (seen.push({ key: a.idempotencyKey, meta: a.metadata }), orig(p, a));
    await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 50 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.meta).toMatchObject({ order_id: o.id, line_id: o.lines[0], refund_request_id: seen[0]?.key });
  });
  it("INR refunds below the provider's 100 minor unit minimum are refused before any reservation", async () => {
    fake.refundRequestError = realRzp.refundRequestError as never;
    const o = await paid([{ seller_id: "seller_a", amount: 5000 }]);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 99 })).status).toBe(400);
    expect(await count("refund_requests")).toBe(0);
    expect(fake.createRefundCalls).toBe(0);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 })).status).toBe(200);
  });
});

describe("refunds with uncertain outcomes", () => {
  it("a definitive provider rejection releases the reservation", async () => {
    const o = await paid([{ seller_id: "seller_a", amount: 500 }]);
    fake.refundMode = "reject";
    const r = await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 500 });
    expect(r.status).toBe(409);
    expect((await q<{ state: string }>("SELECT state FROM refund_requests"))[0]?.state).toBe("rejected");
    fake.refundMode = "ok";
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 500 })).status).toBe(200);
    await consistent();
  });

  it("a lost response keeps the amount reserved, is never re-sent by the queue, and is linked by the provider's own event", async () => {
    const o = await paid();
    fake.refundMode = "lose";
    const r = await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 400 });
    expect(r.status).toBe(202);
    const req = (await q<{ id: string; state: string }>("SELECT * FROM refund_requests"))[0];
    expect(req?.state).toBe("unknown");
    expect(fake.refunds.size).toBe(1); // the provider did refund
    expect(await count("refunds")).toBe(0);
    expect(await count("ledger_entries", "kind='refund'")).toBe(0);
    fake.refundMode = "ok";
    // reservation holds: only 600 of the 1000 line is free
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 601 })).status).toBe(400);
    // the resolver runs to its attempt limit without re-posting, then leaves a dead letter
    for (let i = 0; i < 8; i++) {
      await rewind();
      await drain();
    }
    expect(fake.createRefundCalls).toBe(1);
    expect((await q<{ state: string }>("SELECT state FROM jobs WHERE type='resolve_refund_request'"))[0]?.state).toBe("failed");
    expect((await q<{ state: string }>("SELECT state FROM refund_requests"))[0]?.state).toBe("unknown");
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 601 })).status).toBe(400);
    // the provider's event arrives (twice): exact link, one booking, dead letter retired
    const [rid] = fake.lastRefund();
    await refEvt(rid, o.ref);
    await refEvt(rid, o.ref);
    await drain();
    expect((await q<{ state: string; provider_ref: string }>("SELECT * FROM refund_requests"))[0]).toMatchObject({ state: "sent", provider_ref: rid });
    expect((await q<{ origin: string; request_id: string }>("SELECT * FROM refunds"))).toHaveLength(1);
    expect((await q<{ state: string }>("SELECT state FROM jobs WHERE type='resolve_refund_request'"))[0]?.state).toBe("done");
    expect(await count("ledger_entries", "kind='refund'")).toBe(2);
    expect(await sum("kind='refund' AND account='seller:seller_a'")).toBe(400n);
    // capacity: 1000 - 400, with no double count of reservation plus refund
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 600 })).status).toBe(200);
    expect(await orderStatus(o.id)).toBe("partially_refunded");
    await consistent();
  });

  it("a timeout where nothing was applied still keeps the reservation (non-commit cannot be proven)", async () => {
    const o = await paid();
    fake.refundMode = "not_applied";
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 100 })).status).toBe(202);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 401 })).status).toBe(400);
    expect(fake.createRefundCalls).toBe(1);
  });

  it("a crash inside the refund call is treated as unknown, not as failure", async () => {
    const o = await paid();
    fake.refundMode = "crash";
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 100 })).status).toBe(202);
    expect((await q<{ state: string }>("SELECT state FROM refund_requests"))[0]?.state).toBe("unknown");
  });

  it("restart recovery turns in-flight requests into unknown ones with a resolver job, and re-queues running jobs", async () => {
    const o = await paid();
    await db.query("INSERT INTO refund_requests (id, order_id, line_id, currency, amount, state) VALUES ('rr_crash', $1, $2, 'INR', 250, 'requested')", [o.id, o.lines[0]]);
    await enqueue(db, "payment", { ref: o.ref }, "running-one");
    await db.query("UPDATE jobs SET state='running' WHERE provider_event_id='running-one'");
    expect(await app.worker.recover()).toBe(1);
    expect(await app.shop.recoverRefundRequests()).toBe(1);
    expect((await q<{ state: string }>("SELECT state FROM refund_requests WHERE id='rr_crash'"))[0]?.state).toBe("unknown");
    expect(await count("jobs", "type='resolve_refund_request'")).toBe(1);
    expect(fake.createRefundCalls).toBe(0); // recovery never re-sends
    // still reserved
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 751 })).status).toBe(400);
    expect((await q<{ state: string }>("SELECT state FROM jobs WHERE provider_event_id='running-one'"))[0]?.state).toBe("queued");
  });

  it("a provider refund that claims a request but with different money is refused and booked nowhere", async () => {
    const o = await paid();
    fake.refundMode = "lose";
    await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 400 });
    const req = (await q<{ id: string }>("SELECT id FROM refund_requests"))[0] as { id: string };
    const [rid, r] = fake.lastRefund();
    r.amount = 399n;
    r.requestId = req.id;
    await refEvt(rid, o.ref);
    await drain();
    expect(await count("refunds")).toBe(0);
    expect(await count("ledger_entries", "kind='refund'")).toBe(0);
    expect((await q<{ state: string }>("SELECT state FROM refund_requests"))[0]?.state).toBe("unknown");
  });

  it("a refund whose request belongs to another order is refused", async () => {
    const o1 = await paid();
    const o2 = await paid();
    fake.refundMode = "lose";
    await post(`/orders/${o1.id}/refunds`, { line_id: o1.lines[0], amount: 400 });
    const req = (await q<{ id: string }>("SELECT id FROM refund_requests"))[0] as { id: string };
    const rid = fake.dashboardRefund(o2.ref, 400n);
    (fake.refunds.get(rid) as FRef).requestId = req.id;
    await refEvt(rid, o2.ref);
    await drain();
    expect(await count("refunds")).toBe(0);
  });
});

describe("refund lifecycle", () => {
  it("pending is recognised once, succeeded does not rebook, failed reverses once and returns capacity", async () => {
    fake.newRefundStatus = "pending";
    const o = await paid();
    const r = await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 300 });
    expect(r.body.status).toBe("pending");
    expect(await count("ledger_entries", "kind='refund'")).toBe(2);
    const [rid, pr] = fake.lastRefund();
    pr.status = "succeeded";
    await refEvt(rid, o.ref);
    await drain();
    expect(await count("ledger_entries", "kind='refund'")).toBe(2);
    expect((await q<{ status: string }>("SELECT status FROM refunds"))[0]?.status).toBe("succeeded");
    pr.status = "failed";
    await refEvt(rid, o.ref);
    await refEvt(rid, o.ref);
    await refEvt(rid, o.ref, undefined, "refund.failed");
    await drain();
    expect(await count("ledger_entries", "kind='refund_reversal'")).toBe(2);
    expect(await sum("cause_ref=$1", [rid])).toBe(0n);
    expect(await orderStatus(o.id)).toBe("paid");
    await consistent();
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 1000 })).status).toBe(200); // the failed one no longer consumes the line
  });

  it("failure frees the line again (provider agrees)", async () => {
    fake.newRefundStatus = "pending";
    const o = await paid([{ seller_id: "seller_a", amount: 500 }]);
    await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 500 });
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 1 })).status).toBe(400);
    const [rid, pr] = fake.lastRefund();
    pr.status = "canceled";
    await refEvt(rid, o.ref);
    await drain();
    expect(await orderStatus(o.id)).toBe("paid");
    fake.newRefundStatus = "succeeded";
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 500 })).status).toBe(200);
    await consistent();
  });

  it("a failed refund reported as holding money again is not re-recognised (needs review), ledger untouched", async () => {
    const o = await paid();
    await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 300 });
    const [rid, pr] = fake.lastRefund();
    pr.status = "failed";
    await refEvt(rid, o.ref);
    await drain();
    const before = await count("ledger_entries");
    pr.status = "succeeded";
    await refEvt(rid, o.ref);
    await rewind();
    await drain();
    expect((await q<{ status: string }>("SELECT status FROM refunds"))[0]?.status).toBe("failed");
    expect(await count("ledger_entries")).toBe(before);
    await consistent();
  });

  it("an idempotent replay of the create response cannot overwrite a newer status", async () => {
    const o = await paid();
    const r = await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 });
    expect(r.status).toBe(200);
    const [rid, pr] = fake.lastRefund();
    pr.status = "failed";
    await refEvt(rid, o.ref);
    await drain();
    expect((await q<{ status: string }>("SELECT status FROM refunds"))[0]?.status).toBe("failed");
    // replaying the original create (same request id, same key) hands back the provider's current object, never stale state
    const req = (await q<{ id: string }>("SELECT id FROM refund_requests"))[0] as { id: string };
    pr.status = "succeeded"; // an older body
    await app.shop.applyRefund({ ref: rid, paymentRef: o.ref, amount: 100n, currency: "INR", status: "succeeded", requestId: req.id }, { authoritative: false, requestId: req.id });
    expect((await q<{ status: string }>("SELECT status FROM refunds"))[0]?.status).toBe("failed");
    await consistent();
  });

  it("refunds in another currency than the payment are refused", async () => {
    const o = await paid();
    const rid = fake.dashboardRefund(o.ref, 100n);
    (fake.refunds.get(rid) as FRef).currency = "USD";
    await refEvt(rid, o.ref);
    await drain();
    expect(await count("refunds")).toBe(0);
    expect(await count("ledger_entries", "kind='refund'")).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------ database guards
describe("database level guards", () => {
  it("rejects an unbalanced ledger transaction at commit", async () => {
    await expect(
      db.query("INSERT INTO ledger_entries (txn_id, account, currency, amount, cause_ref, kind, effect_ref) VALUES ('t1','a','INR',100,'c','sale','e')"),
    ).rejects.toThrow(/does not balance/);
    expect(await count("ledger_entries")).toBe(0);
  });
  it("accepts balanced entries and rejects posting the same slot twice", async () => {
    const ins = (txn: string) =>
      db.query(
        "INSERT INTO ledger_entries (txn_id, account, currency, amount, cause_ref, kind, effect_ref) VALUES ($1,'a','INR',100,'c','sale','e'), ($1,'b','INR',-100,'c','sale','e')",
        [txn],
      );
    await ins("t1");
    await expect(ins("t2")).rejects.toThrow(/duplicate key|unique/);
    expect(await count("ledger_entries")).toBe(2);
  });
  it("per-currency balance: a txn balanced only across currencies is rejected", async () => {
    await expect(
      db.query("INSERT INTO ledger_entries (txn_id, account, currency, amount, cause_ref, kind, effect_ref) VALUES ('tx','a','INR',100,'c','k','e1'), ('tx','b','USD',-100,'c','k','e2')"),
    ).rejects.toThrow(/does not balance/);
  });
  it("order lines, allocations and refunds cannot hold non-positive or inconsistent money", async () => {
    const o = await newOrder();
    await expect(db.query("INSERT INTO order_lines (id, order_id, position, seller_id, currency, amount) VALUES ('x',$1,9,'seller_a','INR',0)", [o.id])).rejects.toThrow();
    await expect(db.query("INSERT INTO allocations (id,cause_ref,order_id,line_id,currency,amount,seller_amount,commission_amount,rate_num,rate_den,rounding) VALUES ('a','c',$1,$2,'INR',100,90,9,1,10,'x')", [o.id, o.lines[0]])).rejects.toThrow();
    await expect(db.query("INSERT INTO payments (provider_ref, order_id, status, amount, amount_captured, currency) VALUES ('p',$1,'succeeded',1,-1,'INR')", [o.id])).rejects.toThrow();
  });
});

// ------------------------------------------------------------------------------------------------ Razorpay webhook shape
describe("Razorpay webhooks through the worker app", () => {
  async function bootRzp() {
    await boot(new Fake("razorpay"));
  }
  const rzpPost = (raw: string, eventId: string | null, secret = RZP_WHSEC) => {
    const headers: Record<string, string> = { "x-razorpay-signature": FakeRazorpay.sign(raw, secret) };
    if (eventId) headers["x-razorpay-event-id"] = eventId;
    return post("/webhooks/razorpay", raw, headers);
  };
  it("verifies the HMAC, dedupes on the event id header (or the signed body), and enqueues by object", async () => {
    await bootRzp();
    const pay = { id: "pay_1", order_id: "order_X", status: "captured", amount: 100, currency: "INR" };
    const raw = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: pay } } });
    expect((await rzpPost(raw, "e1", "wrong")).status).toBe(400);
    expect((await post("/webhooks/razorpay", raw)).status).toBe(400);
    expect(await count("jobs")).toBe(0);
    for (let i = 0; i < 3; i++) expect((await rzpPost(raw, "e1")).status).toBe(200);
    expect(await count("jobs")).toBe(1);
    for (let i = 0; i < 3; i++) await rzpPost(raw, null);
    expect(await count("jobs")).toBe(2); // header-less deliveries dedupe on a body hash, separately from the header id
    expect((await q<{ payload: { ref: string }; type: string }>("SELECT * FROM jobs ORDER BY id"))[0]).toMatchObject({ type: "payment", payload: { ref: "order_X" } });
    const ref = JSON.stringify({ event: "refund.processed", payload: { refund: { entity: { id: "rfnd_1", payment_id: "pay_1" } }, payment: { entity: pay } } });
    await rzpPost(ref, "e2");
    expect((await q<{ type: string; payload: { ref: string; payment_ref: string } }>("SELECT * FROM jobs WHERE type='refund'"))[0]).toMatchObject({ payload: { ref: "rfnd_1", payment_ref: "order_X" } });
    const other = JSON.stringify({ event: "subscription.charged", payload: {} });
    await rzpPost(other, "e3");
    expect(await count("jobs")).toBe(3);
    expect((await get("/healthz")).status).toBe(200);
  });
  it("the INR minimum refund rule of the real Razorpay adapter is enforced by the shop", async () => {
    await bootRzp();
    expect(realRzp.refundRequestError?.(99n, "INR")).toMatch(/minimum/);
    expect(realRzp.refundRequestError?.(100n, "INR")).toBeUndefined();
    expect(realRzp.refundRequestError?.(1n, "USD")).toBeUndefined();
  });
});
