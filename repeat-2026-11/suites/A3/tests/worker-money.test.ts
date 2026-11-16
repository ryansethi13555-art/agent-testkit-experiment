// Money-correctness tests for the worker marketplace (webhooks only enqueue; a Postgres job queue drives the money logic).
import type { AddressInfo } from "node:net";
import fc from "fast-check";
import pg from "pg";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Db, migrate } from "../worker-marketplace/src/db.ts";
import { Worker } from "../worker-marketplace/src/jobs.ts";
import { createApp } from "../worker-marketplace/src/server.ts";
import { createDb, expectedFee, sleep } from "./helpers/db.ts";
import { WHSEC, WorkerFake } from "./helpers/worker-fake.ts";

let testDb: Awaited<ReturnType<typeof createDb>>;
let db: Db;
let fake: WorkerFake;
let app: ReturnType<typeof createApp>;
let base = "";
const TRUNCATE = "TRUNCATE jobs, ledger_entries, allocations, refunds, refund_requests, payments, order_lines, orders RESTART IDENTITY CASCADE";

beforeAll(async () => {
  testDb = await createDb("wrk");
  db = createPool(testDb.url);
  await migrate(db);
});
afterAll(async () => {
  await app?.stop().catch(() => {});
  await db?.end();
  await testDb?.drop();
});
beforeEach(async () => {
  await app?.stop().catch(() => {});
  await db.query(TRUNCATE);
  fake = new WorkerFake();
  app = createApp(db, fake); // worker is not started: tests drain the queue explicitly
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const drain = async () => {
  let n = 0;
  while (await app.worker.runOnce()) n++;
  return n;
};
const rows = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as any[];
const big = async (sql: string, params: unknown[] = []) => BigInt((await rows(sql, params))[0].v);
const cnt = async (sql: string, params: unknown[] = []) => Number((await rows(`SELECT count(*)::int c FROM (${sql}) q`, params))[0].c);
const signed = (event: object) => {
  const payload = JSON.stringify(event);
  return { payload, header: Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC }) };
};
const webhook = async (event: object) => {
  const s = signed(event);
  return post("/webhooks/stripe", s.payload, { "stripe-signature": s.header });
};
let evn = 0;
const piEvent = (ref: string, id = `evt_${++evn}`, type = "payment_intent.succeeded") => ({ id, object: "event", type, data: { object: { id: ref, object: "payment_intent" } } });
const refundEvent = (ref: string, pi: string, id = `evt_${++evn}`) => ({ id, object: "event", type: "refund.updated", data: { object: { id: ref, object: "refund", payment_intent: pi } } });

async function mkOrder(lines: [string, number | string][], extra: Record<string, unknown> = {}) {
  const r = await post("/orders", { buyer: "b", currency: "INR", lines: lines.map(([s, a]) => ({ seller_id: s, amount: a })), ...extra });
  expect(r.status).toBe(201);
  return { id: String(r.body.id), lines: r.body.lines as string[], total: BigInt(r.body.total) };
}
async function checkout(id: string) {
  const c = await post(`/orders/${id}/checkout`, {});
  expect(c.status).toBe(200);
  return String(c.body.payment_ref);
}
async function paidOrder(lines: [string, number | string][] = [["seller_a", 600], ["seller_b", 400]], extra: Record<string, unknown> = {}) {
  const o = await mkOrder(lines, extra);
  const ref = await checkout(o.id);
  fake.pay(ref);
  expect((await webhook(piEvent(ref))).status).toBe(200);
  await drain();
  return { ...o, ref };
}
const orderStatus = async (id: string) => (await rows("SELECT status FROM orders WHERE id=$1", [id]))[0].status as string;

