// Money-correctness suite for worker-marketplace (durable job queue + Shop reconciliation) against a provider "world".
import type { AddressInfo } from "node:net";
import fc from "fast-check";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Db, migrate } from "../worker-marketplace/src/db.ts";
import { enqueue, Worker } from "../worker-marketplace/src/jobs.ts";
import { commissionOf, deriveOrderStatus, divHalfEven, lineHeadroom, paymentMayMove, parseMinorUnits, saleLegs, sumLegs, PAYMENT_STATUSES } from "../worker-marketplace/src/money.ts";
import { type PaymentProvider, ProviderError, providerFromEnv } from "../worker-marketplace/src/provider.ts";
import { createApp } from "../worker-marketplace/src/server.ts";
import { Shop } from "../worker-marketplace/src/shop.ts";
import { createDb, dropDb } from "./helpers/db.ts";
import { event, holds, newEventId, piObject, refundObject, sign, type RStatus, World, WorldError, WHSEC } from "./helpers/world.ts";

type Any = any; // eslint-disable-line
const realStripe = providerFromEnv({ PAYMENT_PROVIDER: "stripe", STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_SECRET_KEY: "sk_test_x" });
const realRzp = providerFromEnv({ PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: "k", RAZORPAY_KEY_SECRET: "s", RAZORPAY_WEBHOOK_SECRET: "w" });

const world = new World();
const perr = (e: unknown, refund = false): never => {
  if (e instanceof WorldError) {
    if (refund && e.status === 429) throw new ProviderError("rejected", 429, "refund rate limited before execution");
    const s = e.status;
    const outcome = s !== undefined && s >= 400 && s < 500 && s !== 409 && s !== 429 ? "rejected" : "unknown";
    throw new ProviderError(outcome, s, `provider ${s ?? "network"}`);
  }
  throw e;
};
const payOf = (p: Any): Any => ({
  ref: p.id,
  status: p.status === "requires_payment_method" ? "pending" : p.status,
  amount: p.amount,
  amountCaptured: p.received,
  currency: p.currency,
  orderId: p.orderId,
  clientSecret: `${p.id}_secret`,
});
const refOf = (r: Any): Any => ({ ref: r.id, paymentRef: r.paymentRef, amount: r.amount, currency: r.currency, status: r.status, requestId: r.metadata?.refund_request_id });
const fake: PaymentProvider & Any = {
  name: "stripe",
  refundRequestError: undefined as Any,
  async createPayment(p: Any) { try { return payOf(await world.createPayment(p)); } catch (e) { return perr(e); } },
  async retrievePayment(ref: string) { try { return payOf(await world.retrievePayment(ref)); } catch (e) { return perr(e); } },
  async capture(ref: string, p: Any) { try { return payOf(await world.capture(ref, p.idempotencyKey)); } catch (e) { return perr(e); } },
  async createRefund(ref: string, p: Any) { try { return refOf(await world.createRefund(ref, { amount: p.amount, key: p.idempotencyKey, metadata: p.metadata })); } catch (e) { return perr(e, true); } },
  async retrieveRefund(ref: string) { try { return refOf(await world.retrieveRefund(ref)); } catch (e) { return perr(e); } },
  parseWebhook: (raw: string, h: Any) => realStripe.parseWebhook(raw, h),
};

const { url: DBURL, name: DBNAME } = await createDb("worker");
let db: Db;
let app: ReturnType<typeof createApp>;
let base = "";
let plain: pg.Client;

