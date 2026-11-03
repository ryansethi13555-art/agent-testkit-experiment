import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { areAllLedgerTransactionsBalanced, getLedgerAccountBalance, getLedgerTotal, httpPost } from "./helpers/apps.ts";
import { createTestDb, isPgUp, type TestDatabase } from "./helpers/db.ts";
import { FakeStripeServer } from "./helpers/fake-stripe.ts";

const pgUp = await isPgUp();

describe.skipIf(!pgUp)("Inline Marketplace - Stripe Refund Flows & Edge Cases", () => {
  let testDb: TestDatabase;
  let fakeStripe: FakeStripeServer;
  let app: typeof import("../inline-marketplace/src/server.ts");
  let appBaseUrl = "";
  let dbClient: pg.Client;

  beforeAll(async () => {
    testDb = await createTestDb("inline_stripe_ref");
    dbClient = await testDb.createClient();

    fakeStripe = new FakeStripeServer();
    const stripeUrl = await fakeStripe.start();

    process.env.DATABASE_URL = testDb.connectionString;
    process.env.PAYMENT_PROVIDER = "stripe";
    process.env.STRIPE_SECRET_KEY = "sk_test_fake_key";
    process.env.STRIPE_WEBHOOK_SECRET = fakeStripe.webhookSecret;
    process.env.MONEYINV_STRIPE_API_BASE = stripeUrl;

    app = await import("../inline-marketplace/src/server.ts");
    await app.migrate();

    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    appBaseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.stop();
    await fakeStripe?.stop();
    await dbClient?.end().catch(() => {});
    await testDb?.drop();
  });

  beforeEach(async () => {
    fakeStripe.reset();
    await dbClient.query("TRUNCATE orders, order_lines, refunds, refund_requests, ledger_entries, processed_events CASCADE");
  });

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
    const piId = String(coRes.body.payment_intent_id);

    const event = fakeStripe.createPaymentIntentSucceededEvent(piId);
    await httpPost(appBaseUrl, "/webhooks/stripe", event.payload, event.headers);

    return { orderId, lineIds, piId };
  }

  it("handles partial refunds, adjusts ledger balances, and rejects refunds exceeding line or order capacity", async () => {
    const { orderId, lineIds } = await createPaidOrder();
    const lineA = lineIds[0]; // 1000 INR
    const lineB = lineIds[1]; // 500 INR

    // 1. Refund 300 on line A
    const refRes1 = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineA,
      amount: 300,
    });
    expect(refRes1.status).toBe(200);

    let orderRow = (await dbClient.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderRow.status).toBe("partially_refunded");

    // Ledger checks:
    expect(await areAllLedgerTransactionsBalanced(dbClient)).toBe(true);
    // clearing originally was 1500; refund reduces clearing by 300 -> 1200
    const clearing = await getLedgerAccountBalance(dbClient, "provider:clearing");
    expect(clearing).toBe(1200n);
    // seller A debited by 300 (seller A was originally -900, + 300 = -600)
    const sellerA = await getLedgerAccountBalance(dbClient, "seller:seller_a");
    expect(sellerA).toBe(-600n);

    // 2. Try refunding 701 on line A (only 700 remains) -> 400
    const overLineRes = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineA,
      amount: 701,
    });
    expect(overLineRes.status).toBe(400);
    expect(String(overLineRes.body.error)).toContain("exceeds refundable for this line");

    // 3. Refund exact remaining 700 on line A
    const refRes2 = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineA,
      amount: 700,
    });
    expect(refRes2.status).toBe(200);

    // 4. Refund remaining 500 on line B -> fully refunded
    const refRes3 = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineB,
      amount: 500,
    });
    expect(refRes3.status).toBe(200);

    orderRow = (await dbClient.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderRow.status).toBe("refunded");

    // All money refunded from clearing:
    expect(await getLedgerAccountBalance(dbClient, "provider:clearing")).toBe(0n);
    expect(await areAllLedgerTransactionsBalanced(dbClient)).toBe(true);

    // 5. Subsequent refund attempt on fully refunded order is rejected with 409
    const rejectedOver = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineA,
      amount: 100,
    });
    expect(rejectedOver.status).toBe(409);
  });

  it("prevents double-refunding when concurrent requests race to consume the same line headroom", async () => {
    const { orderId, lineIds } = await createPaidOrder();
    const lineB = lineIds[1]; // 500 INR capacity

    // 3 concurrent refund requests of 300 INR each (total 900 INR > 500 INR capacity)
    const promises = Array.from({ length: 3 }, () =>
      httpPost(appBaseUrl, `/orders/${orderId}/refunds`, { line_id: lineB, amount: 300 }),
    );
    const results = await Promise.all(promises);

    const statuses = results.map((r) => r.status).sort();
    // Exactly one 200, other two 400
    expect(statuses).toEqual([200, 400, 400]);

    // Headroom check in db
    const refundedOnLineB = (
      await dbClient.query("SELECT coalesce(sum(amount), 0)::bigint AS s FROM refunds WHERE line_id=$1 AND status<>'failed'", [lineB])
    ).rows[0].s;
    expect(refundedOnLineB).toBe(300n);
  });

  it("maintains line reservation when provider call fails with ambiguous error, preventing over-refunds", async () => {
    const { orderId, lineIds } = await createPaidOrder();
    const lineA = lineIds[0]; // 1000 INR

    // Injected transient network error
    fakeStripe.onRequestHook = (req, res, _body) => {
      if (req.url === "/v1/refunds" && req.method === "POST") {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Bad Gateway to bank" } }));
        return true;
      }
      return false;
    };

    // Attempt refund of 600 INR
    const failedRes = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineA,
      amount: 600,
    });
    expect(failedRes.status).toBe(502);

    fakeStripe.onRequestHook = undefined;

    // Check refund_requests table: reservation exists and is unresolved
    const reqRow = (await dbClient.query("SELECT * FROM refund_requests WHERE order_id=$1", [orderId])).rows[0];
    expect(reqRow.resolved).toBe(false);
    expect(reqRow.amount).toBe(600n);

    // Now try to refund 500 on line A (which has 1000 total, 600 reserved => only 400 available)
    const blockedRes = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineA,
      amount: 500,
    });
    expect(blockedRes.status).toBe(400);
    expect(String(blockedRes.body.error)).toContain("exceeds refundable for this line");

    // But 400 should succeed!
    const allowedRes = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineA,
      amount: 400,
    });
    expect(allowedRes.status).toBe(200);
  });

  it("releases reservation when refund is definitively rejected by provider (e.g. rate limit or amount too large)", async () => {
    const { orderId, lineIds } = await createPaidOrder();
    const lineA = lineIds[0]; // 1000 INR

    // Provider rejects with 400 amount_too_large (definitive rejection)
    fakeStripe.onRequestHook = (req, res, _body) => {
      if (req.url === "/v1/refunds" && req.method === "POST") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              type: "StripeInvalidRequestError",
              code: "amount_too_large",
              statusCode: 400,
              message: "Amount too large",
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
    expect(rejectedRes.status).toBe(409); // DefinitiveRefundRejection throws 409

    fakeStripe.onRequestHook = undefined;

    // Reservation in DB should be marked resolved='rejected'
    const reqRow = (await dbClient.query("SELECT * FROM refund_requests WHERE order_id=$1", [orderId])).rows[0];
    expect(reqRow.resolved).toBe(true);
    expect(reqRow.resolution).toBe("rejected");
    expect(reqRow.rejection_reason).toBe("amount_too_large");

    // Full 1000 capacity on line A is available again!
    const retryRes = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineA,
      amount: 1000,
    });
    expect(retryRes.status).toBe(200);
  });

  it("processes provider dashboard refunds, booking to unallocated refunds account without breaking double-entry balance", async () => {
    const { orderId, piId } = await createPaidOrder();

    // Create refund directly in fake Stripe
    fakeStripe.refunds.set("re_dash_ext", {
      id: "re_dash_ext",
      object: "refund",
      amount: 250,
      currency: "inr",
      status: "succeeded",
      payment_intent: piId,
      metadata: {},
    });

    const whEvent = fakeStripe.createRefundEvent("re_dash_ext", "refund.created", "evt_dash_1");
    const whRes = await httpPost(appBaseUrl, "/webhooks/stripe", whEvent.payload, whEvent.headers);
    expect(whRes.status).toBe(200);

    const refRow = (await dbClient.query("SELECT * FROM refunds WHERE provider_ref='re_dash_ext'")).rows[0];
    expect(refRow.origin).toBe("provider");
    expect(refRow.line_id).toBeNull();
    expect(refRow.amount).toBe(250n);

    // Ledger balance check
    expect(await getLedgerTotal(dbClient)).toBe(0n);
    expect(await areAllLedgerTransactionsBalanced(dbClient)).toBe(true);

    const unallocated = await getLedgerAccountBalance(dbClient, "platform:unallocated_refunds");
    expect(unallocated).toBe(250n);

    const clearing = await getLedgerAccountBalance(dbClient, "provider:clearing");
    expect(clearing).toBe(1250n); // 1500 - 250
  });

  it("handles refund failure and reversal, ensuring accurate ledger restoration and idempotency", async () => {
    const { orderId, lineIds } = await createPaidOrder();
    const lineA = lineIds[0];

    // Issue refund of 400
    const refRes = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineA,
      amount: 400,
    });
    expect(refRes.status).toBe(200);
    const refId = String(refRes.body.provider_refund_id);

    // Order is partially_refunded, clearing is 1100
    expect((await dbClient.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0].status).toBe("partially_refunded");
    expect(await getLedgerAccountBalance(dbClient, "provider:clearing")).toBe(1100n);

    // Provider reports refund failed
    const rObj = fakeStripe.refunds.get(refId)!;
    rObj.status = "failed";

    const failEvent = fakeStripe.createRefundEvent(refId, "refund.failed", "evt_fail_1");
    const whFailRes1 = await httpPost(appBaseUrl, "/webhooks/stripe", failEvent.payload, failEvent.headers);
    expect(whFailRes1.status).toBe(200);

    // Order status should revert to paid!
    expect((await dbClient.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0].status).toBe("paid");
    expect((await dbClient.query("SELECT status FROM refunds WHERE provider_ref=$1", [refId])).rows[0].status).toBe("failed");

    // Clearing balance restored to full 1500!
    expect(await getLedgerAccountBalance(dbClient, "provider:clearing")).toBe(1500n);
    expect(await getLedgerTotal(dbClient)).toBe(0n);
    expect(await areAllLedgerTransactionsBalanced(dbClient)).toBe(true);

    // Redelivery of failure webhook
    const whFailRes2 = await httpPost(appBaseUrl, "/webhooks/stripe", failEvent.payload, failEvent.headers);
    expect(whFailRes2.status).toBe(200);
    expect(await getLedgerAccountBalance(dbClient, "provider:clearing")).toBe(1500n);

    // Line A headroom should be fully restored (can refund 1000 again)
    const reRefundRes = await httpPost(appBaseUrl, `/orders/${orderId}/refunds`, {
      line_id: lineA,
      amount: 1000,
    });
    expect(reRefundRes.status).toBe(200);
  });
});