async function assertSound() {
  expect(await rows("SELECT txn_id FROM ledger_entries GROUP BY txn_id, currency HAVING sum(amount) <> 0")).toEqual([]);
  const live = "('pending','requires_action','succeeded')";
  const captured = await big("SELECT coalesce(sum(amount_captured),0)::text v FROM payments WHERE status='succeeded'");
  const refunded = await big(`SELECT coalesce(sum(amount),0)::text v FROM refunds WHERE status IN ${live}`);
  expect(await big("SELECT coalesce(sum(amount),0)::text v FROM ledger_entries WHERE account='provider:clearing'")).toBe(captured - refunded);
  expect(
    await rows(`SELECT r.payment_ref FROM refunds r JOIN payments p ON p.provider_ref=r.payment_ref WHERE r.status IN ${live} GROUP BY r.payment_ref, p.amount_captured HAVING sum(r.amount) > p.amount_captured`),
  ).toEqual([]);
  // allocations: exact split of each line, the commission rule, nothing allocated twice
  for (const a of await rows("SELECT a.*, a.amount::text amt, a.commission_amount::text fee, a.seller_amount::text net FROM allocations a")) {
    expect(BigInt(a.fee)).toBe(expectedFee(BigInt(a.amt)));
    expect(BigInt(a.fee) + BigInt(a.net)).toBe(BigInt(a.amt));
  }
  expect(await rows("SELECT line_id FROM allocations GROUP BY line_id HAVING count(*) > 1")).toEqual([]);
  for (const seller of ["seller_a", "seller_b"]) {
    const net = await big("SELECT coalesce(sum(a.seller_amount),0)::text v FROM allocations a JOIN order_lines l ON l.id=a.line_id WHERE l.seller_id=$1", [seller]);
    const ref = await big(`SELECT coalesce(sum(r.amount),0)::text v FROM refunds r JOIN order_lines l ON l.id=r.line_id WHERE l.seller_id=$1 AND r.status IN ${live}`, [seller]);
    expect(await big("SELECT coalesce(sum(amount),0)::text v FROM ledger_entries WHERE account=$1", [`seller:${seller}`])).toBe(-net + ref);
  }
}

describe("API validation", () => {
  it("rejects malformed orders and stores exact minor-unit integers", async () => {
    const cases: unknown[] = [{}, { lines: [] }, { lines: "x" }, { lines: [{ seller_id: "seller_a", amount: 1.5 }] }, { lines: [{ seller_id: "seller_a", amount: -1 }] },
      { lines: [{ seller_id: "seller_a", amount: 0 }] }, { lines: [{ seller_id: "seller_a", amount: "1e3" }] }, { lines: [{ seller_id: "seller_a", amount: "9999999999999999" }] },
      { lines: [{ seller_id: "ghost", amount: 10 }] }, { lines: [{ amount: 10 }] }, { currency: "RS", lines: [{ seller_id: "seller_a", amount: 10 }] },
      { capture: "later", lines: [{ seller_id: "seller_a", amount: 10 }] },
      { lines: Array.from({ length: 21 }, () => ({ seller_id: "seller_a", amount: 1 })) },
      { lines: [{ seller_id: "seller_a", amount: 999999999999 }, { seller_id: "seller_a", amount: 1 }] }];
    for (const c of cases) expect((await post("/orders", c)).status, JSON.stringify(c)).toBe(400);
    expect((await post("/orders", "{not json")).status).toBe(400);
    expect((await post("/orders", "[1]")).status).toBe(400);
    expect(await cnt("SELECT 1 FROM orders")).toBe(0);
    const o = await mkOrder([["seller_a", "123456789012"], ["seller_b", 1]], { currency: "usd" });
    expect(o.total).toBe(123456789013n);
    expect((await rows("SELECT currency FROM orders"))[0].currency).toBe("USD");
  });
  it("refund endpoint validates amount, line and order state", async () => {
    const o = await mkOrder([["seller_a", 1000]]);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 10 })).status).toBe(409); // unpaid
    const p = await paidOrder([["seller_a", 1000]]);
    for (const amount of [0, -5, 1.5, "x", null, "1e2"]) expect((await post(`/orders/${p.id}/refunds`, { line_id: p.lines[0], amount })).status).toBe(400);
    expect((await post(`/orders/${p.id}/refunds`, { line_id: o.lines[0], amount: 10 })).status).toBe(404);
    expect(fake.calls.createRefund).toBe(0);
  });
});