beforeAll(async () => {
  db = createPool(DBURL);
  await migrate(db);
  plain = new pg.Client({ connectionString: DBURL });
  await plain.connect();
});
afterAll(async () => {
  await app?.stop().catch(() => {});
  await plain?.end();
  await db?.end();
  await dropDb(DBNAME);
});
beforeEach(async () => {
  await app?.stop().catch(() => {});
  await db.query("TRUNCATE jobs, ledger_entries, allocations, refunds, refund_requests, payments, order_lines, orders RESTART IDENTITY CASCADE");
  world.reset();
  fake.refundRequestError = undefined;
  app = createApp(db, fake);
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

async function post(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Any };
}
const drain = async () => { while (await app.worker.runOnce()) { /* run all ready jobs */ } };
const due = () => db.query("UPDATE jobs SET run_after = now() WHERE state = 'queued'");
async function deliver(type: string, object: unknown, id?: string) {
  const s = sign(event(type, object, id));
  return post("/webhooks/stripe", s.payload, { "stripe-signature": s.header });
}
const piEvent = (type: string, ref: string, id?: string) => deliver(type, piObject(world.payment(ref)), id);
const rfEvent = (type: string, ref: string, id?: string, status?: RStatus) => deliver(type, refundObject(world.refunds.get(ref) as Any, status), id);
const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as Any[];
const bal = async (account: string) => BigInt((await q("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE account=$1", [account]))[0].s);
const orderStatus = async (id: string) => (await q("SELECT status FROM orders WHERE id=$1", [id]))[0]?.status;
const saleRows = async () => Number((await q("SELECT count(*)::int c FROM ledger_entries WHERE kind IN ('sale','commission')"))[0].c);
async function mk(lines: [string, number][], o: { currency?: string; capture?: string } = {}) {
  const r = await post("/orders", { currency: o.currency ?? "INR", capture: o.capture ?? "automatic", lines: lines.map(([s, a]) => ({ seller_id: s, amount: a })) });
  expect(r.status).toBe(201);
  return r.body as { id: string; lines: string[] };
}
async function paid(lines: [string, number][] = [["seller_a", 1000], ["seller_b", 500]], o: { currency?: string } = {}) {
  const order = await mk(lines, o);
  const co = await post(`/orders/${order.id}/checkout`);
  expect(co.status).toBe(200);
  const ref = String(co.body.payment_ref);
  world.customerPays(ref);
  expect((await piEvent("payment_intent.succeeded", ref)).status).toBe(200);
  await drain();
  expect(await orderStatus(order.id)).toBe("paid");
  return { order, ref };
}
const refund = (orderId: string, lineId: string, amount: unknown) => post(`/orders/${orderId}/refunds`, { line_id: lineId, amount });

async function invariants(opts: { settled?: boolean } = {}) {
  const settled = opts.settled ?? true;
  expect(await q("SELECT txn_id FROM ledger_entries GROUP BY txn_id, currency HAVING sum(amount)<>0")).toEqual([]);
  expect(await q("SELECT cause_ref FROM ledger_entries GROUP BY cause_ref, effect_ref, account, currency HAVING count(*)>1")).toEqual([]);
  expect(await q("SELECT l.id FROM order_lines l JOIN refunds r ON r.line_id=l.id WHERE r.status IN ('pending','requires_action','succeeded') GROUP BY l.id, l.amount HAVING sum(r.amount) > l.amount")).toEqual([]);
  expect(await q("SELECT payment_ref FROM refunds WHERE status IN ('pending','requires_action','succeeded') GROUP BY payment_ref HAVING sum(amount) > (SELECT coalesce(sum(amount_captured),0) FROM payments p WHERE p.provider_ref = refunds.payment_ref)")).toEqual([]);
  for (const r of await q("SELECT * FROM refunds")) {
    const net = BigInt((await q("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE cause_ref=$1 AND account='provider:clearing'", [r.provider_ref]))[0].s);
    if (settled) expect(net, `refund ${r.provider_ref} ${r.status}`).toBe(holds(r.status) ? -BigInt(r.amount) : 0n);
    if (!holds(r.status) && settled) expect(BigInt((await q("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE cause_ref=$1", [r.provider_ref]))[0].s)).toBe(0n);
  }
  if (!settled) return;
  let clearing = 0n;
  const known = new Set<string>();
  for (const p of await q("SELECT * FROM payments")) {
    known.add(p.provider_ref);
    const w = world.payments.get(p.provider_ref) as Any;
    expect(p.status === "succeeded", `payment ${p.provider_ref} succeeded iff provider captured`).toBe(w.status === "succeeded");
    expect(BigInt(p.amount_captured)).toBe(w.received);
    const sale = BigInt((await q("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE kind='sale' AND account='provider:clearing' AND cause_ref=$1", [p.provider_ref]))[0].s);
    expect(sale).toBe(w.received);
    clearing += w.received;
    for (const r of world.refunds.values()) if (r.paymentRef === p.provider_ref && holds(r.status)) clearing -= r.amount;
  }
  expect(await bal("provider:clearing")).toBe(clearing);
  const appRefunds = new Map((await q("SELECT * FROM refunds")).map((r) => [r.provider_ref, r]));
  for (const r of world.refunds.values()) {
    if (!known.has(r.paymentRef)) continue;
    const a = appRefunds.get(r.id);
    expect(a, `provider refund ${r.id} recorded`).toBeTruthy();
    expect(BigInt(a.amount)).toBe(r.amount);
    expect(a.status).toBe(r.status);
  }
  for (const ref of appRefunds.keys()) expect(world.refunds.has(ref)).toBe(true);
}

describe("worker: pure money rules", () => {
  it("divHalfEven and commissionOf are exact half-even, never lose a minor unit", () => {
    expect([0n, 1n, 4n, 5n, 6n, 14n, 15n, 16n, 25n, 35n, 45n].map(commissionOf)).toEqual([0n, 0n, 0n, 0n, 1n, 1n, 2n, 2n, 2n, 4n, 4n]);
    expect(() => divHalfEven(-1n, 3n)).toThrow();
    expect(() => divHalfEven(1n, 0n)).toThrow();
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 999_999_999_999n }), (a) => {
        const f = commissionOf(a);
        expect(f >= 0n && f <= a).toBe(true);
        const diff = f * 10n - a;
        expect((diff < 0n ? -diff : diff) <= 5n).toBe(true); // within half a minor unit of 10%
      }),
    );
  });
  it("sale legs always sum to zero and equal the captured total", () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 1n, max: 10_000_000n }), { minLength: 1, maxLength: 20 }), (amts) => {
        const lines = amts.map((a, i) => ({ id: `l${i}`, seller: i % 2 ? "b" : "a", amount: a }));
        const total = amts.reduce((s, a) => s + a, 0n);
        const legs = saleLegs(total, lines);
        expect(sumLegs(legs)).toBe(0n);
        expect(legs[0]?.amount).toBe(total);
        const slots = legs.map((l) => `${l.account}|${l.effectRef}`);
        expect(new Set(slots).size).toBe(slots.length);
      }),
    );
  });
  it("parseMinorUnits accepts only exact non-negative integers within range", () => {
    expect(parseMinorUnits(5)).toBe(5n);
    expect(parseMinorUnits("0012")).toBe(12n);
    for (const bad of [1.5, -1, "1.0", "1e3", "-1", " 1", "", null, undefined, {}, [], 2 ** 53, "1000000000000", 1_000_000_000_000, NaN, Infinity, true])
      expect(parseMinorUnits(bad), String(bad)).toBeUndefined();
  });
  it("line headroom counts held refunds and open reservations, but not failed/canceled", () => {
    expect(lineHeadroom(1000n, [{ amount: 300n, status: "succeeded" }, { amount: 100n, status: "pending" }, { amount: 100n, status: "requires_action" }, { amount: 999n, status: "failed" }, { amount: 999n, status: "canceled" }], [50n])).toBe(450n);
  });
  it("a terminal payment state is never left, and order status follows money facts", () => {
    for (const to of PAYMENT_STATUSES) {
      expect(paymentMayMove("succeeded", to)).toBe(false);
      expect(paymentMayMove("canceled", to)).toBe(false);
    }
    expect(paymentMayMove("requires_capture", "pending")).toBe(false);
    expect(paymentMayMove("pending", "requires_capture")).toBe(true);
    expect(deriveOrderStatus({ captured: 100n, refunded: 0n, payments: ["succeeded"] })).toBe("paid");
    expect(deriveOrderStatus({ captured: 100n, refunded: 40n, payments: ["succeeded"] })).toBe("partially_refunded");
    expect(deriveOrderStatus({ captured: 100n, refunded: 100n, payments: ["succeeded"] })).toBe("refunded");
    expect(deriveOrderStatus({ captured: 0n, refunded: 0n, payments: ["requires_capture"] })).toBe("authorized");
    expect(deriveOrderStatus({ captured: 0n, refunded: 0n, payments: [] })).toBe("pending_payment");
  });
});

