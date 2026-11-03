import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Db, migrate } from "../worker-marketplace/src/db.ts";
import { providerFromEnv } from "../worker-marketplace/src/provider.ts";
import { createApp } from "../worker-marketplace/src/server.ts";
import { areAllLedgerTransactionsBalanced, getLedgerAccountBalance, getLedgerTotal, httpPost } from "./helpers/apps.ts";
import { createTestDb, isPgUp, type TestDatabase } from "./helpers/db.ts";
import { FakeRazorpayServer } from "./helpers/fake-razorpay.ts";

const pgUp = await isPgUp();

describe.skipIf(!pgUp)("Worker Marketplace - Razorpay Payments & Refunds", () => {
  let testDb: TestDatabase;
  let fakeRazorpay: FakeRazorpayServer;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let appBaseUrl = "";

  beforeAll(async () => {
    testDb = await createTestDb("worker_rzp");
    db = createPool(testDb.connectionString);
    await migrate(db);

    fakeRazorpay = new FakeRazorpayServer();
    const rzpUrl = await fakeRazorpay.start();

    const provider = providerFromEnv({
      PAYMENT_PROVIDER: "razorpay",
      RAZORPAY_KEY_ID: "rzp_test_worker_id",
      RAZORPAY_KEY_SECRET: "rzp_test_worker_secret",
      RAZORPAY_WEBHOOK_SECRET: fakeRazorpay.webhookSecret,
      MONEYINV_RAZORPAY_API_BASE: rzpUrl,
    });

    app = createApp(db, provider);
    await app.start();

    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    appBaseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.stop();
    await fakeRazorpay?.stop();
    await db?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    fakeRazorpay.reset();
    await db.query(
      "TRUNCATE jobs, ledger_entries, allocations, refunds, refund_requests, payments, order_lines, orders RESTART IDENTITY CASCADE",
    );
  });

  async function drainQueue(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const pending = (await db.query("SELECT count(*)::int AS c FROM jobs WHERE state IN ('queued', 'running')")).rows[0].c;
      if (pending === 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

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
    const rzpOrderId = String(coRes.body.payment_ref);

    const pay = fakeRazorpay.simulateCustomerPayment(rzpOrderId, "captured");

    const event = fakeRazorpay.createPaymentCapturedWebhook(pay);
    await httpPost(appBaseUrl, "/webhooks/razorpay", event.payload, event.headers);
    await drainQueue();

    return { orderId, lineIds, rzpOrderId, pay };
  }

  it("validates Razorpay INR refund minimum before reserving line capacity", async () => {
    const { orderId, lineIds } = await createPaidRazorpayOrder();
    const lineA = lineIds[0];

    // Amounts below 100 minor units rejected
    for (const invalidAmount of [1, 20, 99]) {
      const res = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
        line_id: lineA,
        amount: invalidAmount,
      });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain("minimum Razorpay INR refund is 100 minor units");
    }

    // No reservations in db
    const count = (await db.query("SELECT count(*)::int AS c FROM refund_requests")).rows[0].c;
    expect(count).toBe(0);

    // Exact 100 succeeds
    const validRes = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineA,
      amount: 100,
    });
    expect(validRes.status).toBe(200);
    expect(validRes.body.status).toBe("succeeded");
  });

  it("asynchronously processes Razorpay payment webhook notice, verifies signatures, and balances ledger", async () => {
    const oRes = await httpPost(appBaseUrl, "/orders", {
      currency: "INR",
      lines: [
        { seller_id: "seller_a", amount: 2000 },
        { seller_id: "seller_b", amount: 1000 },
      ],
    });
    const orderId = String(oRes.body.id);

    const coRes = await httpPost(appBaseUrl, `/orders/${orderId}/checkout`, {});
    const rzpOrderId = String(coRes.body.payment_ref);

    const pay = fakeRazorpay.simulateCustomerPayment(rzpOrderId, "captured");

    // Send webhook with invalid signature -> 400
    const badRes = await httpPost(appBaseUrl, "/webhooks/razorpay", JSON.stringify({ event: "payment.captured" }), {
      "x-razorpay-signature": "bogus_signature",
    });
    expect(badRes.status).toBe(400);

    // Send webhook with valid signature -> 200
    const event = fakeRazorpay.createPaymentCapturedWebhook(pay);
    const okRes = await httpPost(appBaseUrl, "/webhooks/razorpay", event.payload, event.headers);
    expect(okRes.status).toBe(200);

    await drainQueue();

    // Verify order paid
    const orderRow = (await db.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderRow.status).toBe("paid");

    // Verify ledger balance
    expect(await getLedgerTotal(db)).toBe(0n);
    expect(await areAllLedgerTransactionsBalanced(db)).toBe(true);

    const clearing = await getLedgerAccountBalance(db, "provider:clearing");
    expect(clearing).toBe(3000n);

    // Seller a: 2000 - 200 = 1800
    const sellerA = await getLedgerAccountBalance(db, "seller:seller_a");
    expect(sellerA).toBe(-1800n);

    // Seller b: 1000 - 100 = 900
    const sellerB = await getLedgerAccountBalance(db, "seller:seller_b");
    expect(sellerB).toBe(-900n);

    // Platform commission: 300
    const commission = await getLedgerAccountBalance(db, "platform:commission");
    expect(commission).toBe(-300n);
  });

  it("sends Razorpay refunds with X-Refund-Idempotency header and releases reservation on definitive rejection", async () => {
    const { orderId, lineIds, pay } = await createPaidRazorpayOrder();
    const lineA = lineIds[0];

    // Successful refund of 300
    const refRes = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineA,
      amount: 300,
    });
    expect(refRes.status).toBe(200);

    const refundCall = fakeRazorpay.calls.find((c) => c.path === `/v1/payments/${pay.id}/refund`);
    expect(refundCall).toBeDefined();
    expect(refundCall?.headers["x-refund-idempotency"]).toBeDefined();

    // Verify order status
    let orderRow = (await db.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderRow.status).toBe("partially_refunded");

    // Injected definitive rejection for amount too large (400)
    fakeRazorpay.onRequestHook = (req, res, _body) => {
      if (req.method === "POST" && req.url?.includes("/refund")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "BAD_REQUEST_ERROR",
              description: "The refund amount provided is greater than amount captured.",
              reason: "input_validation_failed",
            },
          }),
        );
        return true;
      }
      return false;
    };

    const rejectedRes = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineA,
      amount: 500,
    });
    expect(rejectedRes.status).toBe(409); // rejected by provider

    fakeRazorpay.onRequestHook = undefined;

    // Check request marked rejected
    const reqRow = (await db.query("SELECT * FROM refund_requests WHERE amount=500 AND order_id=$1", [orderId])).rows[0];
    expect(reqRow.state).toBe("rejected");

    // Capacity on line A (1000 - 300 = 700 available) is unreserved and usable
    const retryRes = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineA,
      amount: 700,
    });
    expect(retryRes.status).toBe(200);

    orderRow = (await db.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderRow.status).toBe("partially_refunded"); // Line B (600) still unrefunded

    expect(await getLedgerTotal(db)).toBe(0n);
    expect(await areAllLedgerTransactionsBalanced(db)).toBe(true);
    expect(await getLedgerAccountBalance(db, "provider:clearing")).toBe(600n); // 1600 - 300 - 700 = 600
  });
});