describe("webhooks only enqueue; money state comes from the provider object", () => {
  it("rejects bad signatures, ignores unrelated objects, dedupes by event id (also concurrently)", async () => {
    const o = await mkOrder([["seller_a", 1000]]);
    const ref = await checkout(o.id);
    fake.pay(ref);
    const ev = piEvent(ref, "evt_dup");
    const s = signed(ev);
    expect((await post("/webhooks/stripe", s.payload, { "stripe-signature": "t=1,v1=00" })).status).toBe(400);
    expect((await post("/webhooks/stripe", s.payload, {})).status).toBe(400);
    expect((await post("/webhooks/stripe", s.payload + " ", { "stripe-signature": s.header })).status).toBe(400); // body altered after signing
    expect(await cnt("SELECT 1 FROM jobs")).toBe(0);
    const rs = await Promise.all(Array.from({ length: 10 }, () => post("/webhooks/stripe", s.payload, { "stripe-signature": s.header })));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(await cnt("SELECT 1 FROM jobs")).toBe(1);
    expect((await webhook({ id: "evt_c", object: "event", type: "customer.created", data: { object: { id: "cus_1", object: "customer" } } })).status).toBe(200);
    expect(await cnt("SELECT 1 FROM jobs")).toBe(1);
    await drain();
    await drain();
    expect(await cnt("SELECT 1 FROM ledger_entries WHERE kind='sale' AND account='provider:clearing'")).toBe(1);
    await assertSound();
  });

  it("never trusts the webhook body: an event claiming success cannot book money the provider does not hold", async () => {
    const o = await mkOrder([["seller_a", 1000]]);
    const ref = await checkout(o.id); // provider still pending
    const ev = { id: "evt_liar", object: "event", type: "payment_intent.succeeded", data: { object: { id: ref, object: "payment_intent", status: "succeeded", amount: 1000, amount_received: 1000 } } };
    expect((await webhook(ev)).status).toBe(200);
    await drain();
    expect(await cnt("SELECT 1 FROM ledger_entries")).toBe(0);
    expect(await orderStatus(o.id)).toBe("pending_payment");
    fake.pay(ref);
    expect((await webhook(piEvent(ref))).status).toBe(200);
    await drain();
    expect(await orderStatus(o.id)).toBe("paid");
    await assertSound();
  });

  it("redelivery of a failed job's event re-queues it; a finished job is not re-run", async () => {
    const o = await mkOrder([["seller_a", 1000]]);
    const ref = await checkout(o.id);
    const ev = piEvent(ref, "evt_re");
    await webhook(ev);
    await db.query("UPDATE jobs SET state='failed', attempts=25");
    await webhook(ev);
    expect((await rows("SELECT state, attempts FROM jobs"))[0]).toEqual({ state: "queued", attempts: 0 });
    fake.pay(ref);
    await drain();
    expect(await orderStatus(o.id)).toBe("paid");
    await webhook(ev);
    expect((await rows("SELECT state FROM jobs"))[0].state).toBe("done");
  });
});