describe("worker: database guarantees", () => {
  it("rejects an unbalanced ledger transaction at commit and a repeated posting slot", async () => {
    await expect(
      (async () => {
        await plain.query("BEGIN");
        try {
          await plain.query("INSERT INTO ledger_entries (txn_id, account, currency, amount, cause_ref, kind, effect_ref) VALUES ('t1','a','INR',5,'c','sale','e')");
          await plain.query("COMMIT");
        } catch (e) {
          await plain.query("ROLLBACK");
          throw e;
        }
      })(),
    ).rejects.toThrow(/balance/);
    await plain.query("INSERT INTO ledger_entries (txn_id, account, currency, amount, cause_ref, kind, effect_ref) VALUES ('t2','a','INR',5,'c','sale','e'),('t2','b','INR',-5,'c','sale','e')");
    await expect(plain.query("INSERT INTO ledger_entries (txn_id, account, currency, amount, cause_ref, kind, effect_ref) VALUES ('t3','a','INR',5,'c','sale','e'),('t3','b','INR',-5,'c','sale','e')")).rejects.toThrow();
  });
});

describe("worker: orders, webhooks and sale booking", () => {
  it("validates order input", async () => {
    for (const lines of [[], undefined, [{ seller_id: "seller_a", amount: 0 }], [{ seller_id: "seller_a", amount: 1.5 }], [{ seller_id: "nobody", amount: 5 }], [{ amount: 5 }], Array.from({ length: 21 }, () => ({ seller_id: "seller_a", amount: 1 }))])
      expect((await post("/orders", { lines })).status, JSON.stringify(lines)).toBe(400);
    expect((await post("/orders", { currency: "X", lines: [{ seller_id: "seller_a", amount: 5 }] })).status).toBe(400);
    expect((await post("/orders", { capture: "later", lines: [{ seller_id: "seller_a", amount: 5 }] })).status).toBe(400);
    expect(await q("SELECT 1 FROM orders")).toEqual([]);
  });
  it("books the sale with half-even commission, allocation rows per line, balanced", async () => {
    const { order, ref } = await paid([["seller_a", 5], ["seller_b", 15], ["seller_a", 25], ["seller_b", 1]]);
    const al = await q("SELECT line_id, seller_amount::int s, commission_amount::int c FROM allocations ORDER BY line_id");
    expect(al.map((a) => [a.s, a.c])).toEqual([[5, 0], [13, 2], [23, 2], [1, 0]]);
    expect(al.every((a) => a.line_id.startsWith(order.id))).toBe(true);
    expect(await bal("provider:clearing")).toBe(46n);
    expect(await bal("seller:seller_a")).toBe(-28n);
    expect(await bal("platform:commission")).toBe(-4n);
    expect(world.payment(ref).received).toBe(46n);
    await invariants();
  });
  it("duplicate and fresh-id deliveries, drained by two workers at once, book exactly once", async () => {
    const order = await mk([["seller_a", 600], ["seller_b", 400]]);
    const ref = String((await post(`/orders/${order.id}/checkout`)).body.payment_ref);
    world.customerPays(ref);
    const id = newEventId();
    const rs = await Promise.all([piEvent("payment_intent.succeeded", ref, id), piEvent("payment_intent.succeeded", ref, id), piEvent("payment_intent.succeeded", ref), piEvent("payment_intent.succeeded", ref)]);
    for (const r of rs) expect(r.status).toBe(200);
    expect(Number((await q("SELECT count(*)::int c FROM jobs WHERE provider_event_id = $1", [`stripe:${id}`]))[0].c)).toBe(1);
    await Promise.all([drain(), drain(), drain()]);
    expect(await saleRows()).toBe(5);
    expect(Number((await q("SELECT count(*)::int c FROM allocations"))[0].c)).toBe(2);
    await invariants();
  });
  it("rejects forged and malformed webhooks and enqueues nothing", async () => {
    const ev = event("payment_intent.succeeded", { id: "pi_x", object: "payment_intent" });
    const good = sign(ev);
    for (const [payload, header] of [[good.payload, ""], [good.payload, "t=1,v1=00"], [good.payload.replace("pi_x", "pi_y"), good.header], [sign(ev, { secret: "whsec_nope" }).payload, sign(ev, { secret: "whsec_nope" }).header], [good.payload, sign(ev, { timestamp: Math.floor(Date.now() / 1000) - 7200 }).header]] as [string, string][]) {
      const r = await post("/webhooks/stripe", payload, header ? { "stripe-signature": header } : {});
      expect(r.status).toBe(400);
    }
    expect(await q("SELECT 1 FROM jobs")).toEqual([]);
  });
  it("trusts the provider object, not the webhook body: a lying 'succeeded' event books nothing", async () => {
    const order = await mk([["seller_a", 1000]]);
    const ref = String((await post(`/orders/${order.id}/checkout`)).body.payment_ref);
    const lying = { ...piObject(world.payment(ref)), status: "succeeded", amount_received: 1000 };
    expect((await deliver("payment_intent.succeeded", lying)).status).toBe(200);
    await drain();
    expect(await saleRows()).toBe(0);
    expect(await orderStatus(order.id)).toBe("pending_payment");
    expect(await q("SELECT 1 FROM jobs WHERE state='failed'")).toEqual([]);
  });
  it("an event for a payment that is not ours is ignored without booking", async () => {
    world.payments.set("pi_foreign", { id: "pi_foreign", orderId: "ord_other", amount: 50n, currency: "INR", capture: "automatic", status: "succeeded", received: 50n });
    expect((await piEvent("payment_intent.succeeded", "pi_foreign")).status).toBe(200);
    await drain();
    expect(await q("SELECT 1 FROM ledger_entries")).toEqual([]);
    expect(await q("SELECT 1 FROM payments")).toEqual([]);
  });
  it("failed jobs are retried with the same state, dead-letter, and revive on redelivery without double booking", async () => {
    const worker = new Worker(db, { payment: (p) => app.shop.onPaymentJob(p.ref as string), reconcile_payment: (p) => app.shop.onPaymentJob(p.ref as string), refund: (p) => app.shop.onRefundJob(p.ref as string), resolve_refund_request: async () => { throw new Error("x"); } }, { maxAttempts: { default: 3 } });
    const order = await mk([["seller_a", 1000]]);
    const ref = String((await post(`/orders/${order.id}/checkout`)).body.payment_ref);
    world.customerPays(ref);
    for (let i = 0; i < 5; i++) world.failNext({ op: "retrievePayment", when: "before", status: 500 });
    const id = newEventId();
    await piEvent("payment_intent.succeeded", ref, id);
    for (let i = 0; i < 4; i++) { await due(); while (await worker.runOnce()) { await due(); } }
    expect((await q("SELECT state, attempts FROM jobs"))[0]).toMatchObject({ state: "failed", attempts: 3 });
    expect(await saleRows()).toBe(0);
    world.faults = [];
    await piEvent("payment_intent.succeeded", ref, id); // provider redelivers the same event id
    expect((await q("SELECT state FROM jobs"))[0].state).toBe("queued");
    await due();
    while (await worker.runOnce()) { /* drain */ }
    expect((await q("SELECT state FROM jobs"))[0].state).toBe("done");
    expect(await saleRows()).toBe(3);
    await piEvent("payment_intent.succeeded", ref, id);
    await due();
    while (await worker.runOnce()) { /* drain */ }
    expect(await saleRows()).toBe(3);
    await invariants();
  });
  it("crash recovery: running jobs are re-queued and re-applied idempotently", async () => {
    const order = await mk([["seller_a", 1000]]);
    const ref = String((await post(`/orders/${order.id}/checkout`)).body.payment_ref);
    world.customerPays(ref);
    await piEvent("payment_intent.succeeded", ref);
    await drain();
    await db.query("UPDATE jobs SET state='running'"); // process died after booking, before marking done
    expect(await app.worker.recover()).toBe(1);
    await drain();
    expect(await saleRows()).toBe(3);
    await invariants();
  });
});

