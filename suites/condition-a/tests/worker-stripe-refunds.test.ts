import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Db, migrate } from "../worker-marketplace/src/db.ts";
import { providerFromEnv } from "../worker-marketplace/src/provider.ts";
import { createApp } from "../worker-marketplace/src/server.ts";
import { areAllLedgerTransactionsBalanced, getLedgerAccountBalance, getLedgerTotal, httpPost } from "./helpers/apps.ts";
import { createTestDb, isPgUp, type TestDatabase } from "./helpers/db.ts";
import { FakeStripeServer } from "./helpers/fake-stripe.ts";

const pgUp = await isPgUp();

describe.skipIf(!pgUp)("Worker Marketplace - Stripe Refund Flows & Edge Cases", () => {
  let testDb: TestDatabase;
  let fakeStripe: FakeStripeServer;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let appBaseUrl = "";

  beforeAll(async () => {
    testDb = await createTestDb("worker_stripe_ref");
    db = createPool(testDb.connectionString);
    await migrate(db);

    fakeStripe = new FakeStripeServer();
    const stripeUrl = await fakeStripe.start();

    const provider = providerFromEnv({
      PAYMENT_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_test_fake_worker",
      STRIPE_WEBHOOK_SECRET: fakeStripe.webhookSecret,
      MONEYINV_STRIPE_API_BASE: stripeUrl,
    });

    app = createApp(db, provider);
    await app.start();

    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    appBaseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.stop();
    await fakeStripe?.stop();
    await db?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    fakeStripe.reset();
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

  async function createPaidOrder(
    lines = [
      { seller_id: "seller_a", amount: 1000 },
      { seller_id: "seller_b", amount: 500 },
    ],
  ) {
    const oRes = await httpPost(appBaseUrl, "/orders", { currency: "INR", lines });
    const orderId = String(oRes.body.id);
    const lineIds = oRes.body.lines as string[];

    const coRes = await httpPost(appBaseUrl, `/orders/${orderId}/checkout`, {});
    const piId = String(coRes.body.payment_ref);

    fakeStripe.markPaid(piId);
    const event = fakeStripe.createPaymentIntentSucceededEvent(piId);
    await httpPost(appBaseUrl, "/webhooks/stripe", event.payload, event.headers);
    await drainQueue();

    return { orderId, lineIds, piId };
  }

  it("refunds within line headroom and updates order status correctly", async () => {
    const { orderId, lineIds } = await createPaidOrder();
    const lineA = lineIds[0]; // 1000 INR

    // Refund 400 on line A
    const refRes1 = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineA,
      amount: 400,
    });
    expect(refRes1.status).toBe(200);
    expect(refRes1.body.status).toBe("succeeded");

    let orderRow = (await db.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderRow.status).toBe("partially_refunded");

    // Over-refund attempt (remaining 600, requesting 601)
    const overRes = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineA,
      amount: 601,
    });
    expect(overRes.status).toBe(400);
    expect(String(overRes.body.error)).toContain("exceeds what is refundable on this line");

    // Refund exact remaining 600
    const refRes2 = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineA,
      amount: 600,
    });
    expect(refRes2.status).toBe(200);

    // Ledger balance check
    expect(await getLedgerTotal(db)).toBe(0n);
    expect(await areAllLedgerTransactionsBalanced(db)).toBe(true);

    const clearing = await getLedgerAccountBalance(db, "provider:clearing");
    expect(clearing).toBe(500n); // 1500 - 1000 = 500 (line B remains)
  });

  it("handles lost response gracefully, keeping reservation to block over-refunds and reconciling without re-post", async () => {
    const { orderId, lineIds } = await createPaidOrder();
    const lineA = lineIds[0]; // 1000 INR

    // Injected network hangup
    fakeStripe.onRequestHook = (req, res, _body) => {
      if (req.url === "/v1/refunds" && req.method === "POST") {
        req.socket.destroy();
        return true;
      }
      return false;
    };

    const lostRes = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineA,
      amount: 700,
    });
    // Worker marketplace returns 202 processing for unknown outcome
    expect(lostRes.status).toBe(202);
    expect(lostRes.body.status).toBe("processing");
    const reqId = String(lostRes.body.request_id);

    fakeStripe.onRequestHook = undefined;

    // Check request state is unknown
    const reqRow = (await db.query("SELECT * FROM refund_requests WHERE id=$1", [reqId])).rows[0];
    expect(reqRow.state).toBe("unknown");

    // Capacity is reserved! Attempting to refund 400 on line A (1000 - 700 = 300) fails!
    const overRes = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineA,
      amount: 400,
    });
    expect(overRes.status).toBe(400);

    // Later, webhook notification arrives from Stripe for the refund
    // In fake Stripe, let's create the refund record that Stripe committed before socket died
    const stripeRefundId = "re_lost_reconciled";
    fakeStripe.refunds.set(stripeRefundId, {
      id: stripeRefundId,
      object: "refund",
      amount: 700,
      currency: "inr",
      status: "succeeded",
      payment_intent: (await db.query("SELECT payment_ref FROM orders WHERE id=$1", [orderId])).rows[0].payment_ref,
      metadata: {
        order_id: orderId,
        line_id: lineA,
        refund_request_id: reqId,
      },
    });

    const whEvent = fakeStripe.createRefundEvent(stripeRefundId, "refund.created", "evt_re_lost_1");
    const whRes = await httpPost(appBaseUrl, "/webhooks/stripe", whEvent.payload, whEvent.headers);
    expect(whRes.status).toBe(200);

    await drainQueue();

    // Now request state is 'sent'
    const updatedReqRow = (await db.query("SELECT * FROM refund_requests WHERE id=$1", [reqId])).rows[0];
    expect(updatedReqRow.state).toBe("sent");
    expect(updatedReqRow.provider_ref).toBe(stripeRefundId);

    // Ledger posted
    expect(await getLedgerTotal(db)).toBe(0n);
    expect(await areAllLedgerTransactionsBalanced(db)).toBe(true);
    expect(await getLedgerAccountBalance(db, "provider:clearing")).toBe(800n); // 1500 - 700
  });

  it("handles dashboard refunds arriving before payment webhook is processed", async () => {
    const oRes = await httpPost(appBaseUrl, "/orders", {
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = String(oRes.body.id);
    const coRes = await httpPost(appBaseUrl, `/orders/${orderId}/checkout`, {});
    const piId = String(coRes.body.payment_ref);

    fakeStripe.markPaid(piId);

    // Dashboard refund in Stripe before any payment webhook is sent to app
    const dashRefId = "re_early_dash";
    fakeStripe.refunds.set(dashRefId, {
      id: dashRefId,
      object: "refund",
      amount: 300,
      currency: "inr",
      status: "succeeded",
      payment_intent: piId,
      metadata: {},
    });

    const refEvent = fakeStripe.createRefundEvent(dashRefId, "refund.created", "evt_early_ref");
    const refRes = await httpPost(appBaseUrl, "/webhooks/stripe", refEvent.payload, refEvent.headers);
    expect(refRes.status).toBe(200);

    await drainQueue();

    // Verify order is partially_refunded and payment is captured
    const orderRow = (await db.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderRow.status).toBe("partially_refunded");

    const refundRow = (await db.query("SELECT * FROM refunds WHERE provider_ref=$1", [dashRefId])).rows[0];
    expect(refundRow.origin).toBe("provider");
    expect(refundRow.line_id).toBeNull();

    expect(await getLedgerTotal(db)).toBe(0n);
    expect(await areAllLedgerTransactionsBalanced(db)).toBe(true);

    const unallocated = await getLedgerAccountBalance(db, "platform:unallocated_refunds");
    expect(unallocated).toBe(300n);

    const clearing = await getLedgerAccountBalance(db, "provider:clearing");
    expect(clearing).toBe(700n); // 1000 - 300
  });

  it("reverses failed refunds and blocks illegal resurrection after reversal", async () => {
    const { orderId, lineIds } = await createPaidOrder();
    const lineA = lineIds[0];

    // Successful refund creation
    const refRes = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineA,
      amount: 500,
    });
    expect(refRes.status).toBe(200);
    const refId = String(refRes.body.provider_refund_id);

    // Now provider refund fails
    const rObj = fakeStripe.refunds.get(refId)!;
    rObj.status = "failed";

    const failEvent = fakeStripe.createRefundEvent(refId, "refund.failed", "evt_failed_worker");
    await httpPost(appBaseUrl, "/webhooks/stripe", failEvent.payload, failEvent.headers);
    await drainQueue();

    // Order status should be restored to paid
    const orderRow = (await db.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderRow.status).toBe("paid");

    const refundRow = (await db.query("SELECT status FROM refunds WHERE provider_ref=$1", [refId])).rows[0];
    expect(refundRow.status).toBe("failed");

    // Clearing balance restored to full 1500
    expect(await getLedgerAccountBalance(db, "provider:clearing")).toBe(1500n);
    expect(await getLedgerTotal(db)).toBe(0n);
    expect(await areAllLedgerTransactionsBalanced(db)).toBe(true);

    // Attempt to resurrect refund (provider reporting succeeded after reversal) throws ProviderError
    rObj.status = "succeeded";
    await expect(app.shop.onRefundJob(refId)).rejects.toThrow(/after its reversal/);
  });
});