describe("payments: booked once, only forward, never mis-allocated", () => {
  it("books a captured payment exactly once under duplicate events, charge events, confirm, checkout and concurrency", async () => {
    const o = await mkOrder([["seller_a", 600], ["seller_b", 400]]);
    const ref = await checkout(o.id);
    fake.pay(ref);
    await webhook(piEvent(ref));
    await webhook(piEvent(ref));
    await webhook({ id: "evt_ch", object: "event", type: "charge.succeeded", data: { object: { id: "ch_1", object: "charge", payment_intent: ref } } });
    await Promise.all([
      drain(),
      drain(),
      app.shop.reconcilePayment(ref),
      app.shop.reconcilePayment(ref),
      post(`/orders/${o.id}/confirm`, {}),
      post(`/orders/${o.id}/confirm`, {}),
    ]);
    await drain();
    expect(await cnt("SELECT 1 FROM ledger_entries WHERE kind='sale' AND account='provider:clearing'")).toBe(1);
    expect(await cnt("SELECT 1 FROM allocations")).toBe(2);
    expect(await big("SELECT amount::text v FROM ledger_entries WHERE account='seller:seller_a'")).toBe(-540n);
    expect(await big("SELECT coalesce(sum(-amount),0)::text v FROM ledger_entries WHERE account='platform:commission'")).toBe(100n);
    expect(await orderStatus(o.id)).toBe("paid");
    await assertSound();
  });

  it("splits each line with half-even commission and loses no minor unit", async () => {
    const amounts = [5, 15, 25, 35, 1, 9, 999_999_995];
    const o = await paidOrder(amounts.map((a) => ["seller_a", a] as [string, number]));
    for (const [i, a] of amounts.entries()) {
      const al = (await rows("SELECT commission_amount::text c, seller_amount::text s FROM allocations WHERE line_id=$1", [o.lines[i]]))[0];
      expect(BigInt(al.c)).toBe(expectedFee(BigInt(a)));
      expect(BigInt(al.c) + BigInt(al.s)).toBe(BigInt(a));
    }
    expect([5n, 15n, 25n, 35n].map(expectedFee)).toEqual([0n, 2n, 2n, 4n]);
    await assertSound();
  });

  it("property: any set of lines is booked in full, balanced, and refundable in full", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 50_000 }), { minLength: 1, maxLength: 6 }), async (amounts) => {
        fake.reset();
        await db.query(TRUNCATE);
        const o = await paidOrder(amounts.map((a, i) => [i % 2 ? "seller_b" : "seller_a", a] as [string, number]));
        expect(await big("SELECT coalesce(sum(amount),0)::text v FROM ledger_entries WHERE account='provider:clearing'")).toBe(o.total);
        for (const [i, a] of amounts.entries()) {
          if (a < 1) continue;
          expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[i], amount: a })).status).toBe(200);
        }
        expect(await orderStatus(o.id)).toBe("refunded");
        expect(await big("SELECT coalesce(sum(amount),0)::text v FROM ledger_entries WHERE account='provider:clearing'")).toBe(0n);
        await assertSound();
      }),
      { numRuns: 15 },
    );
  });

  it("a stale provider read never moves a stored payment backwards or re-books it", async () => {
    const o = await paidOrder([["seller_a", 1000]]);
    const before = await cnt("SELECT 1 FROM ledger_entries");
    fake.payments.get(o.ref)!.status = "requires_capture"; // older observation of the same payment
    await app.shop.reconcilePayment(o.ref);
    fake.payments.get(o.ref)!.status = "pending";
    fake.payments.get(o.ref)!.captured = 0n;
    await app.shop.reconcilePayment(o.ref).catch(() => {}); // contradictory capture amount: refused or ignored, never applied
    expect((await rows("SELECT status, amount_captured::text c FROM payments"))[0]).toEqual({ status: "succeeded", c: "1000" });
    expect(await cnt("SELECT 1 FROM ledger_entries")).toBe(before);
    expect(await orderStatus(o.id)).toBe("paid");
  });

  it("an amount that does not match the order goes to suspense, never to sellers; its lines cannot be refunded", async () => {
    const o = await mkOrder([["seller_a", 600], ["seller_b", 400]], { capture: "manual" });
    const ref = await checkout(o.id);
    fake.pay(ref);
    fake.partialCapture = 600n;
    const c = await post(`/orders/${o.id}/capture`, {});
    expect(c.status).toBeLessThan(600);
    await drain();
    expect(await cnt("SELECT 1 FROM allocations")).toBe(0);
    expect(await cnt("SELECT 1 FROM ledger_entries WHERE account LIKE 'seller:%'")).toBe(0);
    expect(await big("SELECT coalesce(sum(amount),0)::text v FROM ledger_entries WHERE account='platform:unallocated_receipts'")).toBe(-600n);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 })).status).toBe(409);
    expect(fake.calls.createRefund).toBe(0);
    await assertSound();
  });

  it("a second provider payment for the same order is held in suspense, not allocated to sellers twice", async () => {
    const o = await paidOrder([["seller_a", 1000]]);
    fake.payments.set("pi_second", { status: "succeeded", amount: 1000n, captured: 1000n, currency: "INR", orderId: o.id, manual: false });
    await app.shop.reconcilePayment("pi_second");
    await app.shop.reconcilePayment("pi_second");
    expect(await cnt("SELECT 1 FROM allocations")).toBe(1);
    expect(await big("SELECT coalesce(sum(-amount),0)::text v FROM ledger_entries WHERE account='seller:seller_a'")).toBe(900n);
    expect(await big("SELECT coalesce(sum(-amount),0)::text v FROM ledger_entries WHERE account='platform:unallocated_receipts'")).toBe(1000n);
    await assertSound();
  });

  it("refuses a snapshot with different money, currency or order identity than stored", async () => {
    const o = await paidOrder([["seller_a", 1000]]);
    const before = await cnt("SELECT 1 FROM ledger_entries");
    fake.payments.get(o.ref)!.captured = 1500n;
    await expect(app.shop.reconcilePayment(o.ref)).rejects.toThrow();
    fake.payments.get(o.ref)!.captured = 1000n;
    fake.payments.get(o.ref)!.currency = "USD";
    await expect(app.shop.reconcilePayment(o.ref)).rejects.toThrow();
    expect(await cnt("SELECT 1 FROM ledger_entries")).toBe(before);
    await assertSound();
  });

  it("checkout never creates a second provider payment after a lost response, crash marker or repeated call", async () => {
    const o = await mkOrder([["seller_a", 1000]]);
    fake.faults.createPayment = "lose";
    expect((await post(`/orders/${o.id}/checkout`, {})).status).toBe(502);
    for (let i = 0; i < 3; i++) expect((await post(`/orders/${o.id}/checkout`, {})).status).toBe(502);
    expect(fake.calls.createPayment).toBe(1);
    // the provider's own event for that object recovers the identity
    const ref = [...fake.payments.keys()][0]!;
    fake.pay(ref);
    await webhook(piEvent(ref));
    await drain();
    expect(await orderStatus(o.id)).toBe("paid");
    expect(fake.calls.createPayment).toBe(1);
    // concurrent checkouts on a fresh order: one create only
    const o2 = await mkOrder([["seller_a", 500]]);
    const rs = await Promise.all(Array.from({ length: 10 }, () => post(`/orders/${o2.id}/checkout`, {})));
    expect(fake.calls.createPayment).toBe(2);
    expect(new Set(rs.filter((r) => r.status === 200).map((r) => r.body.payment_ref)).size).toBe(1);
    await assertSound();
  });
});