describe("worker: checkout and capture", () => {
  it("double-submitted checkout creates one provider payment", async () => {
    const order = await mk([["seller_a", 1000]]);
    world.delay.createPayment = 60;
    const rs = await Promise.all(Array.from({ length: 5 }, () => post(`/orders/${order.id}/checkout`)));
    expect(world.payments.size).toBe(1);
    const ref = [...world.payments.keys()][0];
    for (const r of rs) if (r.status === 200) expect(r.body.payment_ref).toBe(ref);
    expect((await post(`/orders/${order.id}/checkout`)).body.payment_ref).toBe(ref);
    expect(world.payments.size).toBe(1);
  });
  it("lost create response never leads to a second payment; the payment event recovers and books once", async () => {
    const order = await mk([["seller_a", 1000]]);
    world.failNext({ op: "createPayment", when: "after", status: 500 });
    expect((await post(`/orders/${order.id}/checkout`)).status).toBe(502);
    world.expireIdempotency();
    expect((await post(`/orders/${order.id}/checkout`)).status).toBe(502);
    expect(world.payments.size).toBe(1);
    const ref = [...world.payments.keys()][0] as string;
    world.customerPays(ref);
    await piEvent("payment_intent.succeeded", ref);
    await drain();
    expect(await orderStatus(order.id)).toBe("paid");
    expect((await q("SELECT payment_ref p FROM orders"))[0].p).toBe(ref);
    expect(await saleRows()).toBe(3);
    await invariants();
  });
  it("capture applied but response lost is reconciled from the provider object and booked once", async () => {
    const order = await mk([["seller_a", 600], ["seller_b", 400]], { capture: "manual" });
    const ref = String((await post(`/orders/${order.id}/checkout`)).body.payment_ref);
    world.customerPays(ref);
    expect((await post(`/orders/${order.id}/confirm`)).body.status).toBe("authorized");
    world.failNext({ op: "capture", when: "after", status: 500 });
    expect((await post(`/orders/${order.id}/capture`)).status).toBe(502);
    expect(await saleRows()).toBe(0);
    await drain();
    expect(await orderStatus(order.id)).toBe("paid");
    expect((await post(`/orders/${order.id}/capture`)).status).toBe(200);
    await drain();
    expect(world.count("capture")).toBe(1);
    expect(await saleRows()).toBe(5);
    await invariants();
  });
  it("capture refused by the provider is reported and books nothing", async () => {
    const order = await mk([["seller_a", 600]], { capture: "manual" });
    const ref = String((await post(`/orders/${order.id}/checkout`)).body.payment_ref);
    world.customerPays(ref);
    world.failNext({ op: "capture", when: "before", status: 400 });
    expect((await post(`/orders/${order.id}/capture`)).status).toBe(409);
    await drain();
    expect((await q("SELECT 1 FROM ledger_entries"))).toEqual([]);
  });
  it("a capture of a different amount than the order is held in suspense, never credited to sellers", async () => {
    const order = await mk([["seller_a", 600], ["seller_b", 400]]);
    const ref = String((await post(`/orders/${order.id}/checkout`)).body.payment_ref);
    Object.assign(world.payment(ref), { status: "succeeded", received: 700n });
    await piEvent("payment_intent.succeeded", ref);
    await drain();
    expect(await bal("seller:seller_a")).toBe(0n);
    expect(await bal("seller:seller_b")).toBe(0n);
    expect(await bal("platform:unallocated_receipts")).toBe(-700n);
    expect(await bal("provider:clearing")).toBe(700n);
    expect(await q("SELECT 1 FROM allocations")).toEqual([]);
    expect((await refund(order.id, `${order.id}_l1`, 100)).status).toBe(409); // no allocated money to refund against
    expect(world.count("refund")).toBe(0);
    await invariants();
  });
  it("a second captured payment on a paid order is held in suspense and does not re-credit sellers", async () => {
    const { order } = await paid([["seller_a", 600], ["seller_b", 400]]);
    const sellerBefore = await bal("seller:seller_a");
    world.payments.set("pi_second", { id: "pi_second", orderId: order.id, amount: 1000n, currency: "INR", capture: "automatic", status: "succeeded", received: 1000n });
    await piEvent("payment_intent.succeeded", "pi_second");
    await drain();
    expect(await bal("seller:seller_a")).toBe(sellerBefore);
    expect(Number((await q("SELECT count(*)::int c FROM allocations"))[0].c)).toBe(2);
    expect(await bal("platform:unallocated_receipts")).toBe(-1000n);
    await invariants();
  });
});

