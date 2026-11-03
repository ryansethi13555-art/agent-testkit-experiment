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

describe("Inline Marketplace (LeakyBazaar) · Razorpay Playbook Scenarios", () => {
  let dbUrl: string;
  let dbCleanup: () => Promise<void>;
  let twin: EnhancedTwin;
  let app: typeof import("../inline-marketplace/src/server.ts");
  let appUrl: string;
  let db: pg.Client;

  beforeAll(async () => {
    twin = await startTwin("razorpay");
    const testDb = await createTestDb("inline_razorpay");
    dbUrl = testDb.dbUrl;
    dbCleanup = testDb.cleanup;

    process.env.DATABASE_URL = dbUrl;
    process.env.PAYMENT_PROVIDER = "razorpay";
    process.env.RAZORPAY_KEY_ID = twin.secrets.apiKeyId ?? "rzp_test_mi";
    process.env.RAZORPAY_KEY_SECRET = twin.secrets.apiSecret ?? twin.secrets.apiKey;
    process.env.RAZORPAY_WEBHOOK_SECRET = twin.secrets.webhookSecret;
    process.env.MONEYINV_RAZORPAY_API_BASE = twin.url;

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
    if (app?.server) await new Promise<void>((resolve) => app.server.close(() => resolve()));
    if (db) await db.end();
    if (twin) await twin.stop();
    if (dbCleanup) await dbCleanup();
  });

  async function sendRazorpayWebhook(event: Record<string, unknown>, signatureOverride?: string) {
    const payload = JSON.stringify(event);
    const sig = signatureOverride ?? twin.signRazorpayWebhook(payload);
    return post(appUrl, "/webhooks/razorpay", payload, {
      "x-razorpay-signature": sig,
    });
  }

  async function createPaidOrder(lines = [
    { seller_id: "seller_a", amount: 600 },
    { seller_id: "seller_b", amount: 400 },
  ]) {
    const orderRes = await post(appUrl, "/orders", {
      buyer: "buyer_rzp_inline",
      currency: "INR",
      lines,
      capture: "automatic",
    });
    expect(orderRes.status).toBe(201);
    const orderId = String(orderRes.body.id);
    const lineIds = (orderRes.body.lines as (string | { id: string })[]).map((l) =>
      typeof l === "string" ? l : l.id,
    );

    const checkoutRes = await post(appUrl, `/orders/${orderId}/checkout`, {});
    expect(checkoutRes.status).toBe(200);
    const rzpOrderId = String(checkoutRes.body.payment_intent_id ?? checkoutRes.body.payment_ref);

    // Customer completes payment at Razorpay twin
    await twin.confirmPayment(rzpOrderId);

    return { orderId, lineIds, rzpOrderId };
  }

  // S16: Forged webhook signature
  it("S16: Forged Razorpay webhook with bad signature is rejected", async () => {
    const payload = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: "pay_forged_inline",
            order_id: "order_forged",
            amount: 1000,
            currency: "INR",
            status: "captured",
          },
        },
      },
    };

    const res = await sendRazorpayWebhook(payload, "bad_forged_signature_hex");
    expect(res.status).toBe(400);

    const payments = (await db.query("SELECT * FROM orders WHERE status='paid'")).rows;
    expect(payments.length).toBe(0);
  });

  // S01: Duplicate webhook delivery
  it("S01: Webhook payment.captured books payment once and balances ledger", async () => {
    const { orderId, rzpOrderId } = await createPaidOrder();

    const payEvt = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: `pay_s01_${Date.now()}`,
            order_id: rzpOrderId,
            amount: 1000,
            currency: "INR",
            status: "captured",
            captured: true,
            notes: { order_id: orderId },
          },
        },
      },
    };

    const res1 = await sendRazorpayWebhook(payEvt);
    expect(res1.status).toBe(200);

    const orderDb = (await db.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderDb?.status).toBe("paid");

    // Second delivery of same webhook
    const res2 = await sendRazorpayWebhook(payEvt);
    expect(res2.status).toBe(200);

    const ledgerEntries = (await db.query("SELECT count(*) c FROM ledger_entries WHERE cause_ref=$1 AND kind='sale'", [rzpOrderId])).rows[0].c;
    expect(Number(ledgerEntries)).toBe(3);

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "inline-marketplace" });
  });

  // Razorpay INR refund minimum limit (< 100 rejected)
  it("Razorpay contract: Minimum INR refund is 100 minor units", async () => {
    const { orderId, lineIds, rzpOrderId } = await createPaidOrder();

    await sendRazorpayWebhook({
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: `pay_min_${Date.now()}`,
            order_id: rzpOrderId,
            amount: 1000,
            currency: "INR",
            status: "captured",
            captured: true,
            notes: { order_id: orderId },
          },
        },
      },
    });

    // 50 minor units is rejected (< 100)
    const badRefRes = await post(appUrl, `/orders/${orderId}/refunds`, {
      line_id: lineIds[0],
      amount: 50,
    });
    expect(badRefRes.status).toBe(400);
    expect(String(badRefRes.body.error)).toMatch(/100 minor units/);

    // 200 minor units succeeds
    const okRefRes = await post(appUrl, `/orders/${orderId}/refunds`, {
      line_id: lineIds[0],
      amount: 200,
    });
    expect(okRefRes.status).toBe(200);

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "inline-marketplace" });
  });

  // S10: Line refund headroom limit
  it("S10: Sequential partial refunds bounded by line headroom", async () => {
    const { orderId, lineIds, rzpOrderId } = await createPaidOrder([
      { seller_id: "seller_a", amount: 600 },
    ]);

    await sendRazorpayWebhook({
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: `pay_headroom_${Date.now()}`,
            order_id: rzpOrderId,
            amount: 600,
            currency: "INR",
            status: "captured",
            captured: true,
            notes: { order_id: orderId },
          },
        },
      },
    });

    const res1 = await post(appUrl, `/orders/${orderId}/refunds`, {
      line_id: lineIds[0],
      amount: 400,
    });
    expect(res1.status).toBe(200);

    const res2 = await post(appUrl, `/orders/${orderId}/refunds`, {
      line_id: lineIds[0],
      amount: 300,
    });
    expect(res2.status).toBe(400);

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "inline-marketplace" });
  });

  // S08: Provider 500 on refund leaves no residue
  it("S08: Provider 500 on refund leaves no financial residue", async () => {
    const { orderId, lineIds, rzpOrderId } = await createPaidOrder();

    await sendRazorpayWebhook({
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: `pay_s08_${Date.now()}`,
            order_id: rzpOrderId,
            amount: 1000,
            currency: "INR",
            status: "captured",
            captured: true,
            notes: { order_id: orderId },
          },
        },
      },
    });

    twin.gate.next({ outcome: "500" });

    const refRes = await post(appUrl, `/orders/${orderId}/refunds`, {
      line_id: lineIds[0],
      amount: 300,
    });
    expect([500, 502]).toContain(refRes.status);

    const refunds = (await db.query("SELECT * FROM refunds WHERE order_id=$1 AND status='succeeded'", [orderId])).rows;
    expect(refunds.length).toBe(0);

    twin.gate.clear();
    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "inline-marketplace" });
  });
});