describe("manual capture", () => {
  it("authorised then captured once under concurrency; order status follows the money", async () => {
    const o = await mkOrder([["seller_a", 1000]], { capture: "manual" });
    const ref = await checkout(o.id);
    fake.pay(ref);
    await app.shop.reconcilePayment(ref);
    expect(await orderStatus(o.id)).toBe("authorized");
    expect(await cnt("SELECT 1 FROM ledger_entries")).toBe(0);
    const rs = await Promise.all(Array.from({ length: 6 }, () => post(`/orders/${o.id}/capture`, {})));
    // a caller holding a stale read may get a retryable 502, but never a 2xx lie and never a second effect
    expect(rs.every((r) => r.status === 200 || r.status === 502)).toBe(true);
    expect(rs.some((r) => r.status === 200)).toBe(true);
    expect((await post(`/orders/${o.id}/capture`, {})).status).toBe(200);
    expect(await orderStatus(o.id)).toBe("paid");
    expect(await cnt("SELECT 1 FROM ledger_entries WHERE kind='sale' AND account='provider:clearing'")).toBe(1);
    await assertSound();
  });

  it("a lost capture response is reconciled from the provider object by the queue, booking once", async () => {
    const o = await mkOrder([["seller_a", 1000]], { capture: "manual" });
    const ref = await checkout(o.id);
    fake.pay(ref);
    fake.faults.capture = "lose";
    expect((await post(`/orders/${o.id}/capture`, {})).status).toBe(502);
    await drain();
    expect(await orderStatus(o.id)).toBe("paid");
    expect(await cnt("SELECT 1 FROM ledger_entries WHERE kind='sale' AND account='provider:clearing'")).toBe(1);
    expect((await post(`/orders/${o.id}/capture`, {})).status).toBe(200);
    expect(await cnt("SELECT 1 FROM ledger_entries WHERE kind='sale' AND account='provider:clearing'")).toBe(1);
    await assertSound();
  });
});