describe("worker: refunds", () => {
  it("refunds the right seller via the allocated payment; order status follows refunds that hold money", async () => {
    const { order, ref } = await paid([["seller_a", 600], ["seller_b", 400]]);
    const r = await refund(order.id, `${order.id}_l2`, 150);
    expect(r.status).toBe(200);
    expect(world.heldOn(ref)).toBe(150n);
    expect(await bal("seller:seller_b")).toBe(-360n + 150n);
    expect(await bal("seller:seller_a")).toBe(-540n);
    expect(await orderStatus(order.id)).toBe("partially_refunded");
    expect((await refund(order.id, `${order.id}_l1`, 600)).status).toBe(200);
    expect((await refund(order.id, `${order.id}_l2`, 250)).status).toBe(200);
    expect(await orderStatus(order.id)).toBe("refunded");
    expect((await refund(order.id, `${order.id}_l2`, 1)).status).toBe(400);
    expect(world.heldOn(ref)).toBe(1000n);
    await invariants();
  });
  it("rejects bad amounts, foreign lines, unknown orders and unpaid orders without provider calls", async () => {
    const a = await paid([["seller_a", 500]]);
    const b = await paid([["seller_b", 500]]);
    for (const amount of [0, -1, 1.5, "x", "1e2", null, 2 ** 60, undefined]) expect((await refund(a.order.id, `${a.order.id}_l1`, amount)).status, String(amount)).toBe(400);
    expect((await refund(a.order.id, `${b.order.id}_l1`, 100)).status).toBe(404);
    expect((await refund("ord_missing", "x", 100)).status).toBe(404);
    const u = await mk([["seller_a", 500]]);
    expect((await refund(u.id, `${u.id}_l1`, 100)).status).toBe(409);
    expect(world.count("refund")).toBe(0);
    expect(await q("SELECT 1 FROM refund_requests")).toEqual([]);
  });
  it("INR minimum (Razorpay contract) is enforced before any reservation", async () => {
    fake.refundRequestError = realRzp.refundRequestError;
    expect(realRzp.refundRequestError?.(99n, "INR")).toBeTruthy();
    expect(realRzp.refundRequestError?.(100n, "INR")).toBeUndefined();
    const { order } = await paid([["seller_a", 1000]]);
    expect((await refund(order.id, `${order.id}_l1`, 99)).status).toBe(400);
    expect(await q("SELECT 1 FROM refund_requests")).toEqual([]);
    expect((await refund(order.id, `${order.id}_l1`, 100)).status).toBe(200);
  });
  it("concurrent refunds on one line never exceed it", async () => {
    const { order, ref } = await paid([["seller_a", 1000], ["seller_b", 500]]);
    world.delay.refund = 40;
    const rs = await Promise.all(Array.from({ length: 6 }, () => refund(order.id, `${order.id}_l1`, 400)));
    expect(rs.filter((r) => r.status === 200).length).toBe(2);
    expect(rs.filter((r) => r.status === 400).length).toBe(4);
    expect(world.heldOn(ref)).toBe(800n);
    await invariants();
  });
  it("refunds the shop did not initiate count against the payment's headroom", async () => {
    const { order, ref } = await paid([["seller_a", 1000], ["seller_b", 500]]);
    const dash = world.dashboardRefund(ref, 1000n);
    expect((await rfEvent("refund.created", dash.id)).status).toBe(200);
    await drain();
    expect(await bal("platform:unallocated_refunds")).toBe(1000n);
    expect((await q("SELECT origin, line_id FROM refunds"))[0]).toMatchObject({ origin: "provider", line_id: null });
    expect((await refund(order.id, `${order.id}_l1`, 600)).status).toBe(400);
    expect((await refund(order.id, `${order.id}_l1`, 500)).status).toBe(200);
    expect(world.heldOn(ref)).toBe(1500n);
    expect(await orderStatus(order.id)).toBe("refunded");
    await invariants();
  });
  it("refund event before the payment event: the refund job reconciles the payment first, in any order", async () => {
    const order = await mk([["seller_a", 1000]]);
    const ref = String((await post(`/orders/${order.id}/checkout`)).body.payment_ref);
    world.customerPays(ref);
    const dash = world.dashboardRefund(ref, 250n);
    expect((await rfEvent("refund.created", dash.id)).status).toBe(200);
    await drain();
    expect(await orderStatus(order.id)).toBe("partially_refunded");
    await piEvent("payment_intent.succeeded", ref);
    await drain();
    expect(await saleRows()).toBe(3);
    await invariants();
  });
  it("lifecycle: pending, succeeded, stale pending replay, and async failure reverse exactly once and free the line", async () => {
    world.newRefundStatus = "pending";
    const { order, ref } = await paid([["seller_a", 1000]]);
    const l1 = `${order.id}_l1`;
    expect((await refund(order.id, l1, 1000)).body.status).toBe("pending");
    expect(await bal("provider:clearing")).toBe(0n);
    const rf = [...world.refunds.values()][0] as Any;
    world.setRefundStatus(rf.id, "succeeded");
    await rfEvent("refund.updated", rf.id);
    await rfEvent("refund.updated", rf.id, undefined, "pending"); // stale snapshot
    await drain();
    expect((await q("SELECT status FROM refunds"))[0].status).toBe("succeeded");
    expect(await orderStatus(order.id)).toBe("refunded");
    world.setRefundStatus(rf.id, "failed");
    const fid = newEventId();
    for (const id of [fid, fid, newEventId()]) await rfEvent("refund.failed", rf.id, id);
    await rfEvent("refund.updated", rf.id, undefined, "succeeded"); // stale success replayed after failure
    await drain();
    expect((await q("SELECT status FROM refunds"))[0].status).toBe("failed");
    expect(await orderStatus(order.id)).toBe("paid");
    expect(await bal("provider:clearing")).toBe(1000n);
    expect(await bal("seller:seller_a")).toBe(-900n);
    world.newRefundStatus = "succeeded";
    expect((await refund(order.id, l1, 1000)).status).toBe(200);
    expect(world.heldOn(ref)).toBe(1000n);
    await invariants();
  });
});

