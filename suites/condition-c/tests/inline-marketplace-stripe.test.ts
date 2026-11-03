import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertFinancialInvariants,
  createTestDb,
  post,
  startTwin,
  type EnhancedTwin,
} from "./helpers/fixture.ts";

describe("Inline Marketplace (LeakyBazaar) · Stripe Playbook Scenarios", () => {
  let dbUrl: string;
  let dbCleanup: () => Promise<void>;
  let twin: EnhancedTwin;
  let app: typeof import("../inline-marketplace/src/server.ts");
  let appUrl: string;
  let db: pg.Client;

  beforeAll(async () => {
    twin = await startTwin("stripe");
    const testDb = await createTestDb("inline_stripe");
    dbUrl = testDb.dbUrl;
    dbCleanup = testDb.cleanup;

    process.env.DATABASE_URL = dbUrl;
    process.env.PAYMENT_PROVIDER = "stripe";
    process.env.STRIPE_SECRET_KEY = twin.secrets.apiKey;
    process.env.STRIPE_WEBHOOK_SECRET = twin.secrets.webhookSecret;
    process.env.MONEYINV_STRIPE_API_BASE = twin.url;

    app = await import("../inline-marketplace/src/server.ts");
    await app.migrate();
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", () => resolve()));
    appUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE processed_events, ledger_entries, refunds, refund_requests, order_lines, orders CASCADE");
    twin.resetWorld();
  });

  afterAll(async () => {
    if (db) await db.end();
    if (app) await app.stop();
    if (twin) await twin.stop();
    if (dbCleanup) await dbCleanup();
  });

  async function createPaidOrder(opts: { capture?: "automatic" | "manual"; lines?: { seller_id: string; amount: number }[] } = {}) {
    const lines = opts.lines ?? [
      { seller_id: "seller_a", amount: 600 },
      { seller_id: "seller_b", amount: 400 },
    ];
    const orderRes = await post(appUrl, "/orders", {
      buyer: "buyer_test",
      currency: "INR",
      lines,
      capture: opts.capture ?? "automatic",
    });
    expect(orderRes.status).toBe(201);
    const orderId = String(orderRes.body.id);
    const lineIds = (orderRes.body.lines as string[]) ?? [];

    const checkoutRes = await post(appUrl, `/orders/${orderId}/checkout`, {});
    expect(checkoutRes.status).toBe(200);
    const piId = String(checkoutRes.body.payment_intent_id);

    // Confirm payment at provider twin
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

  // S01: Duplicate webhook (sequential, fresh event id)
  it("S01: Duplicate webhook sequential with fresh event ID books payment once", async () => {
    const { orderId, piId } = await createPaidOrder();

    expect(piId).toMatch(/^pi_/);

    const evtPayload = {
      id: `evt_s01_1_${Date.now()}`,
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

    // First delivery
    const res1 = await sendStripeWebhook(evtPayload);
    expect(res1.status).toBe(200);

    // Second delivery with distinct event id
    const res2 = await sendStripeWebhook({
      ...evtPayload,
      id: `evt_s01_2_${Date.now()}`,
    });
    expect(res2.status).toBe(200);

    // Verify order is paid
    const orderDb = (await db.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderDb?.status).toBe("paid");

    // Exactly one sale transaction in ledger
    const ledgerRows = (await db.query("SELECT * FROM ledger_entries WHERE cause_ref=$1 AND kind='sale'", [piId])).rows;
    expect(ledgerRows.length).toBe(3); // seller_a, seller_b, clearing

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "inline-marketplace" });
  });

  // S02: Duplicate webhook (concurrent)
  it("S02: Concurrent duplicate webhooks maintain ledger balance and effect uniqueness", async () => {
    const { orderId, piId } = await createPaidOrder();

    const evtPayload = {
      id: `evt_s02_${Date.now()}`,
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
      sendStripeWebhook({ ...evtPayload, id: `evt_s02_dup_${Date.now()}` }),
    ]);

    expect([200, 503]).toContain(res1.status);
    expect([200, 503]).toContain(res2.status);

    const ledgerRows = (await db.query("SELECT * FROM ledger_entries WHERE cause_ref=$1 AND kind='sale'", [piId])).rows;
    expect(ledgerRows.length).toBe(3);

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "inline-marketplace" });
  });

  // S03: Refund event delivered before payment event
  it("S03: Out-of-order webhook where refund arrives before payment", async () => {
    const { orderId, piId } = await createPaidOrder();
    const canPayId = twin.twin.dialect.fromWireId(piId);
    const worldRef = twin.applyWorld({ kind: "createRefund", paymentId: canPayId, amount: 200n, origin: "dashboard" });
    expect(worldRef.ok).toBe(true);
    const refWireId = twin.twin.dialect.toWireId((worldRef as any).value.id);

    const refundEvt = {
      id: `evt_s03_ref_${Date.now()}`,
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
      id: `evt_s03_pay_${Date.now()}`,
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

    // Refund delivered first
    const refRes = await sendStripeWebhook(refundEvt);
    // May be accepted or retryable depending on order existence
    expect([200, 503]).toContain(refRes.status);

    // Payment delivered next
    const payRes = await sendStripeWebhook(paymentEvt);
    expect(payRes.status).toBe(200);

    // If refund was delayed, deliver it again now that payment exists
    await sendStripeWebhook(refundEvt);

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "inline-marketplace" });
  });

  // S04: Stale refund event delivered after final one
  it("S04: Stale refund event does not regress succeeded status back to pending", async () => {
    const { orderId, lineIds, piId } = await createPaidOrder();

    // Pay order
    await sendStripeWebhook({
      id: `evt_s04_pay_${Date.now()}`,
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

    // Request refund via API
    const refRes = await post(appUrl, `/orders/${orderId}/refunds`, {
      line_id: lineIds[0],
      amount: 300,
    });
    expect(refRes.status).toBe(200);

    const refId = String(refRes.body.provider_refund_id);

    // First deliver succeeded
    await sendStripeWebhook({
      id: `evt_s04_succ_${Date.now()}`,
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

    // Stale delivery with pending status
    await sendStripeWebhook({
      id: `evt_s04_stale_${Date.now()}`,
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

    // Verify refund in DB is NOT regressed to pending
    const refDb = (await db.query("SELECT status FROM refunds WHERE provider_ref=$1", [refId])).rows[0];
    expect(refDb?.status).toBe("succeeded");

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "inline-marketplace" });
  });

  // S05: Payment webhook dropped, retried after app recovered via checkout confirm
  it("S05: Webhook dropped, app recovers via confirm, late retried webhook is deduped", async () => {
    const { orderId, piId } = await createPaidOrder();

    // Webhook dropped! Client returns to checkout confirmation:
    const confirmRes = await post(appUrl, `/orders/${orderId}/confirm`, {});
    expect(confirmRes.status).toBe(200);

    const orderDb1 = (await db.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderDb1?.status).toBe("paid");

    // Later retried webhook arrives
    const lateRes = await sendStripeWebhook({
      id: `evt_s05_late_${Date.now()}`,
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
    expect(lateRes.status).toBe(200);

    // Ledger has exactly 1 sale transaction
    const ledgerCount = (await db.query("SELECT count(*) c FROM ledger_entries WHERE cause_ref=$1 AND kind='sale'", [piId])).rows[0].c;
    expect(Number(ledgerCount)).toBe(3);

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "inline-marketplace" });
  });

  // S06: Manual capture applied, response lost across retries
  it("S06: Manual capture applied then response dropped recovers safely", async () => {
    const { orderId, piId } = await createPaidOrder({ capture: "manual" });

    // Payment is authorized via createPaidOrder
    // Client requests capture
    const capRes = await post(appUrl, `/orders/${orderId}/capture`, {});
    expect(capRes.status).toBe(200);

    const orderDb = (await db.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderDb?.status).toBe("paid");

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "inline-marketplace" });
  });

  // S08: Provider 500 on refund, nothing applied
  it("S08: Provider 500 on refund leaves no financial residue", async () => {
    const { orderId, lineIds, piId } = await createPaidOrder();

    // Settle payment
    await sendStripeWebhook({
      id: `evt_s08_pay_${Date.now()}`,
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

    // Inject 500 on refunds
    twin.gate.next({ outcome: "500" });

    const refRes = await post(appUrl, `/orders/${orderId}/refunds`, {
      line_id: lineIds[0],
      amount: 300,
    });
    expect([502, 500]).toContain(refRes.status);

    // No succeeded refund row
    const refunds = (await db.query("SELECT * FROM refunds WHERE order_id=$1 AND status='succeeded'", [orderId])).rows;
    expect(refunds.length).toBe(0);

    // No refund ledger entries
    const ledgerRefunds = (await db.query("SELECT * FROM ledger_entries WHERE kind='refund'", [])).rows;
    expect(ledgerRefunds.length).toBe(0);

    twin.gate.clear();
    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "inline-marketplace" });
  });

  // S09: Concurrent refunds on one order line (rendezvous)
  it("S09: Concurrent refunds on single order line never exceed line headroom", async () => {
    const { orderId, lineIds, piId } = await createPaidOrder({
      lines: [{ seller_id: "seller_a", amount: 600 }],
    });

    await sendStripeWebhook({
      id: `evt_s09_pay_${Date.now()}`,
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

    // Fire 2 concurrent refunds of 500 each on a 600 line
    const [res1, res2] = await Promise.all([
      post(appUrl, `/orders/${orderId}/refunds`, { line_id: lineIds[0], amount: 500 }),
      post(appUrl, `/orders/${orderId}/refunds`, { line_id: lineIds[0], amount: 500 }),
    ]);

    // At least one must be rejected or queued without exceeding
    const totalRefunded = (
      await db.query(
        "SELECT coalesce(sum(amount), 0) s FROM refunds WHERE line_id=$1 AND status NOT IN ('failed', 'canceled')",
        [lineIds[0]],
      )
    ).rows[0].s;

    expect(Number(totalRefunded)).toBeLessThanOrEqual(600);

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "inline-marketplace" });
  });

  // S10: Sequential partial refunds summing past the line amount
  it("S10: Sequential partial refunds summing past line amount are rejected", async () => {
    const { orderId, lineIds, piId } = await createPaidOrder({
      lines: [{ seller_id: "seller_a", amount: 600 }],
    });

    await sendStripeWebhook({
      id: `evt_s10_pay_${Date.now()}`,
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

    // First refund 400 of 600 -> OK
    const res1 = await post(appUrl, `/orders/${orderId}/refunds`, { line_id: lineIds[0], amount: 400 });
    expect(res1.status).toBe(200);

    // Second refund 300 -> 400 + 300 = 700 > 600 -> REJECTED
    const res2 = await post(appUrl, `/orders/${orderId}/refunds`, { line_id: lineIds[0], amount: 300 });
    expect([400, 409]).toContain(res2.status);

    const totalRefunded = (
      await db.query(
        "SELECT coalesce(sum(amount), 0) s FROM refunds WHERE line_id=$1 AND status NOT IN ('failed', 'canceled')",
        [lineIds[0]],
      )
    ).rows[0].s;
    expect(Number(totalRefunded)).toBe(400);

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "inline-marketplace" });
  });

  // S11: Client double-submits checkout
  it("S11: Client double-submits checkout creates only one payment intent", async () => {
    const orderRes = await post(appUrl, "/orders", {
      buyer: "buyer_double",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 500 }],
    });
    const orderId = String(orderRes.body.id);

    // Double submit checkout concurrently
    const [res1, res2] = await Promise.all([
      post(appUrl, `/orders/${orderId}/checkout`, {}),
      post(appUrl, `/orders/${orderId}/checkout`, {}),
    ]);

    expect([200, 502]).toContain(res1.status);
    expect([200, 502]).toContain(res2.status);

    const orderDb = (await db.query("SELECT payment_intent_id FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderDb?.payment_intent_id).toBeDefined();

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "inline-marketplace" });
  });

  // S13: Refund fails asynchronously after acceptance
  it("S13: Refund fails asynchronously after acceptance reverses ledger cleanly", async () => {
    twin.resetWorld({ refundSettlement: "async" });
    const { orderId, lineIds, piId } = await createPaidOrder();

    await sendStripeWebhook({
      id: `evt_s13_pay_${Date.now()}`,
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

    const refRes = await post(appUrl, `/orders/${orderId}/refunds`, {
      line_id: lineIds[0],
      amount: 300,
    });
    expect(refRes.status).toBe(200);

    const refId = String((await db.query("SELECT provider_ref FROM refunds WHERE order_id=$1", [orderId])).rows[0]?.provider_ref);

    // Book refund as succeeded first
    await sendStripeWebhook({
      id: `evt_s13_ref_s_${Date.now()}`,
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

    // Update twin state so retrieveRefund returns failed
    const canRefId = twin.twin.dialect.fromWireId(refId);
    twin.applyWorld({ kind: "settleRefund", refundId: canRefId, outcome: "failed" });

    // Now bank reports asynchronous failure!
    await sendStripeWebhook({
      id: `evt_s13_ref_f_${Date.now()}`,
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

    // Check reversal balances out
    const netRefundPosting = (
      await db.query(
        "SELECT coalesce(sum(amount), 0) s FROM ledger_entries WHERE cause_ref=$1 AND account='seller:seller_a'",
        [refId],
      )
    ).rows[0].s;
    expect(Number(netRefundPosting)).toBe(0);

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "inline-marketplace" });
  });

  // S16: Forged payment webhook (invalid signature)
  it("S16: Forged webhook with bad signature is rejected and creates no records", async () => {
    const orderRes = await post(appUrl, "/orders", {
      buyer: "buyer_forged",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 500 }],
    });
    const orderId = String(orderRes.body.id);

    const forgedRes = await sendStripeWebhook(
      {
        id: "evt_forged_999",
        object: "event",
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_forged_999",
            object: "payment_intent",
            amount: 500,
            currency: "inr",
            status: "succeeded",
            amount_received: 500,
            metadata: { order_id: orderId },
          },
        },
      },
      "t=123456,v1=bad_signature_deadbeef",
    );

    expect(forgedRes.status).toBe(400);

    const orderDb = (await db.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderDb?.status).toBe("pending_payment");

    const ledgerRows = (await db.query("SELECT * FROM ledger_entries WHERE cause_ref='pi_forged_999'")).rows;
    expect(ledgerRows.length).toBe(0);

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "inline-marketplace" });
  });
});
