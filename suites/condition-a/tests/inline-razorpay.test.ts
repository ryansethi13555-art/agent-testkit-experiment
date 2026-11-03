import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { areAllLedgerTransactionsBalanced, getLedgerAccountBalance, getLedgerTotal, httpPost } from "./helpers/apps.ts";
import { createTestDb, isPgUp, type TestDatabase } from "./helpers/db.ts";
import { FakeRazorpayServer } from "./helpers/fake-razorpay.ts";

const pgUp = await isPgUp();

describe.skipIf(!pgUp)("Inline Marketplace - Razorpay Payments & Refunds", () => {
  let testDb: TestDatabase;
  let fakeRazorpay: FakeRazorpayServer;
  let app: typeof import("../inline-marketplace/src/server.ts");
  let appBaseUrl = "";
  let dbClient: pg.Client;

  beforeAll(async () => {
    testDb = await createTestDb("inline_rzp");
    dbClient = await testDb.createClient();

    fakeRazorpay = new FakeRazorpayServer();
    const rzpUrl = await fakeRazorpay.start();

    process.env.DATABASE_URL = testDb.connectionString;
    process.env.PAYMENT_PROVIDER = "razorpay";
    process.env.RAZORPAY_KEY_ID = "rzp_test_fake_id";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_fake_secret";
    process.env.RAZORPAY_WEBHOOK_SECRET = fakeRazorpay.webhookSecret;
    process.env.MONEYINV_RAZORPAY_API_BASE = rzpUrl;

    app = await import("../inline-marketplace/src/server.ts");
    await app.migrate();

    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    appBaseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.stop();
    await fakeRazorpay?.stop();
    await dbClient?.end().catch(() => {});
    await testDb?.drop();
  });

  beforeEach(async () => {
    fakeRazorpay.reset();
    await dbClient.query("TRUNCATE orders, order_lines, refunds, refund_requests, ledger_entries, processed_events CASCADE");
  });

  async function createPaidRazorpayOrder(
    lines = [
      { seller_id: "seller_a", amount: 1000 },
      { seller_id: "seller_b", amount: 600 },
    ],
  ) {
    const oRes = await httpPost(appBaseUrl, "/orders", { currency: "INR", lines });
    const orderId = String(oRes.body.id);
    const lineIds = oRes.body.lines as string[];

    const coRes = await httpPost(appBaseUrl, `/orders/${orderId}/checkout`, {});
    const rzpOrderId = String(coRes.body.payment_intent_id);

    // Simulate buyer paying on Razorpay
    const pay = fakeRazorpay.simulateCustomerPayment(rzpOrderId, "captured");

    // Webhook payment.captured
    const event = fakeRazorpay.createPaymentCapturedWebhook(pay);
    await httpPost(appBaseUrl, "/webhooks/razorpay", event.payload, event.headers);

    return { orderId, lineIds, rzpOrderId, pay };
  }

  it("enforces Razorpay INR refund minimum (100 minor units) pre-flight before reservation or network calls", async () => {
    const { orderId, lineIds } = await createPaidRazorpayOrder();
    const lineA = lineIds[0];

    // Try refunding 1 minor unit, 50 minor units, 99 minor units
    for (const invalidAmount of [1, 50, 99]) {
      const res = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
        line_id: lineA,
        amount: invalidAmount,
      });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain("minimum Razorpay INR refund is 100 minor units");
    }

    // Verify no reservation created in database
    const reqCount = (await dbClient.query("SELECT count(*)::int AS c FROM refund_requests")).rows[0].c;
    expect(reqCount).toBe(0);

    // Verify no refund calls reached fake Razorpay
    const rzpRefundCalls = fakeRazorpay.calls.filter((c) => c.path.includes("/refund"));
    expect(rzpRefundCalls.length).toBe(0);

    // Exactly 100 minor units succeeds!
    const validRes = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineA,
      amount: 100,
    });
    expect(validRes.status).toBe(200);
    expect(fakeRazorpay.refunds.size).toBe(1);
  });

  it("completes checkout, receives payment.captured webhook, and posts balanced double-entry ledger", async () => {
    const oRes = await httpPost(appBaseUrl, "/orders", {
      currency: "INR",
      lines: [
        { seller_id: "seller_a", amount: 1500 },
        { seller_id: "seller_b", amount: 500 },
      ],
    });
    const orderId = String(oRes.body.id);

    const coRes = await httpPost(appBaseUrl, `/orders/${orderId}/checkout`, {});
    expect(coRes.status).toBe(200);
    const rzpOrderId = String(coRes.body.payment_intent_id);
    expect(rzpOrderId).toMatch(/^order_fake_/);

    const pay = fakeRazorpay.simulateCustomerPayment(rzpOrderId, "captured");

    const event = fakeRazorpay.createPaymentCapturedWebhook(pay);
    const whRes = await httpPost(appBaseUrl, "/webhooks/razorpay", event.payload, event.headers);
    expect(whRes.status).toBe(200);

    // Order status should be paid
    const orderDb = (await dbClient.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderDb.status).toBe("paid");

    // Double entry ledger balanced
    expect(await getLedgerTotal(dbClient)).toBe(0n);
    expect(await areAllLedgerTransactionsBalanced(dbClient)).toBe(true);

    const clearing = await getLedgerAccountBalance(dbClient, "provider:clearing");
    expect(clearing).toBe(2000n);

    // Seller a: 1500 - 150 = 1350
    const sellerA = await getLedgerAccountBalance(dbClient, "seller:seller_a");
    expect(sellerA).toBe(-1350n);

    // Seller b: 500 - 50 = 450
    const sellerB = await getLedgerAccountBalance(dbClient, "seller:seller_b");
    expect(sellerB).toBe(-450n);

    // Duplicate webhook redelivery
    const dupWhRes = await httpPost(appBaseUrl, "/webhooks/razorpay", event.payload, event.headers);
    expect(dupWhRes.status).toBe(200);

    const entryCount = (await dbClient.query("SELECT count(*)::int AS c FROM ledger_entries")).rows[0].c;
    expect(entryCount).toBe(5); // 1 clearing + 2 sellers + 2 commissions
  });

  it("verifies Razorpay webhook HMAC signatures and rejects invalid signatures", async () => {
    const { pay } = await createPaidRazorpayOrder();
    const event = fakeRazorpay.createPaymentCapturedWebhook(pay);

    // Tamper with signature
    const badRes = await httpPost(appBaseUrl, "/webhooks/razorpay", event.payload, {
      "x-razorpay-signature": "invalid_hex_signature_here",
    });
    expect(badRes.status).toBe(400);
    expect(badRes.body.error).toBe("invalid signature");
  });

  it("refunds through Razorpay payments API passing X-Refund-Idempotency and updates order status", async () => {
    const { orderId, lineIds, pay } = await createPaidRazorpayOrder();
    const lineA = lineIds[0];

    const refRes = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineA,
      amount: 400,
    });
    expect(refRes.status).toBe(200);

    // Verify call to fake Razorpay included idempotency header
    const refundCall = fakeRazorpay.calls.find((c) => c.path === `/v1/payments/${pay.id}/refund`);
    expect(refundCall).toBeDefined();
    expect(refundCall?.headers["x-refund-idempotency"]).toBeDefined();

    // Verify order status
    const orderDb = (await dbClient.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderDb.status).toBe("partially_refunded");

    // Ledger checks
    expect(await getLedgerTotal(dbClient)).toBe(0n);
    expect(await areAllLedgerTransactionsBalanced(dbClient)).toBe(true);

    const clearing = await getLedgerAccountBalance(dbClient, "provider:clearing");
    expect(clearing).toBe(1200n); // 1600 - 400
  });

  it("handles concurrent checkouts on the same order idempotently with Razorpay", async () => {
    const oRes = await httpPost(appBaseUrl, "/orders", {
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = String(oRes.body.id);

    const promises = Array.from({ length: 8 }, () =>
      httpPost(appBaseUrl, `/orders/${orderId}/checkout`, {}),
    );
    const results = await Promise.all(promises);

    const successful = results.filter((r) => r.status === 200);
    expect(successful.length).toBeGreaterThanOrEqual(1);

    const rzpOrderId = String(successful[0].body.payment_intent_id);
    for (const s of successful) {
      expect(s.body.payment_intent_id).toBe(rzpOrderId);
    }

    // Only one Razorpay order created for this shop order
    const createdOrders = [...fakeRazorpay.orders.values()].filter((o) => o.notes?.order_id === orderId);
    expect(createdOrders.length).toBe(1);
  });
});
