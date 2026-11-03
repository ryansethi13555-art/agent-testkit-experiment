import type { AddressInfo } from "node:net";
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

describe("Worker Marketplace (QueueBazaar) · Razorpay Playbook Scenarios", () => {
  let dbUrl: string;
  let dbCleanup: () => Promise<void>;
  let twin: EnhancedTwin;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let appUrl: string;

  beforeAll(async () => {
    twin = await startTwin("razorpay");
    const testDb = await createTestDb("worker_razorpay");
    dbUrl = testDb.dbUrl;
    dbCleanup = testDb.cleanup;

    process.env.DATABASE_URL = dbUrl;
    process.env.PAYMENT_PROVIDER = "razorpay";
    process.env.RAZORPAY_KEY_ID = twin.secrets.apiKeyId ?? "rzp_test_mi";
    process.env.RAZORPAY_KEY_SECRET = twin.secrets.apiSecret ?? twin.secrets.apiKey;
    process.env.RAZORPAY_WEBHOOK_SECRET = twin.secrets.webhookSecret;
    process.env.MONEYINV_RAZORPAY_API_BASE = twin.url;

    db = createPool(dbUrl);
    await migrate(db);

    const provider = providerFromEnv(process.env);
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
      buyer: "buyer_rzp_w",
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
    const rzpOrderId = String(checkoutRes.body.payment_ref);

    // Customer completes payment at Razorpay twin
    await twin.confirmPayment(rzpOrderId);

    return { orderId, lineIds, rzpOrderId };
  }

  // S16: Forged webhook signature is rejected and never queued
  it("S16: Forged Razorpay webhook with bad signature is rejected with 400", async () => {
    const payload = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: "pay_forged_rzp",
            order_id: "order_forged",
            amount: 1000,
            currency: "INR",
            status: "captured",
          },
        },
      },
    };

    const res = await sendRazorpayWebhook(payload, "invalid_forged_signature_hex");
    expect(res.status).toBe(400);

    const jobs = (await db.query("SELECT * FROM jobs")).rows;
    expect(jobs.length).toBe(0);
  });

  // S01: Duplicate webhook to worker queue dedupes and books payment once
  it("S01: Webhook payment.captured books payment once and balances ledger", async () => {
    const { orderId, rzpOrderId } = await createPaidOrder();

    const payEvt = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: `pay_${Date.now()}`,
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

    const res = await sendRazorpayWebhook(payEvt);
    expect(res.status).toBe(200);
    await drain();

    const orderDb = (await db.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderDb?.status).toBe("paid");

    // Second duplicate webhook
    const resDup = await sendRazorpayWebhook(payEvt);
    expect(resDup.status).toBe(200);
    await drain();

    const payments = (await db.query("SELECT * FROM payments WHERE order_id=$1", [orderId])).rows;
    expect(payments.length).toBe(1);

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "worker-marketplace" });
  });

  // Razorpay contract: minimum refund is 100 minor units
  it("Razorpay contract: refunds under 100 minor units are rejected with 400", async () => {
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
    await drain();

    // 50 minor units (< 100) must be rejected
    const badRes = await post(appUrl, `/orders/${orderId}/refunds`, {
      line_id: lineIds[0],
      amount: 50,
    });
    expect(badRes.status).toBe(400);
    expect(String(badRes.body.error)).toMatch(/100 minor units/);

    // 150 minor units (>= 100) is accepted
    const okRes = await post(appUrl, `/orders/${orderId}/refunds`, {
      line_id: lineIds[0],
      amount: 150,
    });
    expect([200, 202]).toContain(okRes.status);

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "worker-marketplace" });
  });

  // S10: Sequential partial refunds bounded by line headroom
  it("S10: Sequential partial refunds bounded by line headroom", async () => {
    const { orderId, lineIds, rzpOrderId } = await createPaidOrder([
      { seller_id: "seller_a", amount: 600 },
    ]);

    await sendRazorpayWebhook({
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: `pay_s10_${Date.now()}`,
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
    await drain();

    // First refund 400 of 600
    const res1 = await post(appUrl, `/orders/${orderId}/refunds`, {
      line_id: lineIds[0],
      amount: 400,
    });
    expect([200, 202]).toContain(res1.status);

    // Second refund 300 (400 + 300 = 700 > 600) -> rejected
    const res2 = await post(appUrl, `/orders/${orderId}/refunds`, {
      line_id: lineIds[0],
      amount: 300,
    });
    expect([400, 409]).toContain(res2.status);

    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "worker-marketplace" });
  });

  // S08: Provider 500 on refund leaves no financial residue
  it("S08: Provider 500 on Razorpay refund leaves no financial residue", async () => {
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
    await drain();

    twin.gate.next({ outcome: "500" });

    const refRes = await post(appUrl, `/orders/${orderId}/refunds`, {
      line_id: lineIds[0],
      amount: 300,
    });
    expect([202, 500, 502]).toContain(refRes.status);

    const refunds = (await db.query("SELECT * FROM refunds WHERE order_id=$1 AND status='succeeded'", [orderId])).rows;
    expect(refunds.length).toBe(0);

    twin.gate.clear();
    await assertFinancialInvariants({ pgUrl: dbUrl, twin, appId: "worker-marketplace" });
  });
});