describe("refunds", () => {
  it("refunds per line within the line, with a seller debit, and the order status follows", async () => {
    const o = await paidOrder();
    const r = await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 250 });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("succeeded");
    expect(await orderStatus(o.id)).toBe("partially_refunded");
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 351 })).status).toBe(400);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 350 })).status).toBe(200);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 400 })).status).toBe(200);
    expect(await orderStatus(o.id)).toBe("refunded");
    expect(fake.calls.refundApplied).toBe(3);
    await assertSound();
  });

  it("concurrent refunds cannot exceed a line or the order, and each accepted one is sent once", async () => {
    const o = await paidOrder([["seller_a", 1000]]);
    const rs = await Promise.all(Array.from({ length: 12 }, () => post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 400 })));
    expect(rs.filter((r) => r.status === 200).length).toBe(2);
    expect(rs.filter((r) => r.status === 400).length).toBe(10);
    expect(fake.calls.refundApplied).toBe(2);
    await assertSound();
    const o2 = await paidOrder([["seller_a", 500], ["seller_b", 500]]);
    const rs2 = await Promise.all(o2.lines.flatMap((l) => Array.from({ length: 6 }, () => post(`/orders/${o2.id}/refunds`, { line_id: l, amount: 200 }))));
    expect(rs2.filter((r) => r.status === 200).length).toBe(4);
    await assertSound();
  });

  it("a refund made outside the shop counts against the payment's refundable amount", async () => {
    const o = await paidOrder([["seller_a", 600], ["seller_b", 400]]);
    const d = fake.dashboardRefund(o.ref, 800n);
    await webhook(refundEvent(d.ref, o.ref));
    await drain();
    expect((await rows("SELECT origin FROM refunds"))[0].origin).toBe("provider");
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 201 })).status).toBe(400);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 200 })).status).toBe(200);
    expect(await orderStatus(o.id)).toBe("refunded");
    await assertSound();
  });

  it("a lost response keeps the reservation, never resends (through worker retries to dead letter), then a webhook links it", async () => {
    const o = await paidOrder([["seller_a", 1000]]);
    fake.faults.refund = "lose";
    const r = await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 600 });
    expect(r.status).toBe(202);
    expect(fake.calls.refundApplied).toBe(1);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 401 })).status).toBe(400);
    for (let i = 0; i < 10; i++) {
      await db.query("UPDATE jobs SET run_after = now() WHERE state = 'queued'");
      await drain();
    }
    expect((await rows("SELECT state FROM jobs WHERE type='resolve_refund_request'"))[0].state).toBe("failed");
    expect(fake.calls.createRefund).toBe(1);
    expect(fake.calls.refundApplied).toBe(1);
    expect((await rows("SELECT state FROM refund_requests"))[0].state).toBe("unknown");
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 401 })).status).toBe(400);
    // the provider's exact refund object arrives
    const pr = [...fake.refunds.values()][0]!;
    await webhook(refundEvent(pr.ref, o.ref));
    await drain();
    expect((await rows("SELECT state FROM refund_requests"))[0].state).toBe("sent");
    expect((await rows("SELECT state FROM jobs WHERE type='resolve_refund_request'"))[0].state).toBe("done");
    expect(await cnt("SELECT 1 FROM refunds")).toBe(1);
    expect((await rows("SELECT origin, line_id FROM refunds"))[0]).toEqual({ origin: "shop", line_id: o.lines[0] });
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 401 })).status).toBe(400);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 400 })).status).toBe(200);
    await assertSound();
  });

  it("an unknown-outcome reservation limits its own line even when the rest of the order has room", async () => {
    const o = await paidOrder([["seller_a", 600], ["seller_b", 400]]);
    fake.faults.refund = "lose";
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 500 })).status).toBe(202);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 101 })).status).toBe(400);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 })).status).toBe(200);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 400 })).status).toBe(200);
    await assertSound();
  });

  it("a request left in flight by a crash becomes 'unknown' (still reserved) and is never resent", async () => {
    const o = await paidOrder([["seller_a", 1000]]);
    await db.query("INSERT INTO refund_requests (id, order_id, line_id, currency, amount, state) VALUES ('rr_crash',$1,$2,'INR',700,'requested')", [o.id, o.lines[0]]);
    expect(await app.shop.recoverRefundRequests()).toBe(1);
    expect((await rows("SELECT state FROM refund_requests"))[0].state).toBe("unknown");
    await drain();
    expect(fake.calls.createRefund).toBe(0);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 301 })).status).toBe(400);
  });

  it("a definitive rejection releases the reservation; an unknown failure keeps it", async () => {
    const o = await paidOrder([["seller_a", 1000]]);
    fake.faults.refund = "reject";
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 900 })).status).toBe(409);
    expect((await rows("SELECT state FROM refund_requests"))[0].state).toBe("rejected");
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 900 })).status).toBe(200);
    fake.faults.refund = "fail";
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 })).status).toBe(202);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 1 })).status).toBe(400);
    await assertSound();
  });

  it("pending refunds hold money; failure reverses exactly once and frees capacity; a later 'succeeded' read cannot resurrect it", async () => {
    const o = await paidOrder([["seller_a", 1000]]);
    fake.nextRefundStatus = "pending";
    const r = await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 700 });
    expect(r.body.status).toBe("pending");
    expect(await orderStatus(o.id)).toBe("partially_refunded");
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 301 })).status).toBe(400);
    const ref = [...fake.refunds.keys()][0]!;
    fake.refunds.get(ref)!.status = "failed";
    for (let i = 0; i < 3; i++) {
      await webhook(refundEvent(ref, o.ref));
      await drain();
    }
    expect((await rows("SELECT status FROM refunds"))[0].status).toBe("failed");
    expect(await cnt("SELECT 1 FROM ledger_entries WHERE kind='refund_reversal'")).toBe(2);
    expect(await orderStatus(o.id)).toBe("paid");
    await assertSound();
    fake.refunds.get(ref)!.status = "succeeded"; // stale or contradictory provider read
    await webhook(refundEvent(ref, o.ref));
    await app.worker.runOnce();
    await db.query("UPDATE jobs SET run_after = now() WHERE state = 'queued'");
    await app.worker.runOnce();
    expect((await rows("SELECT status FROM refunds"))[0].status).toBe("failed");
    expect(await cnt("SELECT 1 FROM ledger_entries WHERE kind='refund'")).toBe(2);
    await assertSound();
    fake.refunds.get(ref)!.status = "failed";
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 1000 })).status).toBe(200);
  });

  it("succeeded then failed later is reversed once", async () => {
    const o = await paidOrder([["seller_a", 1000]]);
    await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 500 });
    const ref = [...fake.refunds.keys()][0]!;
    fake.refunds.get(ref)!.status = "failed";
    for (let i = 0; i < 3; i++) {
      await webhook(refundEvent(ref, o.ref));
      await drain();
    }
    expect(await cnt("SELECT 1 FROM ledger_entries WHERE kind='refund_reversal'")).toBe(2);
    expect(await big("SELECT coalesce(sum(amount),0)::text v FROM ledger_entries WHERE account='seller:seller_a'")).toBe(-900n);
    await assertSound();
  });

  it("a refund event before the payment event still yields a booked sale and a recognised refund, once", async () => {
    const o = await mkOrder([["seller_a", 1000]]);
    const ref = await checkout(o.id);
    fake.pay(ref);
    const d = fake.dashboardRefund(ref, 100n);
    const ev = refundEvent(d.ref, ref, "evt_early");
    await webhook(ev);
    await webhook(ev);
    await drain();
    await webhook(piEvent(ref));
    await drain();
    expect(await cnt("SELECT 1 FROM ledger_entries WHERE kind='sale' AND account='provider:clearing'")).toBe(1);
    expect(await cnt("SELECT 1 FROM refunds")).toBe(1);
    expect(await cnt("SELECT 1 FROM ledger_entries WHERE kind='refund'")).toBe(2);
    expect(await orderStatus(o.id)).toBe("partially_refunded");
    await assertSound();
  });

  it("refunding one order never changes another", async () => {
    const a = await paidOrder([["seller_a", 1000]]);
    const b = await paidOrder([["seller_a", 1000]]);
    await post(`/orders/${a.id}/refunds`, { line_id: a.lines[0], amount: 1000 });
    expect(await orderStatus(b.id)).toBe("paid");
    expect((await post(`/orders/${b.id}/refunds`, { line_id: b.lines[0], amount: 1000 })).status).toBe(200);
    await assertSound();
  });

  it("applies the Razorpay INR minimum before reserving or calling the provider", async () => {
    const o = await paidOrder([["seller_a", 1000]]);
    fake.refundRequestError = (amount, currency) => (currency === "INR" && amount < 100n ? "minimum" : undefined);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 99 })).status).toBe(400);
    expect(fake.calls.createRefund).toBe(0);
    expect(await cnt("SELECT 1 FROM refund_requests")).toBe(0);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 })).status).toBe(200);
  });
});