describe("worker: refund faults and ambiguity", () => {
  it("response lost after apply: 202, reservation held, never re-POSTed through retries and dead-letter, linked by the exact event", async () => {
    const { order, ref } = await paid([["seller_a", 1000]]);
    world.failNext({ op: "refund", when: "after", status: 500 });
    const r = await refund(order.id, `${order.id}_l1`, 600);
    expect(r.status).toBe(202);
    expect(world.heldOn(ref)).toBe(600n);
    world.expireIdempotency();
    for (let i = 0; i < 9; i++) { await due(); await drain(); }
    expect(world.count("refund")).toBe(1);
    expect((await q("SELECT state FROM jobs WHERE type='resolve_refund_request'"))[0].state).toBe("failed");
    expect((await q("SELECT state FROM refund_requests"))[0].state).toBe("unknown");
    // capacity stays reserved: the unresolved 600 plus 500 would pass the line
    expect((await refund(order.id, `${order.id}_l1`, 401)).status).toBe(400);
    const wr = [...world.refunds.values()][0] as Any;
    await rfEvent("refund.created", wr.id);
    await drain();
    const rows = await q("SELECT * FROM refunds");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ origin: "shop", line_id: `${order.id}_l1` });
    expect((await q("SELECT state FROM refund_requests"))[0].state).toBe("sent");
    expect((await q("SELECT state FROM jobs WHERE type='resolve_refund_request'"))[0].state).toBe("done");
    expect(await bal("seller:seller_a")).toBe(-900n + 600n);
    await invariants();
  });
  it("5xx or network error before apply: no provider refund, no resend, capacity bounded", async () => {
    const { order, ref } = await paid([["seller_a", 1000]]);
    world.failNext({ op: "refund", when: "before", status: 503 });
    expect((await refund(order.id, `${order.id}_l1`, 1000)).status).toBe(202);
    world.failNext({ op: "refund", when: "before" });
    await refund(order.id, `${order.id}_l1`, 1);
    for (let i = 0; i < 9; i++) { await due(); await drain(); }
    expect(world.heldOn(ref)).toBeLessThanOrEqual(1000n);
    expect(world.count("refund")).toBeLessThanOrEqual(2);
    await invariants({ settled: false });
  });
  it("a definitive 4xx first rejection releases the reservation; 429 on the first POST does too", async () => {
    const { order, ref } = await paid([["seller_a", 1000]]);
    const dash = world.dashboardRefund(ref, 1000n); // not yet known to the shop
    const r = await refund(order.id, `${order.id}_l1`, 300);
    expect(r.status).toBe(409);
    expect((await q("SELECT state FROM refund_requests"))[0].state).toBe("rejected");
    await rfEvent("refund.created", dash.id);
    await drain();
    world.setRefundStatus(dash.id, "failed");
    await rfEvent("refund.failed", dash.id);
    await drain();
    world.failNext({ op: "refund", when: "before", status: 429 });
    expect((await refund(order.id, `${order.id}_l1`, 300)).status).toBe(409);
    expect((await refund(order.id, `${order.id}_l1`, 300)).status).toBe(200);
    expect(world.heldOn(ref)).toBe(300n);
    await invariants();
  });
  it("a provider response that does not match the request is not booked", async () => {
    const { order } = await paid([["seller_a", 1000]]);
    const orig = fake.createRefund;
    fake.createRefund = async (...a: Any[]) => ({ ...(await orig.apply(fake, a)), amount: 399n });
    const r = await refund(order.id, `${order.id}_l1`, 400);
    fake.createRefund = orig;
    expect(r.status).not.toBe(200);
    expect(await q("SELECT 1 FROM refunds")).toEqual([]);
    expect(await bal("provider:clearing")).toBe(1000n);
  });
  it("restart recovery: a request left in flight becomes unknown (never re-POSTed) and still blocks over-refunding", async () => {
    const { order, ref } = await paid([["seller_a", 1000]]);
    await db.query("INSERT INTO refund_requests (id, order_id, line_id, currency, amount, state) VALUES ('rr_crash1',$1,$2,'INR',700,'requested')", [order.id, `${order.id}_l1`]);
    expect(await app.shop.recoverRefundRequests()).toBe(1);
    expect((await q("SELECT state FROM refund_requests"))[0].state).toBe("unknown");
    for (let i = 0; i < 8; i++) { await due(); await drain(); }
    expect(world.count("refund")).toBe(0);
    expect((await refund(order.id, `${order.id}_l1`, 301)).status).toBe(400);
    expect((await refund(order.id, `${order.id}_l1`, 300)).status).toBe(200);
    expect(world.heldOn(ref)).toBe(300n);
  });
  it("a refund event carrying another order's request identity is refused, not linked", async () => {
    const a = await paid([["seller_a", 1000]]);
    const b = await paid([["seller_b", 1000]]);
    world.failNext({ op: "refund", when: "after", status: 500 });
    await refund(a.order.id, `${a.order.id}_l1`, 400);
    const rid = (await q("SELECT id FROM refund_requests"))[0].id as string;
    const evil = world.dashboardRefund(b.ref, 400n);
    evil.metadata = { refund_request_id: rid };
    await rfEvent("refund.created", evil.id);
    await drain();
    expect((await q("SELECT state FROM refund_requests"))[0].state).toBe("unknown");
    expect(await q("SELECT 1 FROM refunds WHERE provider_ref=$1", [evil.id])).toEqual([]);
  });
});

