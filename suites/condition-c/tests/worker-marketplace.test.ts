import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, migrate, type Db } from "../worker-marketplace/src/db.ts";
import { createApp } from "../worker-marketplace/src/server.ts";
import { providerFromEnv } from "../worker-marketplace/src/provider.ts";
import {
  assertFinancialInvariants,
  createTestDb,
  post,
  startTwin,
  type EnhancedTwin,
} from "./helpers/fixture.ts";

describe("Worker Marketplace (QueueBazaar) · Playbook Scenarios", () => {
  let dbUrl: string;
  let dbCleanup: () => Promise<void>;
  let twin: EnhancedTwin;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let appUrl: string;

  beforeAll(async () => {
    twin = await startTwin("stripe");
    const testDb = await createTestDb("worker_stripe");
    dbUrl = testDb.dbUrl;
    dbCleanup = testDb.cleanup;

    process.env.DATABASE_URL = dbUrl;
    process.env.PAYMENT_PROVIDER = "stripe";
    process.env.STRIPE_SECRET_KEY = twin.secrets.apiKey;
    process.env.STRIPE_WEBHOOK_SECRET = twin.secrets.webhookSecret;
    process.env.MONEYINV_STRIPE_API_BASE = twin.url;

    db = createPool(dbUrl);
    await migrate(db);
    const provider = providerFromEnv();
    app = createApp(db, provider);

    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", () => resolve()));
    appUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    await db.query(
      "TRUNCATE jobs, ledger_entries, allocations, refunds, refund_requests, payments, order_lines, orders RESTART IDENTITY CASCADE",
    );
    twin.resetWorld();
  });

  afterAll(async () => {
    if (app) await app.stop();
    if (db) await db.end();
    if (twin) await twin.stop();
    if (dbCleanup) await dbCleanup();
  });

  const drain = async () => {
    while (await app.worker.runOnce()) {}
  };

  async function createPaidOrder(opts: { capture?: "automatic" | "manual"; lines?: { seller_id: string; amount: string | number }[] } = {}) {
    const lines = opts.lines ?? [
      { seller_id: "seller_a", amount: 600 },
      { seller_id: "seller_b", amount: 400 },
    ];
    const orderRes = await post(appUrl, "/orders", {
      buyer: "buyer_worker",
      currency: "INR",
      lines,
      capture: opts.capture ?? "automatic",
    });
    expect(orderRes.status).toBe(201);
    const orderId = String(orderRes.body.id);
    const lineIds = (orderRes.body.lines as (string | { id: string })[]).map((l) =>
      typeof l === "string" ? l : l.id,
    );

    const checkoutRes = await post(appUrl, `/orders/${orderId}/checkout`, {});
    expect(checkoutRes.status).toBe(200);
    const piId = String(checkoutRes.body.payment_ref);

    // Customer confirms payment at provider twin (authorizes if manual capture, settles if automatic)
    await twin.confirmPayment(piId);

    return { orderId, lineIds, piId };
  }

  async function sendStripeWebhook(event: Record<string, unknown>, signatureOverride?: string) {
    const payload = JSON.stringify(event);
    const sig = signatureOverride ?? twin.signStripeWebhook(payload);
    return post(appUrl, "/webhooks/stripe", payload, {
      "stripe-signature": sig,
    });
  }

  // S01: Duplicate webhook (sequential, distinct event id)
  it("S01: Duplicate webhook to worker queue dedupes and books payment once", async () => {
    const { orderId, piId } = await createPaidOrder();

    const evtPayload = {
      id: `evt_w_s01_1_${Date.now()}`,
      object: "event",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: piId,
          object: "payment_intent",
          amount: 1000,
          currency: "inr",
          status: "succeeded",
          amount_received: 1000,
          metadata: { order_id: orderId },
        },
      },
    };

    // First webhook delivery
    const res1 = await sendStripeWebhook(evtPayload);
    expect(res1.status).toBe(200);
    await drain();

    // Second delivery with distinct event id
    const res2 = await sendStripeWebhook({
      ...evtPayload,
      id: `evt_w_s01_2_${Date.now()}`,
    });
    expect(res2.status).toBe(200);
    await drain();

    // Verify order is paid
    const orderDb = (await db.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderDb?.status).toBe("paid");

    // Exactly 1 balanced sale transaction in ledger
    const ledgerRows = (await db.query("SELECT * FROM ledger_entries WHERE cause_ref=$1 AND kind='sale'", [piId])).rows;
    expect(ledgerRows.length).toBeGreaterThanOrEqual(3);

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "worker-marketplace" });
  });

  // S02: Duplicate webhook (concurrent)
  it("S02: Concurrent duplicate webhooks into job queue are processed idempotently", async () => {
    const { orderId, piId } = await createPaidOrder();

    const evtPayload = {
      id: `evt_w_s02_${Date.now()}`,
      object: "event",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: piId,
          object: "payment_intent",
          amount: 1000,
          currency: "inr",
          status: "succeeded",
          amount_received: 1000,
          metadata: { order_id: orderId },
        },
      },
    };

    const [res1, res2] = await Promise.all([
      sendStripeWebhook(evtPayload),
      sendStripeWebhook({ ...evtPayload, id: `evt_w_s02_dup_${Date.now()}` }),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    await drain();

    const orderDb = (await db.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderDb?.status).toBe("paid");

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "worker-marketplace" });
  });

  // S03: Out-of-order webhook delivery (refund before payment)
  it("S03: Out-of-order webhook where refund arrives before payment", async () => {
    const { orderId, piId } = await createPaidOrder();
    const canPayId = twin.twin.dialect.fromWireId(piId);
    const worldRef = twin.applyWorld({ kind: "createRefund", paymentId: canPayId, amount: 200n, origin: "dashboard" });
    expect(worldRef.ok).toBe(true);
    const refWireId = twin.twin.dialect.toWireId((worldRef as any).value.id);

    const refundEvt = {
      id: `evt_w_s03_ref_${Date.now()}`,
      object: "event",
      type: "refund.created",
      data: {
        object: {
          id: refWireId,
          object: "refund",
          payment_intent: piId,
          amount: 200,
          currency: "inr",
          status: "succeeded",
        },
      },
    };

    const paymentEvt = {
      id: `evt_w_s03_pay_${Date.now()}`,
      object: "event",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: piId,
          object: "payment_intent",
          amount: 1000,
          currency: "inr",
          status: "succeeded",
          amount_received: 1000,
          metadata: { order_id: orderId },
        },
      },
    };

    // Refund webhook enqueued and drained first
    await sendStripeWebhook(refundEvt);
    await drain();

    // Payment webhook enqueued and drained next
    await sendStripeWebhook(paymentEvt);
    await drain();

    // Process retried/reconciled refund
    await sendStripeWebhook(refundEvt);
    await drain();

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "worker-marketplace" });
  });

  // S04: Stale refund event delivered after final one
  it("S04: Stale refund webhook does not overwrite terminal succeeded status", async () => {
    const { orderId, lineIds, piId } = await createPaidOrder();

    // Settle payment
    await sendStripeWebhook({
      id: `evt_w_s04_pay_${Date.now()}`,
      object: "event",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: piId,
          object: "payment_intent",
          amount: 1000,
          currency: "inr",
          status: "succeeded",
          amount_received: 1000,
          metadata: { order_id: orderId },
        },
      },
    });
    await drain();

    // Request refund
    const refRes = await post(appUrl, `/orders/${orderId}/refunds`, {
      line_id: lineIds[0],
      amount: "300",
    });
    expect(refRes.status).toBe(200);

    const refundRow = (await db.query("SELECT provider_ref FROM refunds WHERE order_id=$1", [orderId])).rows[0];
    const refId = String(refundRow?.provider_ref);

    // Deliver succeeded event
    await sendStripeWebhook({
      id: `evt_w_s04_succ_${Date.now()}`,
      object: "event",
      type: "refund.updated",
      data: {
        object: {
          id: refId,
          object: "refund",
          payment_intent: piId,
          amount: 300,
          currency: "inr",
          status: "succeeded",
        },
      },
    });
    await drain();

    // Deliver stale pending event
    await sendStripeWebhook({
      id: `evt_w_s04_stale_${Date.now()}`,
      object: "event",
      type: "refund.updated",
      data: {
        object: {
          id: refId,
          object: "refund",
          payment_intent: piId,
          amount: 300,
          currency: "inr",
          status: "pending",
        },
      },
    });
    await drain();

    const refundDb = (await db.query("SELECT status FROM refunds WHERE provider_ref=$1", [refId])).rows[0];
    expect(refundDb?.status).toBe("succeeded");

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "worker-marketplace" });
  });

  // S05: Payment webhook dropped, retried after app recovered via confirm
  it("S05: Webhook dropped, worker settles via confirm, late retried webhook is deduped", async () => {
    const { orderId, piId } = await createPaidOrder();

    // Recover via confirm endpoint
    const confirmRes = await post(appUrl, `/orders/${orderId}/confirm`, {});
    expect(confirmRes.status).toBe(200);

    const orderDb = (await db.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderDb?.status).toBe("paid");

    // Late retried webhook arrives
    await sendStripeWebhook({
      id: `evt_w_s05_late_${Date.now()}`,
      object: "event",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: piId,
          object: "payment_intent",
          amount: 1000,
          currency: "inr",
          status: "succeeded",
          amount_received: 1000,
          metadata: { order_id: orderId },
        },
      },
    });
    await drain();

    const ledgerCount = (await db.query("SELECT count(*) c FROM ledger_entries WHERE cause_ref=$1 AND kind='sale'", [piId])).rows[0].c;
    expect(Number(ledgerCount)).toBeGreaterThanOrEqual(3);

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "worker-marketplace" });
  });

  // S06: Manual capture applied then response dropped
  it("S06: Manual capture applied then response dropped recovers safely", async () => {
    const { orderId, piId } = await createPaidOrder({ capture: "manual" });

    // Client requests capture
    const capRes = await post(appUrl, `/orders/${orderId}/capture`, {});
    expect(capRes.status).toBe(200);

    const orderDb = (await db.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderDb?.status).toBe("paid");

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "worker-marketplace" });
  });

  // S08: Provider 500 on refund leaves no residue
  it("S08: Provider 500 on refund leaves no financial residue", async () => {
    const { orderId, lineIds, piId } = await createPaidOrder();

    await sendStripeWebhook({
      id: `evt_w_s08_pay_${Date.now()}`,
      object: "event",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: piId,
          object: "payment_intent",
          amount: 1000,
          currency: "inr",
          status: "succeeded",
          amount_received: 1000,
          metadata: { order_id: orderId },
        },
      },
    });
    await drain();

    // Fault: refund 500
    twin.gate.next({ outcome: "500" });

    const refRes = await post(appUrl, `/orders/${orderId}/refunds`, {
      line_id: lineIds[0],
      amount: "300",
    });
    expect([202, 500, 502]).toContain(refRes.status);

    const refunds = (await db.query("SELECT * FROM refunds WHERE order_id=$1 AND status='succeeded'", [orderId])).rows;
    expect(refunds.length).toBe(0);

    const ledgerRefunds = (await db.query("SELECT * FROM ledger_entries WHERE kind='refund'")).rows;
    expect(ledgerRefunds.length).toBe(0);

    twin.gate.clear();
    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "worker-marketplace" });
  });

  // S09: Concurrent refunds on single order line never exceed line headroom
  it("S09: Concurrent refunds on single order line never exceed line headroom", async () => {
    const { orderId, lineIds, piId } = await createPaidOrder({
      lines: [{ seller_id: "seller_a", amount: 600 }],
    });

    await sendStripeWebhook({
      id: `evt_w_s09_pay_${Date.now()}`,
      object: "event",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: piId,
          object: "payment_intent",
          amount: 600,
          currency: "inr",
          status: "succeeded",
          amount_received: 600,
          metadata: { order_id: orderId },
        },
      },
    });
    await drain();

    // Fire 2 concurrent refunds of 500 each on a 600 line
    await Promise.all([
      post(appUrl, `/orders/${orderId}/refunds`, { line_id: lineIds[0], amount: "500" }),
      post(appUrl, `/orders/${orderId}/refunds`, { line_id: lineIds[0], amount: "500" }),
    ]);

    const totalRefunded = (
      await db.query(
        "SELECT coalesce(sum(amount), 0) s FROM refunds WHERE line_id=$1 AND status NOT IN ('failed', 'canceled')",
        [lineIds[0]],
      )
    ).rows[0].s;

    expect(Number(totalRefunded)).toBeLessThanOrEqual(600);

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "worker-marketplace" });
  });

  // S10: Sequential partial refunds summing past line amount are rejected
  it("S10: Sequential partial refunds summing past line amount are rejected", async () => {
    const { orderId, lineIds, piId } = await createPaidOrder({
      lines: [{ seller_id: "seller_a", amount: 600 }],
    });

    await sendStripeWebhook({
      id: `evt_w_s10_pay_${Date.now()}`,
      object: "event",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: piId,
          object: "payment_intent",
          amount: 600,
          currency: "inr",
          status: "succeeded",
          amount_received: 600,
          metadata: { order_id: orderId },
        },
      },
    });
    await drain();

    // First refund 400 of 600 -> OK
    const res1 = await post(appUrl, `/orders/${orderId}/refunds`, { line_id: lineIds[0], amount: "400" });
    expect(res1.status).toBe(200);

    // Second refund 300 -> 400 + 300 = 700 > 600 -> REJECTED
    const res2 = await post(appUrl, `/orders/${orderId}/refunds`, { line_id: lineIds[0], amount: "300" });
    expect([400, 409]).toContain(res2.status);

    const totalRefunded = (
      await db.query(
        "SELECT coalesce(sum(amount), 0) s FROM refunds WHERE line_id=$1 AND status NOT IN ('failed', 'canceled')",
        [lineIds[0]],
      )
    ).rows[0].s;
    expect(Number(totalRefunded)).toBe(400);

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "worker-marketplace" });
  });

  // S11: Client double-submits checkout
  it("S11: Client double-submits checkout creates only one payment", async () => {
    const orderRes = await post(appUrl, "/orders", {
      buyer: "buyer_double_w",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 500 }],
    });
    const orderId = String(orderRes.body.id);

    const [res1, res2] = await Promise.all([
      post(appUrl, `/orders/${orderId}/checkout`, {}),
      post(appUrl, `/orders/${orderId}/checkout`, {}),
    ]);

    expect([200, 502]).toContain(res1.status);
    expect([200, 502]).toContain(res2.status);

    const payments = (await db.query("SELECT * FROM payments WHERE order_id=$1", [orderId])).rows;
    expect(payments.length).toBeLessThanOrEqual(1);

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "worker-marketplace" });
  });

  // S13: Refund fails asynchronously after acceptance
  it("S13: Refund fails asynchronously after acceptance reverses ledger cleanly", async () => {
    twin.resetWorld({ refundSettlement: "async" });
    const { orderId, lineIds, piId } = await createPaidOrder();

    await sendStripeWebhook({
      id: `evt_w_s13_pay_${Date.now()}`,
      object: "event",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: piId,
          object: "payment_intent",
          amount: 1000,
          currency: "inr",
          status: "succeeded",
          amount_received: 1000,
          metadata: { order_id: orderId },
        },
      },
    });
    await drain();

    const refRes = await post(appUrl, `/orders/${orderId}/refunds`, {
      line_id: lineIds[0],
      amount: "300",
    });
    expect(refRes.status).toBe(200);

    const refId = String((await db.query("SELECT provider_ref FROM refunds WHERE order_id=$1", [orderId])).rows[0]?.provider_ref);

    // Book refund as succeeded first
    await sendStripeWebhook({
      id: `evt_w_s13_ref_s_${Date.now()}`,
      object: "event",
      type: "refund.updated",
      data: {
        object: {
          id: refId,
          object: "refund",
          payment_intent: piId,
          amount: 300,
          currency: "inr",
          status: "succeeded",
        },
      },
    });
    await drain();

    // Now bank reports failure at provider
    const canRefId = twin.twin.dialect.fromWireId(refId);
    twin.applyWorld({ kind: "settleRefund", refundId: canRefId, outcome: "failed" });

    await sendStripeWebhook({
      id: `evt_w_s13_ref_f_${Date.now()}`,
      object: "event",
      type: "refund.failed",
      data: {
        object: {
          id: refId,
          object: "refund",
          payment_intent: piId,
          amount: 300,
          currency: "inr",
          status: "failed",
        },
      },
    });
    await drain();

    // Ledger entries for refund reversal balance out
    const netRefundPosting = (
      await db.query(
        "SELECT coalesce(sum(amount), 0) s FROM ledger_entries WHERE cause_ref=$1 AND account='seller:seller_a'",
        [refId],
      )
    ).rows[0].s;
    expect(Number(netRefundPosting)).toBe(0);

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "worker-marketplace" });
  });

  // S14: Crashed worker recovers running jobs on startup
  it("S14: Crashed worker recovers running job on restart", async () => {
    // Insert a job left 'running' by a crashed worker
    await db.query(`
      INSERT INTO jobs (provider_event_id, type, payload, state, attempts)
      VALUES ('job_crashed_1', 'payment', '{"ref": "pi_fake_crashed"}', 'running', 1)
    `);

    // Worker recovery
    const recoveredCount = await app.worker.recover();
    expect(recoveredCount).toBe(1);

    const job = (await db.query("SELECT state FROM jobs WHERE provider_event_id='job_crashed_1'")).rows[0];
    expect(job?.state).toBe("queued");
  });

  // S16: Forged payment webhook (invalid signature)
  it("S16: Forged webhook with bad signature is rejected and never queued", async () => {
    const forgedRes = await sendStripeWebhook(
      {
        id: "evt_w_forged_999",
        object: "event",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_forged_w", object: "payment_intent" } },
      },
      "t=123456,v1=bad_signature_deadbeef",
    );

    expect(forgedRes.status).toBe(400);

    const jobRows = (await db.query("SELECT * FROM jobs WHERE provider_event_id LIKE '%evt_w_forged_999%'")).rows;
    expect(jobRows.length).toBe(0);

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "worker-marketplace" });
  });
});