describe("property: random histories keep the books sound", () => {
  type Op =
    | { t: "refund"; line: number; amt: number; mode: "ok" | "lose" | "fail" | "pending" | "reject" }
    | { t: "dash"; amt: number }
    | { t: "fail"; i: number }
    | { t: "succeed"; i: number }
    | { t: "dup"; i: number }
    | { t: "dupPay" }
    | { t: "run" };
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ t: fc.constant("refund" as const), line: fc.nat(2), amt: fc.integer({ min: 1, max: 2500 }), mode: fc.constantFrom("ok", "ok", "ok", "lose", "fail", "pending", "reject") }),
    fc.record({ t: fc.constant("dash" as const), amt: fc.integer({ min: 1, max: 2500 }) }),
    fc.record({ t: fc.constant("fail" as const), i: fc.nat(5) }),
    fc.record({ t: fc.constant("succeed" as const), i: fc.nat(5) }),
    fc.record({ t: fc.constant("dup" as const), i: fc.nat(5) }),
    fc.record({ t: fc.constant("dupPay" as const) }),
    fc.record({ t: fc.constant("run" as const) }),
  );
  it("ledger balanced, clearing exact, nothing over-refunded, DB agrees with provider once reconciled", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 100, max: 3000 }), { minLength: 1, maxLength: 3 }), fc.array(opArb, { minLength: 1, maxLength: 12 }), async (amounts, ops) => {
        fake.reset();
        await db.query(TRUNCATE);
        const o = await paidOrder(amounts.map((a, i) => [i % 2 ? "seller_b" : "seller_a", a] as [string, number]));
        const refs = () => [...fake.refunds.keys()];
        for (const op of ops) {
          if (op.t === "refund") {
            if (op.mode === "lose" || op.mode === "fail" || op.mode === "reject") fake.faults.refund = op.mode;
            if (op.mode === "pending") fake.nextRefundStatus = "pending";
            await post(`/orders/${o.id}/refunds`, { line_id: o.lines[op.line % o.lines.length], amount: op.amt });
            fake.faults.refund = undefined;
            fake.nextRefundStatus = "succeeded";
          } else if (op.t === "dash") {
            if (BigInt(op.amt) <= fake.payments.get(o.ref)!.captured - fake.live(o.ref)) {
              const d = fake.dashboardRefund(o.ref, BigInt(op.amt));
              await webhook(refundEvent(d.ref, o.ref));
            }
          } else if (op.t === "fail" || op.t === "succeed" || op.t === "dup") {
            const r = refs()[op.i % Math.max(1, refs().length)];
            if (!r) continue;
            if (op.t === "fail") fake.refunds.get(r)!.status = "failed";
            if (op.t === "succeed" && fake.refunds.get(r)!.status === "pending") fake.refunds.get(r)!.status = "succeeded";
            await webhook(refundEvent(r, o.ref));
          } else if (op.t === "dupPay") await webhook(piEvent(o.ref));
          else {
            await db.query("UPDATE jobs SET run_after = now() WHERE state = 'queued'");
            await drain();
          }
          await assertSound();
        }
        for (let k = 0; k < 2; k++) {
          for (const r of refs()) await webhook(refundEvent(r, o.ref));
          await db.query("UPDATE jobs SET run_after = now() WHERE state = 'queued'");
          await drain();
        }
        await assertSound();
        for (const row of await rows("SELECT provider_ref, status FROM refunds")) {
          const p = fake.refunds.get(row.provider_ref);
          expect(p, `db refund ${row.provider_ref} unknown to provider`).toBeDefined();
          const holds = (s: string) => ["pending", "requires_action", "succeeded"].includes(s);
          expect(holds(row.status)).toBe(holds(p!.status));
        }
      }),
      { numRuns: 15 },
    );
  });
});