describe("worker: stripe adapter wire behaviour", () => {
  it("parses payment, charge and refund notices to the object that changed", () => {
    const mk2 = (type: string, object: object) => sign(event(type, object));
    const s1 = mk2("payment_intent.succeeded", { id: "pi_1", object: "payment_intent" });
    const n1 = realStripe.parseWebhook(s1.payload, { "stripe-signature": s1.header });
    expect(n1).toMatchObject({ object: "payment", ref: "pi_1" });
    const s2 = mk2("charge.refunded", { id: "ch_1", object: "charge", payment_intent: "pi_9" });
    expect(realStripe.parseWebhook(s2.payload, { "stripe-signature": s2.header })).toMatchObject({ object: "payment", ref: "pi_9" });
    const s3 = mk2("refund.updated", { id: "re_1", object: "refund", payment_intent: "pi_9" });
    expect(realStripe.parseWebhook(s3.payload, { "stripe-signature": s3.header })).toMatchObject({ object: "refund", ref: "re_1", paymentRef: "pi_9" });
  });
  it("enqueue dedupes by key and only revives failed jobs", async () => {
    await enqueue(db, "payment", { ref: "a" }, "k1");
    await enqueue(db, "payment", { ref: "a" }, "k1");
    expect(Number((await q("SELECT count(*)::int c FROM jobs"))[0].c)).toBe(1);
    await db.query("UPDATE jobs SET state='done'");
    await enqueue(db, "payment", { ref: "a" }, "k1");
    expect((await q("SELECT state FROM jobs"))[0].state).toBe("done");
    await db.query("UPDATE jobs SET state='failed', attempts=9");
    await enqueue(db, "payment", { ref: "a" }, "k1");
    expect((await q("SELECT state, attempts FROM jobs"))[0]).toMatchObject({ state: "queued", attempts: 0 });
    expect(new Shop(db, fake)).toBeTruthy();
  });
});
