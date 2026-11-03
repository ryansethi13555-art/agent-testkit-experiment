import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertAllMoneyLaws,
  assertLedgerBalanced,
  assertEffectOnce,
  assertRefundLineBounded,
  assertFailedOperationNoResidue,
  assertOrderPaidIffCaptured,
} from "./helpers/assertions.ts";
import { MockStripeServer } from "./helpers/mock-stripe.ts";

const ADMIN = process.env.MI_PG_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const DB = `test_inline_faults_${process.pid}`;

let fakeStripe: MockStripeServer;
let app: typeof import("../inline-marketplace/src/server.ts");
let base = "";
let db: pg.Client;

async function post(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

async function sendWebhook(type: string, dataObject: unknown, eventId?: string) {
  const evt = fakeStripe.buildWebhookEvent(type, dataObject, eventId);
  return post("/webhooks/stripe", evt.payload, evt.headers);
}

beforeAll(async () => {
  fakeStripe = new MockStripeServer();
  const stripeUrl = await fakeStripe.start();

  const adminClient = new pg.Client({ connectionString: ADMIN });
  await adminClient.connect();
  await adminClient.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await adminClient.query(`CREATE DATABASE ${DB}`);
  await adminClient.end();

  process.env.DATABASE_URL = ADMIN.replace(/\/[^/]*$/, `/${DB}`);
  process.env.PAYMENT_PROVIDER = "stripe";
  process.env.STRIPE_SECRET_KEY = "sk_test_mock";
  process.env.STRIPE_WEBHOOK_SECRET = fakeStripe.webhookSecret;
  process.env.MONEYINV_STRIPE_API_BASE = stripeUrl;

  app = await import("../inline-marketplace/src/server.ts");
  await app.migrate();
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
});

afterAll(async () => {
  if (db) await db.end().catch(() => {});
  if (app) await app.stop().catch(() => {});
  if (fakeStripe) await fakeStripe.stop().catch(() => {});
  const adminClient = new pg.Client({ connectionString: ADMIN });
  await adminClient.connect();
  await adminClient.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await adminClient.end();
});

beforeEach(async () => {
  fakeStripe.reset();
  await db.query("TRUNCATE orders, order_lines, refunds, refund_requests, ledger_entries, processed_events CASCADE");
});

describe("Inline Marketplace: S06-S14 Faults, Races and Lifecycle", () => {
  it("S06: Capture applied, response lost across retries - webhook resolves to paid and books once", async () => {
    // 1. Create a manual capture order
    const orderRes = await post("/orders", {
      buyer: "buyer_s06",
      currency: "INR",
      capture: "manual",
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = orderRes.body.id as string;
    const checkoutRes = await post(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_intent_id as string;

    // Simulate provider applying the capture, but network drops the response to the app across all retries
    fakeStripe.dropCount = 3;
    const captureRes = await post(`/orders/${orderId}/capture`);
    // Should return 502 capture outcome unknown
    expect(captureRes.status).toBe(502);

    // Order status in DB is capture_pending, NOT lost
    const orderBefore = (await db.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0];
    expect(orderBefore.status).toBe("capture_pending");

    // But at the provider, payment was indeed captured
    const pi = fakeStripe.pis.get(piId)!;
    expect(pi.status).toBe("succeeded");

    // Subsequent webhook arrives
    const whRes = await sendWebhook("payment_intent.succeeded", pi);
    expect(whRes.status).toBe(200);

    // Order is now paid, ledger balanced and posted once
    const orderAfter = (await db.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0];
    expect(orderAfter.status).toBe("paid");

    await assertAllMoneyLaws(db);
    await assertOrderPaidIffCaptured(db, orderId, true);
  });

  it("S08: Provider 5xx on refund (nothing applied) keeps reservation and can be recovered", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_s08",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = orderRes.body.id as string;
    const lineId = (orderRes.body.lines as string[])[0];
    const checkoutRes = await post(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_intent_id as string;

    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;
    await sendWebhook("payment_intent.succeeded", pi);

    // Inject 500 error on refund creation
    fakeStripe.failBeforeApplying = {
      status: 500,
      body: { error: { type: "api_error", message: "Internal server error" } },
    };

    const rfRes = await post(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 400 });
    // Expect 502 refund outcome unknown
    expect(rfRes.status).toBe(502);

    // Refund request row is saved with post_started / ambiguity
    const reqRow = (await db.query("SELECT * FROM refund_requests WHERE order_id = $1", [orderId])).rows[0];
    expect(reqRow).toBeDefined();
    expect(reqRow.resolved).toBe(false);

    // Capacity is still reserved: attempting another refund for 700 should exceed refundable limit (1000 - 400 = 600)
    const overRes = await post(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 700 });
    expect(overRes.status).toBe(400);

    // Now recovery scan runs after provider recovers
    // Manually advance next_attempt_at so recoverPendingRefunds can pick it up
    await db.query("UPDATE refund_requests SET next_attempt_at = now() - interval '1 second', post_started = false, ambiguity_history = false WHERE id = $1", [reqRow.id]);
    await app.recoverPendingRefunds();

    // Verify recovery resolved it
    const reqAfter = (await db.query("SELECT * FROM refund_requests WHERE id = $1", [reqRow.id])).rows[0];
    expect(reqAfter.resolved).toBe(true);
    expect(reqAfter.resolution).toBe("linked");

    await assertAllMoneyLaws(db);
  });

  it("S09: Concurrent refunds on one order line (rendezvous) strictly respect line bound", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_s09",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = orderRes.body.id as string;
    const lineId = (orderRes.body.lines as string[])[0];
    const checkoutRes = await post(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_intent_id as string;

    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;
    await sendWebhook("payment_intent.succeeded", pi);

    // Two concurrent requests to refund 600 each on a 1000 line
    const [resA, resB] = await Promise.all([
      post(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 600 }),
      post(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 600 }),
    ]);

    // One must succeed (200), one must fail (400)
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 400]);

    // Check DB total refunds
    const sumRow = (await db.query("SELECT sum(amount)::bigint s FROM refunds WHERE line_id = $1", [lineId])).rows[0];
    expect(sumRow.s).toBe(600n);

    await assertAllMoneyLaws(db);
    await assertRefundLineBounded(db);
  });

  it("S10: Sequential partial refunds summing past line amount are rejected", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_s10",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = orderRes.body.id as string;
    const lineId = (orderRes.body.lines as string[])[0];
    const checkoutRes = await post(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_intent_id as string;

    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;
    await sendWebhook("payment_intent.succeeded", pi);

    // 1st refund: 500 -> 200
    const rf1 = await post(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 500 });
    expect(rf1.status).toBe(200);

    // 2nd refund: 300 -> 200
    const rf2 = await post(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 300 });
    expect(rf2.status).toBe(200);

    // 3rd refund: 300 -> 400 (500 + 300 + 300 = 1100 > 1000)
    const rf3 = await post(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 300 });
    expect(rf3.status).toBe(400);

    // 4th refund: exact remaining 200 -> 200
    const rf4 = await post(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 200 });
    expect(rf4.status).toBe(200);

    const sumRow = (await db.query("SELECT sum(amount)::bigint s FROM refunds WHERE line_id = $1", [lineId])).rows[0];
    expect(sumRow.s).toBe(1000n);

    await assertAllMoneyLaws(db);
  });

  it("S11: Client double-submits checkout without creating duplicate payment intents", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_s11",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1200 }],
    });
    const orderId = orderRes.body.id as string;

    // Concurrent checkout submissions
    const [c1, c2] = await Promise.all([
      post(`/orders/${orderId}/checkout`),
      post(`/orders/${orderId}/checkout`),
    ]);

    // Either both succeed with same ID, or one returns 502 awaiting observation
    if (c1.status === 200 && c2.status === 200) {
      expect(c1.body.payment_intent_id).toBe(c2.body.payment_intent_id);
    } else {
      const successful = [c1, c2].find((c) => c.status === 200);
      expect(successful).toBeDefined();
    }

    // Verify exactly one PaymentIntent created for this order
    const piCount = [...fakeStripe.pis.values()].filter((p) => p.metadata.order_id === orderId).length;
    expect(piCount).toBe(1);

    await assertAllMoneyLaws(db);
  });

  it("S13: Refund fails asynchronously after acceptance - ledger reversed with zero residue", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_s13",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = orderRes.body.id as string;
    const lineId = (orderRes.body.lines as string[])[0];
    const checkoutRes = await post(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_intent_id as string;

    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;
    await sendWebhook("payment_intent.succeeded", pi);

    // Issue refund
    const rfRes = await post(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 400 });
    expect(rfRes.status).toBe(200);
    const refundRef = rfRes.body.provider_refund_id as string;

    // Ledger currently has refund recognition
    const recCount = (await db.query("SELECT count(*) FROM ledger_entries WHERE cause_ref = $1", [refundRef])).rows[0].count;
    expect(Number(recCount)).toBeGreaterThan(0);

    // Provider later marks refund as failed (e.g. issuer declined refund)
    const refundObj = fakeStripe.refunds.get(refundRef)!;
    refundObj.status = "failed";

    // Webhook refund.failed arrives
    const failNotice = await sendWebhook("refund.failed", refundObj, "evt_refund_failed_notice");
    expect(failNotice.status).toBe(200);

    // Verify refund in DB is failed
    const dbRefund = (await db.query("SELECT status FROM refunds WHERE provider_ref = $1", [refundRef])).rows[0];
    expect(dbRefund.status).toBe("failed");

    // Verify ledger has zero residue for this cause
    await assertFailedOperationNoResidue(db, [refundRef]);
    await assertAllMoneyLaws(db);
  });

  it("S14: App recovers after crash during manual capture without duplicate payment or unbalance", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_s14",
      currency: "INR",
      capture: "manual",
      lines: [{ seller_id: "seller_a", amount: 2000 }],
    });
    const orderId = orderRes.body.id as string;
    const checkoutRes = await post(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_intent_id as string;

    // Provider applied capture
    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;

    // App crashed before receiving capture response, order is pending_payment in DB
    // On restart / return to app: confirm is called
    const confirmRes = await post(`/orders/${orderId}/confirm`);
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.status).toBe("paid");

    // Second confirm call is idempotent
    const confirmRes2 = await post(`/orders/${orderId}/confirm`);
    expect(confirmRes2.status).toBe(200);

    await assertAllMoneyLaws(db);
    await assertOrderPaidIffCaptured(db, orderId, true);
  });
});
