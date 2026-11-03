import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertAllMoneyLaws, assertLedgerBalanced, assertEffectOnce, assertOrderPaidIffCaptured } from "./helpers/assertions.ts";
import { MockStripeServer } from "./helpers/mock-stripe.ts";

const ADMIN = process.env.MI_PG_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const DB = `test_inline_wh_${process.pid}`;

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

async function sendWebhook(type: string, dataObject: unknown, eventId?: string, overrideHeader?: string) {
  const evt = fakeStripe.buildWebhookEvent(type, dataObject, eventId);
  const headers = overrideHeader !== undefined ? { "stripe-signature": overrideHeader } : evt.headers;
  return post("/webhooks/stripe", evt.payload, headers);
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

describe("Inline Marketplace: S01-S05 Webhooks and Interleavings", () => {
  it("S01: Duplicate webhook (sequential, fresh event id) is processed idempotently without duplicate ledger entries", async () => {
    // 1. Create order and checkout
    const orderRes = await post("/orders", {
      buyer: "buyer_1",
      currency: "INR",
      lines: [
        { seller_id: "seller_a", amount: 600 },
        { seller_id: "seller_b", amount: 400 },
      ],
    });
    const orderId = orderRes.body.id as string;
    const checkoutRes = await post(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_intent_id as string;

    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;

    // First webhook delivery
    const res1 = await sendWebhook("payment_intent.succeeded", pi, "evt_first_delivery");
    expect(res1.status).toBe(200);

    const entriesCount1 = (await db.query("SELECT count(*) FROM ledger_entries")).rows[0].count;
    expect(Number(entriesCount1)).toBeGreaterThan(0);

    // Second webhook delivery with a fresh event id (e.g. Stripe resend or separate event object)
    const res2 = await sendWebhook("payment_intent.succeeded", pi, "evt_second_delivery");
    expect(res2.status).toBe(200);

    // Verify ledger count hasn't changed
    const entriesCount2 = (await db.query("SELECT count(*) FROM ledger_entries")).rows[0].count;
    expect(entriesCount2).toBe(entriesCount1);

    // Verify all money laws
    await assertAllMoneyLaws(db);
    await assertOrderPaidIffCaptured(db, orderId, true);
  });

  it("S02: Duplicate webhook (concurrent) does not cause duplicate posting or race condition", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_2",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = orderRes.body.id as string;
    const checkoutRes = await post(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_intent_id as string;

    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;

    // Send 5 concurrent identical webhooks
    const outcomes = await Promise.all([
      sendWebhook("payment_intent.succeeded", pi, "evt_concurrent_1"),
      sendWebhook("payment_intent.succeeded", pi, "evt_concurrent_2"),
      sendWebhook("payment_intent.succeeded", pi, "evt_concurrent_3"),
      sendWebhook("payment_intent.succeeded", pi, "evt_concurrent_1"), // same event ID duplicate
      sendWebhook("payment_intent.succeeded", pi, "evt_concurrent_2"),
    ]);

    for (const r of outcomes) {
      expect([200, 503]).toContain(r.status);
    }

    // Money laws assert single posting and balanced ledger
    await assertAllMoneyLaws(db);
    await assertEffectOnce(db);
  });

  it("S03: Refund event delivered before payment event is held / retried until payment arrives", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_3",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = orderRes.body.id as string;
    const checkoutRes = await post(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_intent_id as string;

    // Create a mock refund on the provider directly
    const refundObj = {
      id: "re_early_arrival",
      object: "refund",
      amount: 400,
      currency: "inr",
      status: "succeeded",
      payment_intent: piId,
      metadata: { order_id: orderId },
    };
    fakeStripe.refunds.set("re_early_arrival", refundObj as any);

    // Send refund webhook BEFORE payment succeeded webhook
    const refundNotice = await sendWebhook("refund.created", refundObj, "evt_early_refund");
    // Should be rejected with 503 so Stripe will retry
    expect(refundNotice.status).toBe(503);

    // No ledger entries should exist yet
    const entries0 = (await db.query("SELECT count(*) FROM ledger_entries")).rows[0].count;
    expect(Number(entries0)).toBe(0);

    // Now deliver payment succeeded
    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;
    const payNotice = await sendWebhook("payment_intent.succeeded", pi, "evt_pay_succeeded");
    expect(payNotice.status).toBe(200);

    // Now redeliver the refund webhook
    const refundRetry = await sendWebhook("refund.created", refundObj, "evt_early_refund_retry");
    expect(refundRetry.status).toBe(200);

    await assertAllMoneyLaws(db);
    await assertLedgerBalanced(db);
  });

  it("S04: Stale refund event delivered after final one does not regress refund status", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_4",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1500 }],
    });
    const orderId = orderRes.body.id as string;
    const lineId = (orderRes.body.lines as string[])[0];
    const checkoutRes = await post(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_intent_id as string;

    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;
    await sendWebhook("payment_intent.succeeded", pi);

    // Issue a refund via API
    const rfRes = await post(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 500 });
    expect(rfRes.status).toBe(200);
    const providerRefundId = rfRes.body.provider_refund_id as string;

    const refund = fakeStripe.refunds.get(providerRefundId)!;
    expect(refund.status).toBe("succeeded");

    // Late arriving webhook claiming the refund is still 'pending'
    const staleRefundObj = { ...refund, status: "pending" };
    const staleNotice = await sendWebhook("refund.updated", staleRefundObj, "evt_stale_refund");
    expect(staleNotice.status).toBe(200);

    // Stored status in DB should still be 'succeeded', never regressed to pending
    const dbRefund = (await db.query("SELECT status FROM refunds WHERE provider_ref = $1", [providerRefundId])).rows[0];
    expect(dbRefund.status).toBe("succeeded");

    await assertAllMoneyLaws(db);
  });

  it("S05: Payment webhook dropped, retried after app already recovered via confirm", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_5",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 2000 }],
    });
    const orderId = orderRes.body.id as string;
    const checkoutRes = await post(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_intent_id as string;

    // Payment succeeds at provider
    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;

    // Webhook was dropped! App buyer returns to checkout success page -> confirm called
    const confirmRes = await post(`/orders/${orderId}/confirm`);
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.status).toBe("paid");

    const entriesCountAfterConfirm = (await db.query("SELECT count(*) FROM ledger_entries")).rows[0].count;
    expect(Number(entriesCountAfterConfirm)).toBeGreaterThan(0);

    // Now dropped webhook finally arrives late
    const lateWebhook = await sendWebhook("payment_intent.succeeded", pi, "evt_late_webhook");
    expect(lateWebhook.status).toBe(200);

    // No duplicate entries created
    const entriesCountAfterWebhook = (await db.query("SELECT count(*) FROM ledger_entries")).rows[0].count;
    expect(entriesCountAfterWebhook).toBe(entriesCountAfterConfirm);

    await assertAllMoneyLaws(db);
  });

  it("S16: Forged payment webhook (invalid signature) is rejected with 400 without state mutation", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_6",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = orderRes.body.id as string;
    const checkoutRes = await post(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_intent_id as string;

    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;

    // Send webhook with invalid signature header
    const badRes = await sendWebhook("payment_intent.succeeded", pi, "evt_forged", "t=12345,v1=bad_signature_hash");
    expect(badRes.status).toBe(400);

    // Order status should still be pending_payment
    const orderDb = (await db.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0];
    expect(orderDb.status).toBe("pending_payment");

    // Zero ledger entries
    const ledgerCount = (await db.query("SELECT count(*) FROM ledger_entries")).rows[0].count;
    expect(Number(ledgerCount)).toBe(0);

    await assertAllMoneyLaws(db);
  });
});
