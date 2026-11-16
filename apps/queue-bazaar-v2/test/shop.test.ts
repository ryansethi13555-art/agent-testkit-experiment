// Integration tests of the money logic against Postgres, with an in-test fake provider (node:test).
// Skipped with a visible message when Postgres is unreachable (MI_PG_ADMIN_URL).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import fc from "fast-check";
import pg from "pg";
import Stripe from "stripe";
import { createPool, type Db, migrate } from "../src/db.ts";
import type { PaymentStatus, RefundStatus } from "../src/money.ts";
import {
  type PaymentProvider,
  type PaymentSnapshot,
  ProviderError,
  providerFromEnv,
  type RefundSnapshot,
} from "../src/provider.ts";
import { createApp } from "../src/server.ts";

const ADMIN = process.env.MI_PG_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const DB_NAME = `qb_test_${process.pid}`;
const WHSEC = "whsec_queue_bazaar_test";

let pgUp = true;
try {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${DB_NAME}`);
  await c.end();
} catch {
  pgUp = false;
  console.log("# Postgres unreachable: integration tests skipped (check MI_PG_ADMIN_URL)");
}

/** An in-memory provider with idempotency keys, controllable statuses and injectable lost responses. */
class FakeProvider implements PaymentProvider {
  readonly name = "stripe" as const;
  payments = new Map<
    string,
    { status: PaymentStatus; amount: bigint; captured: bigint; currency: string; orderId: string }
  >();
  refunds = new Map<
    string,
    {
      paymentRef: string;
      amount: bigint;
      currency: string;
      status: RefundStatus;
      requestId?: string | undefined;
    }
  >();
  idem = new Map<string, string>();
  n = 0;
  refundRequestError?: (amount: bigint, currency: string) => string | undefined;
  /** Next createRefund applies, then "loses" the response. */
  loseNextRefundResponse = false;
  readonly real = providerFromEnv({
    PAYMENT_PROVIDER: "stripe",
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_WEBHOOK_SECRET: WHSEC,
  });

  #pay(ref: string): PaymentSnapshot {
    const p = this.payments.get(ref);
    if (!p) throw new ProviderError("rejected", 404, "no such payment");
    return {
      ref,
      status: p.status,
      amount: p.amount,
      amountCaptured: p.captured,
      currency: p.currency,
      orderId: p.orderId,
      clientSecret: `${ref}_secret`,
    };
  }
  #ref(ref: string): RefundSnapshot {
    const r = this.refunds.get(ref);
    if (!r) throw new ProviderError("rejected", 404, "no such refund");
    return {
      ref,
      paymentRef: r.paymentRef,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      requestId: r.requestId,
    };
  }
  async createPayment(p: { orderId: string; amount: bigint; currency: string }) {
    const key = `checkout_${p.orderId}`;
    let ref = this.idem.get(key);
    if (!ref) {
      ref = `pi_${++this.n}`;
      this.idem.set(key, ref);
      this.payments.set(ref, {
        status: "pending",
        amount: p.amount,
        captured: 0n,
        currency: p.currency,
        orderId: p.orderId,
      });
    }
    return this.#pay(ref);
  }
  async retrievePayment(ref: string) {
    return this.#pay(ref);
  }
  async capture(ref: string) {
    const p = this.payments.get(ref);
    if (p?.status === "requires_capture") Object.assign(p, { status: "succeeded", captured: p.amount });
    return this.#pay(ref);
  }
  async createRefund(
    paymentRef: string,
    p: { amount: bigint; idempotencyKey: string; metadata: Record<string, string> },
  ) {
    let ref = this.idem.get(p.idempotencyKey);
    if (!ref) {
      const pay = this.payments.get(paymentRef);
      if (pay?.status !== "succeeded") throw new ProviderError("rejected", 400, "payment not captured");
      const used = [...this.refunds.values()]
        .filter(
          (r) =>
            r.paymentRef === paymentRef && ["pending", "requires_action", "succeeded"].includes(r.status),
        )
        .reduce((s, r) => s + r.amount, 0n);
      if (p.amount > pay.captured - used) throw new ProviderError("rejected", 400, "amount too large");
      ref = `re_${++this.n}`;
      this.idem.set(p.idempotencyKey, ref);
      this.refunds.set(ref, {
        paymentRef,
        amount: p.amount,
        currency: pay.currency,
        status: "succeeded",
        requestId: p.metadata.refund_request_id,
      });
    }
    if (this.loseNextRefundResponse) {
      this.loseNextRefundResponse = false;
      throw new ProviderError("unknown", undefined, "socket hang up");
    }
    return this.#ref(ref);
  }
  async retrieveRefund(ref: string) {
    return this.#ref(ref);
  }
  parseWebhook(raw: string, headers: http.IncomingHttpHeaders) {
    return this.real.parseWebhook(raw, headers);
  }
  /** The customer pays (automatic capture) or authorises (manual). */
  pay(ref: string) {
    const p = this.payments.get(ref);
    assert.ok(p);
    Object.assign(p, p.status === "pending" ? { status: "succeeded", captured: p.amount } : {});
  }
  authorise(ref: string) {
    const p = this.payments.get(ref);
    assert.ok(p);
    p.status = "requires_capture";
  }
}

describe("QueueBazaar money logic", { skip: !pgUp }, () => {
  let db: Db;
  let fake: FakeProvider;
  let app: ReturnType<typeof createApp>;
  let base = "";

  before(async () => {
    // Change only the database: preserve authentication and connection options from CI.
    const databaseUrl = new URL(ADMIN);
    databaseUrl.pathname = `/${DB_NAME}`;
    db = createPool(databaseUrl.href);
    await migrate(db);
  });
  after(async () => {
    await app?.stop().catch(() => {});
    await db?.end();
    const c = new pg.Client({ connectionString: ADMIN });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await c.end();
  });
  beforeEach(async () => {
    await app?.stop().catch(() => {});
    await db.query(
      "TRUNCATE jobs, ledger_entries, allocations, refunds, refund_requests, payments, order_lines, orders RESTART IDENTITY CASCADE",
    );
    fake = new FakeProvider();
    app = createApp(db, fake); // worker not started: tests drain the queue explicitly
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const drain = async () => {
    while (await app.worker.runOnce()) {}
  };
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.query(sql, params)).rows[0] as T;
  const balancedPerTxn = async () =>
    (await db.query("SELECT txn_id FROM ledger_entries GROUP BY txn_id, currency HAVING sum(amount) <> 0"))
      .rowCount === 0;
  const signed = (event: object) => {
    const payload = JSON.stringify(event);
    return { payload, header: Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC }) };
  };
  const webhook = async (event: object) => {
    const s = signed(event);
    return post("/webhooks/stripe", s.payload, { "stripe-signature": s.header });
  };
  const piEvent = (id: string, ref: string) => ({
    id,
    object: "event",
    type: "payment_intent.succeeded",
    data: { object: { id: ref, object: "payment_intent" } },
  });
  const refundEvent = (id: string, ref: string, pi: string) => ({
    id,
    object: "event",
    type: "refund.updated",
    data: { object: { id: ref, object: "refund", payment_intent: pi } },
  });

  it("guards non-idempotent checkout without consuming the pool across Shop instances", async () => {
    const created = await app.shop.createOrder({ lines: [{ seller_id: "seller_a", amount: "1000" }] });
    const orderId = String(created.id);
    let release = () => {},
      started = () => {};
    const parked = new Promise<void>((r) => {
      release = r;
    });
    const ready = new Promise<void>((r) => {
      started = r;
    });
    let calls = 0;
    fake.createPayment = async (p) => {
      const ref = `pi_nonidem_${++calls}`;
      fake.payments.set(ref, {
        status: "pending",
        amount: p.amount,
        captured: 0n,
        currency: p.currency,
        orderId,
      });
      started();
      await parked;
      return fake.retrievePayment(ref);
    };
    const first = app.shop.checkout(orderId);
    await ready;
    const secondShop = new (await import("../src/shop.ts")).Shop(db, fake);
    // Pool-sized contenders must finish while the first provider call remains parked.
    const outcomes = await Promise.allSettled(Array.from({ length: 24 }, () => secondShop.checkout(orderId)));
    assert.ok(outcomes.every((o) => o.status === "rejected" && /outcome unknown/.test(String(o.reason))));
    // Event-first provider work can still use the DB; no pool connections are held by checkout.
    await secondShop.reconcilePayment("pi_nonidem_1");
    release();
    const a = await first;
    const b = await secondShop.checkout(orderId);
    assert.equal(calls, 1);
    assert.equal(a.payment_ref, b.payment_ref);
    fake.pay(String(a.payment_ref));
    await app.shop.reconcilePayment(String(a.payment_ref));
    assert.equal((await one("SELECT sum(amount_captured)::bigint captured FROM payments")).captured, 1000n);
    assert.ok(await balancedPerTxn());
  });

  it("never repeats a possibly committed checkout after lost response or process restart", async () => {
    const created = await app.shop.createOrder({ lines: [{ seller_id: "seller_a", amount: "1000" }] });
    const orderId = String(created.id);
    let calls = 0;
    fake.createPayment = async (p) => {
      calls++;
      fake.payments.set("pi_unknown", {
        status: "pending",
        amount: p.amount,
        captured: 0n,
        currency: p.currency,
        orderId,
      });
      throw new ProviderError("unknown", undefined, "response lost after create");
    };
    await assert.rejects(app.shop.checkout(orderId), /response lost/);
    const restarted = new (await import("../src/shop.ts")).Shop(db, fake);
    await assert.rejects(restarted.checkout(orderId), /outcome unknown/);
    assert.equal(calls, 1);
    assert.equal(
      (await one("SELECT checkout_create_started FROM orders WHERE id=$1", [orderId]))
        .checkout_create_started,
      true,
    );
    // A correlated provider observation recovers the original identity, without a new create.
    await restarted.reconcilePayment("pi_unknown");
    assert.equal((await restarted.checkout(orderId)).payment_ref, "pi_unknown");
    assert.equal(calls, 1);
  });

  it("a durable pre-send crash marker blocks a new checkout create", async () => {
    const created = await app.shop.createOrder({ lines: [{ seller_id: "seller_a", amount: "1000" }] });
    const orderId = String(created.id);
    await db.query("UPDATE orders SET checkout_create_started=true WHERE id=$1", [orderId]);
    await assert.rejects(app.shop.checkout(orderId), /outcome unknown/);
    assert.equal(fake.payments.size, 0);
  });

  /** An order with lines 1000 (seller_a) and 500 (seller_b), paid and booked. */
  async function paidOrder(capture: "automatic" | "manual" = "automatic") {
    const o = await post("/orders", {
      lines: [
        { seller_id: "seller_a", amount: 1000 },
        { seller_id: "seller_b", amount: 500 },
      ],
      capture,
    });
    assert.equal(o.status, 201);
    const id = String(o.body.id);
    const lines = o.body.lines as string[];
    const ck = await post(`/orders/${id}/checkout`);
    assert.equal(ck.status, 200);
    const ref = String(ck.body.payment_ref);
    if (capture === "automatic") fake.pay(ref);
    else fake.authorise(ref);
    assert.equal((await webhook(piEvent(`evt_pay_${ref}`, ref))).status, 200);
    await drain();
    return { id, lines, ref };
  }

  it("books a captured payment once, however often and in whatever form its webhook arrives", async () => {
    const { id, ref } = await paidOrder();
    for (const ev of ["evt_a", "evt_a", "evt_b"]) await webhook(piEvent(ev, ref)); // same id twice, then a fresh id
    await post(`/orders/${id}/confirm`);
    await drain();
    assert.equal(
      (await one<{ status: string }>("SELECT status FROM orders WHERE id = $1", [id])).status,
      "paid",
    );
    const clearing = await one<{ s: bigint }>(
      "SELECT sum(amount)::bigint s FROM ledger_entries WHERE account = 'provider:clearing'",
    );
    assert.equal(clearing.s, 1500n);
    assert.equal((await one<{ n: bigint }>("SELECT count(*)::bigint n FROM allocations")).n, 2n);
    assert.ok(await balancedPerTxn());
    // seller credits: line minus 10 % commission
    const a = await one<{ s: bigint }>(
      "SELECT sum(amount)::bigint s FROM ledger_entries WHERE account = 'seller:seller_a'",
    );
    assert.equal(a.s, -900n);
  });

  it("dedupes webhook jobs by provider event id and rejects bad signatures", async () => {
    const { ref } = await paidOrder();
    await webhook(piEvent("evt_dup", ref));
    await webhook(piEvent("evt_dup", ref));
    assert.equal(
      (
        await one<{ n: bigint }>(
          "SELECT count(*)::bigint n FROM jobs WHERE provider_event_id = 'stripe:evt_dup'",
        )
      ).n,
      1n,
    );
    const bad = await post("/webhooks/stripe", JSON.stringify(piEvent("evt_x", ref)), {
      "stripe-signature": "t=1,v1=00",
    });
    assert.equal(bad.status, 400);
    assert.equal(
      (
        await one<{ n: bigint }>(
          "SELECT count(*)::bigint n FROM jobs WHERE provider_event_id = 'stripe:evt_x'",
        )
      ).n,
      0n,
    );
  });

  it("validates known provider refund limits before reserving or calling the provider", async () => {
    const { id, lines } = await paidOrder();
    const contractProvider = providerFromEnv({ PAYMENT_PROVIDER: "razorpay" });
    assert.ok(contractProvider.refundRequestError);
    fake.refundRequestError = contractProvider.refundRequestError;
    const prior = await post(`/orders/${id}/refunds`, { line_id: lines[0], amount: 200 });
    assert.equal(prior.status, 200);
    const reservations = (await db.query("SELECT * FROM refund_requests ORDER BY id")).rows;
    const refunds = [...fake.refunds.entries()];
    for (const amount of [1, 2, 99]) {
      const response = await post(`/orders/${id}/refunds`, { line_id: lines[0], amount });
      assert.equal(response.status, 400);
      assert.match(String(response.body.error), /minimum.*100/);
      assert.deepEqual((await db.query("SELECT * FROM refund_requests ORDER BY id")).rows, reservations);
      assert.deepEqual([...fake.refunds.entries()], refunds);
    }
    assert.equal((await post(`/orders/${id}/refunds`, { line_id: lines[0], amount: 100 })).status, 200);
    assert.equal(fake.refunds.size, 2);
  });

  it("refunds per line within the line amount only, also under concurrency", async () => {
    const { id, lines } = await paidOrder();
    const results = await Promise.all(
      [1, 2, 3].map(() => post(`/orders/${id}/refunds`, { line_id: lines[1], amount: 300 })),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400, 400]);
    const over = await post(`/orders/${id}/refunds`, { line_id: lines[1], amount: 201 });
    assert.equal(over.status, 400);
    const exact = await post(`/orders/${id}/refunds`, { line_id: lines[1], amount: 200 });
    assert.equal(exact.status, 200);
    const line = await one<{ s: bigint }>("SELECT sum(amount)::bigint s FROM refunds WHERE line_id = $1", [
      lines[1],
    ]);
    assert.equal(line.s, 500n);
    assert.equal(
      (await one<{ status: string }>("SELECT status FROM orders WHERE id = $1", [id])).status,
      "partially_refunded",
    );
    for (const bad of [0, -5, 1.5, "abc"])
      assert.equal((await post(`/orders/${id}/refunds`, { line_id: lines[0], amount: bad })).status, 400);
    assert.ok(await balancedPerTxn());
  });

  it("reverses a failed refund once and never lets a stale status overwrite a newer one", async () => {
    const { id, lines, ref } = await paidOrder();
    const r = await post(`/orders/${id}/refunds`, { line_id: lines[0], amount: 400 });
    const rf = String(r.body.provider_refund_id);
    // the provider later fails the refund; two notifications arrive
    const fr = fake.refunds.get(rf);
    assert.ok(fr);
    fr.status = "failed";
    await webhook(refundEvent("evt_r1", rf, ref));
    await webhook(refundEvent("evt_r2", rf, ref));
    await drain();
    // a stale create response (succeeded) replayed for the same request does not resurrect it
    await app.shop.applyRefund(
      { ref: rf, paymentRef: ref, amount: 400n, currency: "INR", status: "succeeded", requestId: undefined },
      { authoritative: false },
    );
    assert.equal(
      (await one<{ status: string }>("SELECT status FROM refunds WHERE provider_ref = $1", [rf])).status,
      "failed",
    );
    const net = await db.query(
      "SELECT account, sum(amount)::bigint s FROM ledger_entries WHERE cause_ref = $1 GROUP BY account",
      [rf],
    );
    assert.ok(
      net.rows.length > 0 && net.rows.every((x) => x.s === 0n),
      "a failed refund leaves no money on any account",
    );
    assert.equal(
      (await one<{ n: bigint }>("SELECT count(*)::bigint n FROM ledger_entries WHERE cause_ref = $1", [rf]))
        .n,
      4n,
    );
    assert.equal(
      (await one<{ status: string }>("SELECT status FROM orders WHERE id = $1", [id])).status,
      "paid",
    );
    // the line's full amount is refundable again
    assert.equal((await post(`/orders/${id}/refunds`, { line_id: lines[0], amount: 1000 })).status, 200);
  });

  it("keeps a lost-response reservation through key expiry until exact provider-object reconciliation", async () => {
    const { id, lines } = await paidOrder();
    fake.loseNextRefundResponse = true;
    const r = await post(`/orders/${id}/refunds`, { line_id: lines[0], amount: 700 });
    assert.equal(r.status, 202);
    // the reservation blocks an over-refund while the outcome is unknown
    assert.equal((await post(`/orders/${id}/refunds`, { line_id: lines[0], amount: 301 })).status, 400);
    fake.idem.clear(); // provider retention has elapsed; reusing the key would create another refund
    await assert.rejects(app.shop.resolveRefundRequest(String(r.body.request_id)), /still unknown/);
    assert.equal(fake.refunds.size, 1);
    assert.equal((await one<{ state: string }>("SELECT state FROM refund_requests")).state, "unknown");
    const ref = [...fake.refunds.keys()][0];
    assert.ok(ref);
    await app.shop.onRefundJob(ref); // exact provider-object reconciliation, without another POST
    const req = await one<{ state: string }>("SELECT state FROM refund_requests WHERE id = $1", [
      r.body.request_id,
    ]);
    assert.equal(req.state, "sent");
    assert.equal((await one<{ n: bigint }>("SELECT count(*)::bigint n FROM refunds")).n, 1n);
    assert.ok(await balancedPerTxn());
  });

  it("unknown recovery never adds financial effects across key expiry and repeated worker attempts", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 1n, max: 499n }),
        fc.integer({ min: 1, max: 6 }),
        async (amount, attempts) => {
          const { id, lines } = await paidOrder();
          fake.loseNextRefundResponse = true;
          const r = await post(`/orders/${id}/refunds`, { line_id: lines[0], amount: amount.toString() });
          assert.equal(r.status, 202);
          const ref = fake.idem.get(String(r.body.request_id));
          assert.ok(ref);
          const count = fake.refunds.size;
          for (let i = 0; i < attempts; i++) {
            fake.idem.clear();
            await assert.rejects(app.shop.resolveRefundRequest(String(r.body.request_id)), /still unknown/);
          }
          assert.equal(fake.refunds.size, count);
          assert.equal(
            [...fake.refunds.values()]
              .filter((r) => r.paymentRef === fake.refunds.get(ref)?.paymentRef)
              .reduce((sum, r) => sum + r.amount, 0n),
            amount,
          );
          await app.shop.onRefundJob(ref);
          await app.shop.resolveRefundRequest(String(r.body.request_id)); // late resolver after exact linkage
          assert.equal(fake.refunds.size, count);
          assert.equal(
            (
              await one<{ state: string }>("SELECT state FROM refund_requests WHERE id=$1", [
                r.body.request_id,
              ])
            ).state,
            "sent",
          );
          assert.ok(await balancedPerTxn());
        },
      ),
      { numRuns: 30, seed: 20261008 },
    );
  });

  it("retires a dead-lettered resolver only when its exact request is linked by recovery", async () => {
    const { id, lines } = await paidOrder();
    fake.loseNextRefundResponse = true;
    const r = await post(`/orders/${id}/refunds`, { line_id: lines[0], amount: 700 });
    assert.equal(r.status, 202);
    await db.query(
      "UPDATE jobs SET state = 'failed', last_error = 'cached provider failure' WHERE type = 'resolve_refund_request'",
    );
    const ref = [...fake.refunds.keys()][0];
    assert.ok(ref);
    await db.query(
      "INSERT INTO jobs (type,payload,state,last_error) VALUES ('resolve_refund_request',$1,'failed','unrelated')",
      [JSON.stringify({ request_id: "other" })],
    );
    await app.shop.onRefundJob(ref);
    assert.equal(
      (await one<{ state: string }>("SELECT state FROM refund_requests WHERE id=$1", [r.body.request_id]))
        .state,
      "sent",
    );
    const jobs = (
      await db.query(
        "SELECT payload->>'request_id' request_id,state FROM jobs WHERE type='resolve_refund_request'",
      )
    ).rows;
    assert.equal(jobs.find((j) => j.request_id === r.body.request_id)?.state, "done");
    assert.equal(jobs.find((j) => j.request_id === "other")?.state, "failed");
    assert.ok(await balancedPerTxn());
  });

  it("recovers a refund request left in flight by a crash", async () => {
    const { id, lines } = await paidOrder();
    fake.loseNextRefundResponse = true;
    await post(`/orders/${id}/refunds`, { line_id: lines[1], amount: 100 });
    // simulate the crash window: the request is still 'requested' and its resolve job is gone
    await db.query("UPDATE refund_requests SET state = 'requested'");
    await db.query("DELETE FROM jobs WHERE type = 'resolve_refund_request'");
    assert.equal(await app.shop.recoverRefundRequests(), 1);
    fake.idem.clear();
    await assert.rejects(
      app.shop.resolveRefundRequest(String((await one<{ id: string }>("SELECT id FROM refund_requests")).id)),
      /still unknown/,
    );
    assert.equal((await one<{ state: string }>("SELECT state FROM refund_requests")).state, "unknown");
    const ref = [...fake.refunds.keys()][0];
    assert.ok(ref);
    await app.shop.onRefundJob(ref);
    assert.equal((await one<{ state: string }>("SELECT state FROM refund_requests")).state, "sent");
    assert.equal(fake.refunds.size, 1);
  });

  it("handles a dashboard refund whose webhook arrives before the payment's", async () => {
    const o = await post("/orders", { lines: [{ seller_id: "seller_a", amount: 800 }] });
    const id = String(o.body.id);
    const ref = String((await post(`/orders/${id}/checkout`)).body.payment_ref);
    fake.pay(ref);
    fake.refunds.set("re_dash", { paymentRef: ref, amount: 300n, currency: "INR", status: "succeeded" });
    await webhook(refundEvent("evt_dash", "re_dash", ref)); // before any payment webhook
    await drain();
    const rf = await one<{ origin: string; line_id: string | null }>(
      "SELECT origin, line_id FROM refunds WHERE provider_ref = 're_dash'",
    );
    assert.deepEqual(rf, { origin: "provider", line_id: null });
    assert.equal(
      (await one<{ status: string }>("SELECT status FROM orders WHERE id = $1", [id])).status,
      "partially_refunded",
    );
    const clearing = await one<{ s: bigint }>(
      "SELECT sum(amount)::bigint s FROM ledger_entries WHERE account = 'provider:clearing'",
    );
    assert.equal(clearing.s, 500n);
  });

  it("captures a manual order once and derives the order status from money", async () => {
    const { id } = await paidOrder("manual");
    assert.equal(
      (await one<{ status: string }>("SELECT status FROM orders WHERE id = $1", [id])).status,
      "authorized",
    );
    assert.equal((await one<{ n: bigint }>("SELECT count(*)::bigint n FROM ledger_entries")).n, 0n);
    const [a, b] = await Promise.all([post(`/orders/${id}/capture`), post(`/orders/${id}/capture`)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(
      (await one<{ status: string }>("SELECT status FROM orders WHERE id = $1", [id])).status,
      "paid",
    );
    const clearing = await one<{ s: bigint }>(
      "SELECT sum(amount)::bigint s FROM ledger_entries WHERE account = 'provider:clearing'",
    );
    assert.equal(clearing.s, 1500n);
  });

  it("refuses an unbalanced ledger transaction at commit", async () => {
    await assert.rejects(
      db.query(
        "INSERT INTO ledger_entries (txn_id, account, currency, amount, cause_ref, kind, effect_ref) VALUES ('t', 'a', 'INR', 5, 'c', 'k', 'e')",
      ),
      /does not balance/,
    );
  });

  it("re-queues a job a crashed worker left running", async () => {
    await db.query(
      "INSERT INTO jobs (type, payload, state) VALUES ('payment', '{\"ref\":\"pi_none\"}', 'running')",
    );
    assert.equal(await app.worker.recover(), 1);
    assert.equal((await one<{ state: string }>("SELECT state FROM jobs")).state, "queued");
  });
  it("rejects contradictory checkout metadata without attributing the payment", async () => {
    const o = await app.shop.createOrder({ lines: [{ seller_id: "seller_a", amount: 500 }] });
    const create = fake.createPayment.bind(fake);
    fake.createPayment = async (p) => ({ ...(await create(p)), orderId: "another_order" });
    await assert.rejects(app.shop.checkout(String(o.id)), /another order/);
    assert.equal((await one<{ n: bigint }>("SELECT count(*)::bigint n FROM payments")).n, 0n);
  });

  it("keeps the reservation when an unknown refund attempt is later refused", async () => {
    const { id, lines } = await paidOrder();
    fake.loseNextRefundResponse = true;
    const r = await post(`/orders/${id}/refunds`, { line_id: lines[0], amount: 700 });
    assert.equal(r.status, 202);
    let retries = 0;
    fake.createRefund = async () => {
      retries++;
      throw new ProviderError("rejected", 400, "later refusal");
    };
    await assert.rejects(app.shop.resolveRefundRequest(String(r.body.request_id)), /still unknown/);
    assert.equal(retries, 0);
    assert.equal((await one<{ state: string }>("SELECT state FROM refund_requests")).state, "unknown");
    assert.equal((await post(`/orders/${id}/refunds`, { line_id: lines[0], amount: 301 })).status, 400);
    assert.equal(fake.refunds.size, 1);
  });

  it("does not resolve a reservation with a mismatched provider refund response", async () => {
    for (const field of ["paymentRef", "requestId", "amount", "currency"] as const) {
      const { id, lines } = await paidOrder();
      const create = fake.createRefund.bind(fake);
      fake.createRefund = async (ref, p) => ({
        ...(await create(ref, p)),
        ...{ [field]: field === "amount" ? 201n : field === "currency" ? "USD" : "wrong_identity" },
      });
      const response = await post(`/orders/${id}/refunds`, { line_id: lines[0], amount: 200 });
      assert.ok(response.status >= 500);
      assert.equal(
        (await one<{ state: string }>("SELECT state FROM refund_requests WHERE order_id=$1", [id])).state,
        "unknown",
      );
      assert.equal(
        (await one<{ n: bigint }>("SELECT count(*)::bigint n FROM refunds WHERE order_id=$1", [id])).n,
        0n,
      );
      fake.createRefund = create;
    }
  });

  it("rolls back an authoritative refund resurrection after its ledger reversal", async () => {
    const { id, lines } = await paidOrder();
    const r = await post(`/orders/${id}/refunds`, { line_id: lines[0], amount: 200 });
    const ref = String(r.body.provider_refund_id);
    const refund = fake.refunds.get(ref);
    assert.ok(refund);
    refund.status = "failed";
    await app.shop.onRefundJob(ref);
    refund.status = "succeeded";
    await assert.rejects(app.shop.onRefundJob(ref), /after its reversal/);
    assert.equal(
      (await one<{ status: string }>("SELECT status FROM refunds WHERE provider_ref=$1", [ref])).status,
      "failed",
    );
    assert.equal(
      (
        await one<{ s: bigint }>(
          "SELECT sum(amount)::bigint s FROM ledger_entries WHERE cause_ref=$1 AND account='provider:clearing'",
          [ref],
        )
      ).s,
      0n,
    );
  });

  it("refuses changed payment money and lookups of another object without altering accounting", async () => {
    const { ref } = await paidOrder();
    const original = await fake.retrievePayment(ref);
    for (const change of [
      { ref: "pi_other" },
      { amount: 1501n },
      { currency: "USD" },
      { amountCaptured: 1501n },
      { orderId: "other" },
    ]) {
      fake.retrievePayment = async () => ({ ...original, ...change });
      await assert.rejects(app.shop.reconcilePayment(ref), ProviderError);
    }
    assert.equal(
      (
        await one<{ s: bigint }>(
          "SELECT sum(amount)::bigint s FROM ledger_entries WHERE account='provider:clearing'",
        )
      ).s,
      1500n,
    );
  });

  it("refuses changed refund money or payment linkage without altering accounting", async () => {
    const { id, lines } = await paidOrder();
    const r = await post(`/orders/${id}/refunds`, { line_id: lines[0], amount: 200 });
    const ref = String(r.body.provider_refund_id);
    const original = await fake.retrieveRefund(ref);
    for (const change of [{ amount: 201n }, { currency: "USD" }, { paymentRef: "pi_other" }]) {
      await assert.rejects(
        app.shop.applyRefund({ ...original, ...change }, { authoritative: true }),
        ProviderError,
      );
    }
    assert.equal(
      (await one<{ amount: bigint }>("SELECT amount FROM refunds WHERE provider_ref=$1", [ref])).amount,
      200n,
    );
    assert.equal(
      (
        await one<{ s: bigint }>(
          "SELECT sum(amount)::bigint s FROM ledger_entries WHERE cause_ref=$1 AND account='provider:clearing'",
          [ref],
        )
      ).s,
      -200n,
    );
  });

  it("cannot free a different same-order reservation using a known refund", async () => {
    const { id, lines } = await paidOrder();
    const first = await post(`/orders/${id}/refunds`, { line_id: lines[0], amount: 300 });
    fake.loseNextRefundResponse = true;
    const second = await post(`/orders/${id}/refunds`, { line_id: lines[0], amount: 300 });
    assert.equal(second.status, 202);
    const snapshot = await fake.retrieveRefund(String(first.body.provider_refund_id));
    await assert.rejects(
      app.shop.applyRefund(
        { ...snapshot, requestId: String(second.body.request_id) },
        { authoritative: true },
      ),
      /linked request/,
    );
    assert.equal(
      (
        await one<{ state: string }>("SELECT state FROM refund_requests WHERE id=$1", [
          second.body.request_id,
        ])
      ).state,
      "unknown",
    );
    assert.equal((await post(`/orders/${id}/refunds`, { line_id: lines[0], amount: 401 })).status, 400);
  });

  it("cannot resolve a request against another payment on the same order", async () => {
    const { id, lines } = await paidOrder();
    fake.loseNextRefundResponse = true;
    const r = await post(`/orders/${id}/refunds`, { line_id: lines[0], amount: 300 });
    await app.shop.applyPayment({
      ref: "pi_second",
      status: "succeeded",
      amount: 1500n,
      amountCaptured: 1500n,
      currency: "INR",
      orderId: id,
      clientSecret: null,
    });
    await assert.rejects(
      app.shop.applyRefund(
        {
          ref: "re_second",
          paymentRef: "pi_second",
          amount: 300n,
          currency: "INR",
          status: "succeeded",
          requestId: String(r.body.request_id),
        },
        { authoritative: true },
      ),
      /allocated payment/,
    );
    assert.equal(
      (await one<{ state: string }>("SELECT state FROM refund_requests WHERE id=$1", [r.body.request_id]))
        .state,
      "unknown",
    );
    assert.equal((await one<{ n: bigint }>("SELECT count(*)::bigint n FROM refunds")).n, 0n);
  });

  it("does not resolve an unknown request by relabeling an already unlinked refund", async () => {
    const { id, lines, ref } = await paidOrder();
    await app.shop.applyRefund(
      {
        ref: "re_dashboard",
        paymentRef: ref,
        amount: 200n,
        currency: "INR",
        status: "succeeded",
        requestId: undefined,
      },
      { authoritative: true },
    );
    fake.loseNextRefundResponse = true;
    const r = await post(`/orders/${id}/refunds`, { line_id: lines[0], amount: 200 });
    assert.equal(r.status, 202);
    await app.shop.applyRefund(
      {
        ref: "re_dashboard",
        paymentRef: ref,
        amount: 200n,
        currency: "INR",
        status: "succeeded",
        requestId: String(r.body.request_id),
      },
      { authoritative: true },
    );
    assert.equal(
      (await one<{ state: string }>("SELECT state FROM refund_requests WHERE id=$1", [r.body.request_id]))
        .state,
      "unknown",
    );
    assert.equal(
      (
        await one<{ request_id: string | null }>(
          "SELECT request_id FROM refunds WHERE provider_ref='re_dashboard'",
        )
      ).request_id,
      null,
    );
  });

  it("cannot declare settlement with a failed money job or an unresolved request", async () => {
    const profile = readFileSync(new URL("../moneyinvariant.yaml", import.meta.url), "utf8");
    const match = profile.match(/^ {4}probe: >-\n([\s\S]*?)\n {4}timeout_seconds/m);
    assert.ok(match);
    const body = match[1];
    assert.ok(body);
    const sql = body
      .split("\n")
      .map((s) => s.trim())
      .join(" ");
    const settled = async () => Object.values((await db.query(sql)).rows[0])[0];
    const { id, lines } = await paidOrder();
    assert.equal(await settled(), true);
    fake.loseNextRefundResponse = true;
    assert.equal((await post(`/orders/${id}/refunds`, { line_id: lines[0], amount: 100 })).status, 202);
    await db.query("UPDATE jobs SET state='failed' WHERE type='resolve_refund_request'");
    assert.equal(await settled(), false);
    await db.query("UPDATE jobs SET state='queued', run_after=now() WHERE type='resolve_refund_request'");
    await drain();
    assert.equal(await settled(), false); // retries cannot establish non-commit after an unknown POST
    const ref = [...fake.refunds.keys()][0];
    assert.ok(ref);
    await app.shop.onRefundJob(ref);
    await db.query("UPDATE jobs SET run_after=now() WHERE type='resolve_refund_request' AND state='queued'");
    await drain();
    assert.equal(await settled(), true);
    await db.query("INSERT INTO jobs (type,payload,state) VALUES ('payment', '{}', 'failed')");
    assert.equal(await settled(), false);
  });
});