describe("job queue", () => {
  const mk = (handlers: Partial<Record<"payment" | "refund" | "resolve_refund_request" | "reconcile_payment", (p: Record<string, string>) => Promise<void>>>, opts = {}) => {
    const none = async () => {};
    return new Worker(db, { payment: none, refund: none, resolve_refund_request: none, reconcile_payment: none, ...handlers }, { pollMs: 10, ...opts });
  };
  const { enqueue } = { enqueue: async (type: string, payload: object, key: string | null) => db.query("INSERT INTO jobs (provider_event_id, type, payload) VALUES ($1,$2,$3) ON CONFLICT (provider_event_id) DO NOTHING", [key, type, JSON.stringify(payload)]) };

  it("concurrent workers never run the same job twice", async () => {
    const seen = new Map<string, number>();
    const w = mk({ payment: async (p) => { await sleep(5); seen.set(p.ref!, (seen.get(p.ref!) ?? 0) + 1); } });
    for (let i = 0; i < 30; i++) await enqueue("payment", { ref: `r${i}` }, `k${i}`);
    await Promise.all(Array.from({ length: 5 }, async () => { while (await w.runOnce()) {} }));
    expect(seen.size).toBe(30);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    expect(await cnt("SELECT 1 FROM jobs WHERE state='done'")).toBe(30);
  });

  it("retries with backoff, then parks as failed after the attempt limit; errors never mark a job done", async () => {
    let n = 0;
    const w = mk({ payment: async () => { n++; throw new Error("boom"); } }, { maxAttempts: { default: 3 } });
    await enqueue("payment", { ref: "x" }, "kx");
    expect(await w.runOnce()).toBe(true);
    let j = (await rows("SELECT state, attempts, last_error FROM jobs"))[0];
    expect(j).toMatchObject({ state: "queued", attempts: 1, last_error: "boom" });
    expect(await w.runOnce()).toBe(false); // backoff: not ready yet
    for (let i = 0; i < 5; i++) {
      await db.query("UPDATE jobs SET run_after = now() WHERE state='queued'");
      await w.runOnce();
    }
    j = (await rows("SELECT state, attempts FROM jobs"))[0];
    expect(j).toMatchObject({ state: "failed", attempts: 3 });
    expect(n).toBe(3);
  });

  it("a crashed worker's running job is re-queued on recovery and runs", async () => {
    await enqueue("payment", { ref: "y" }, "ky");
    await db.query("UPDATE jobs SET state='running', attempts=1");
    let ran = 0;
    const w = mk({ payment: async () => { ran++; } });
    expect(await w.runOnce()).toBe(false);
    expect(await w.recover()).toBe(1);
    expect(await w.runOnce()).toBe(true);
    expect(ran).toBe(1);
  });
});

describe("database guards", () => {
  it("refuses an unbalanced ledger transaction at commit and a second posting in the same slot", async () => {
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await c.query("INSERT INTO ledger_entries (txn_id, account, currency, amount, cause_ref, kind, effect_ref) VALUES ('t1','a','INR',100,'c','sale','e')");
      await expect(c.query("COMMIT")).rejects.toThrow(/balance/);
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
    }
    const ins = (txn: string) =>
      db.query("INSERT INTO ledger_entries (txn_id, account, currency, amount, cause_ref, kind, effect_ref) VALUES ($1,'x','INR',5,'c','sale','e'), ($1,'y','INR',-5,'c','sale','e')", [txn]);
    await ins("t2").catch(() => {});
    await expect(db.query("INSERT INTO ledger_entries (txn_id, account, currency, amount, cause_ref, kind, effect_ref) VALUES ('t3','x','INR',5,'c','sale','e'), ('t3','z','INR',-5,'c','sale','e')")).rejects.toThrow();
    expect(await cnt("SELECT 1 FROM ledger_entries WHERE txn_id='t1'")).toBe(0);
  });
});
