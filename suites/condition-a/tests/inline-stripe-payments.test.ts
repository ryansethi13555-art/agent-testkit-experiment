import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { areAllLedgerTransactionsBalanced, getLedgerAccountBalance, getLedgerTotal, httpGet, httpPost } from "./helpers/apps.ts";
import { createTestDb, isPgUp, type TestDatabase } from "./helpers/db.ts";
import { FakeStripeServer } from "./helpers/fake-stripe.ts";

const pgUp = await isPgUp();

describe.skipIf(!pgUp)("Inline Marketplace - Stripe Payment Flows & Idempotency", () => {
  let testDb: TestDatabase;
  let fakeStripe: FakeStripeServer;
  let app: typeof import("../inline-marketplace/src/server.ts");
  let appBaseUrl = "";
  let dbClient: pg.Client;

  beforeAll(async () => {
    testDb = await createTestDb("inline_stripe_pay");
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

  it("validates order inputs rejecting non-positive lines, invalid currencies and empty orders", async () => {
    const resEmpty = await httpPost(appBaseUrl, "/orders", { lines: [] });
    expect(resEmpty.status).toBe(400);

    const resNonNumeric = await httpPost(appBaseUrl, "/orders", {
      lines: [{ seller_id: "seller_a", amount: "abc" }],
    });
    expect(resNonNumeric.status).toBe(400);

    const resZeroAmount = await httpPost(appBaseUrl, "/orders", {
      lines: [{ seller_id: "seller_a", amount: 0 }],
    });
    expect(resZeroAmount.status).toBe(400);

    const resNegativeAmount = await httpPost(appBaseUrl, "/orders", {
      lines: [{ seller_id: "seller_a", amount: -500 }],
    });
    expect(resNegativeAmount.status).toBe(400);

    const resBadCurrency = await httpPost(appBaseUrl, "/orders", {
      currency: "toolong",
      lines: [{ seller_id: "seller_a", amount: 500 }],
    });
    expect(resBadCurrency.status).toBe(400);
  });

  it("creates order and guarantees checkout idempotency sequentially and under high concurrency", async () => {
    const orderRes = await httpPost(appBaseUrl, "/orders", {
      buyer: "buyer_test",
      currency: "INR",
      lines: [
        { seller_id: "seller_a", amount: 1000 },
        { seller_id: "seller_b", amount: 500 },
      ],
    });
    expect(orderRes.status).toBe(201);
    const orderId = String(orderRes.body.id);
    expect(orderRes.body.total).toBe("1500");

    // Concurrent checkouts
    const checkoutPromises = Array.from({ length: 12 }, () =>
      httpPost(appBaseUrl, `/orders/${orderId}/checkout`, {}),
    );
    const results = await Promise.all(checkoutPromises);

    // All should succeed with status 200 (or 502 if competing during in-flight, but first and subsequent succeed)
    const successful = results.filter((r) => r.status === 200);
    expect(successful.length).toBeGreaterThanOrEqual(1);

    const piId = String(successful[0].body.payment_intent_id);
    expect(piId).toMatch(/^pi_fake_/);

    for (const s of successful) {
      expect(s.body.payment_intent_id).toBe(piId);
    }

    // Provider should have only ONE payment intent created for this order
    const createdPis = [...fakeStripe.payments.values()].filter((p) => p.metadata.order_id === orderId);
    expect(createdPis.length).toBe(1);
    expect(createdPis[0].amount).toBe(1500);

    // Subsequent sequential checkout returns the exact same payment intent
    const nextCheckout = await httpPost(appBaseUrl, `/orders/${orderId}/checkout`, {});
    expect(nextCheckout.status).toBe(200);
    expect(nextCheckout.body.payment_intent_id).toBe(piId);
  });

  it("records checkout_create_started marker and prevents duplicate provider payments when initial outcome is unknown", async () => {
    const orderRes = await httpPost(appBaseUrl, "/orders", {
      lines: [{ seller_id: "seller_a", amount: 750 }],
    });
    const orderId = String(orderRes.body.id);

    // Injected network failure during create
    fakeStripe.onRequestHook = (_req, res, _body) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Simulated Stripe internal server error" } }));
      return true;
    };

    const failedCheckout = await httpPost(appBaseUrl, `/orders/${orderId}/checkout`, {});
    expect(failedCheckout.status).toBe(502);

    fakeStripe.onRequestHook = undefined;

    // Retry checkout - must NOT create another PaymentIntent; must wait for provider observation
    const retryCheckout = await httpPost(appBaseUrl, `/orders/${orderId}/checkout`, {});
    expect(retryCheckout.status).toBe(502);
    expect(String(retryCheckout.body.error)).toContain("checkout create outcome unknown");

    // Only 0 or 1 attempt made, no second payment intent
    const pis = [...fakeStripe.payments.values()].filter((p) => p.metadata.order_id === orderId);
    expect(pis.length).toBe(0);
  });

  it("handles payment_intent.succeeded webhook, books double-entry ledger with 10% commission, and dedupes retries", async () => {
    // Asha: 1000 INR -> fee: 100, seller: 900
    // Bharat: 555 INR -> fee: 55.5 -> round half-even: 56, seller: 499
    const orderRes = await httpPost(appBaseUrl, "/orders", {
      currency: "INR",
      lines: [
        { seller_id: "seller_a", amount: 1000 },
        { seller_id: "seller_b", amount: 555 },
      ],
    });
    const orderId = String(orderRes.body.id);

    const checkoutRes = await httpPost(appBaseUrl, `/orders/${orderId}/checkout`, {});
    const piId = String(checkoutRes.body.payment_intent_id);

    const event = fakeStripe.createPaymentIntentSucceededEvent(piId);

    // Webhook delivery
    const whRes1 = await httpPost(appBaseUrl, "/webhooks/stripe", event.payload, event.headers);
    expect(whRes1.status).toBe(200);

    // Check order status
    const orderDb = (await dbClient.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderDb.status).toBe("paid");

    // Ledger checks:
    // Total ledger must be 0
    expect(await getLedgerTotal(dbClient)).toBe(0n);
    expect(await areAllLedgerTransactionsBalanced(dbClient)).toBe(true);

    // provider:clearing must be +1555
    const clearing = await getLedgerAccountBalance(dbClient, "provider:clearing");
    expect(clearing).toBe(1555n);

    // seller_a: -900
    const sellerA = await getLedgerAccountBalance(dbClient, "seller:seller_a");
    expect(sellerA).toBe(-900n);

    // seller_b: -499 (555 - 56)
    const sellerB = await getLedgerAccountBalance(dbClient, "seller:seller_b");
    expect(sellerB).toBe(-499n);

    // commissions:
    // line 1 fee = 100
    const fee1 = await getLedgerAccountBalance(dbClient, `platform:revenue:${orderId}_l1`);
    expect(fee1).toBe(-100n);
    // line 2 fee = 56
    const fee2 = await getLedgerAccountBalance(dbClient, `platform:revenue:${orderId}_l2`);
    expect(fee2).toBe(-56n);

    // Exact duplicate delivery
    const whRes2 = await httpPost(appBaseUrl, "/webhooks/stripe", event.payload, event.headers);
    expect(whRes2.status).toBe(200);

    // Ledger count must NOT increase
    const entryCount = (await dbClient.query("SELECT count(*)::int AS c FROM ledger_entries")).rows[0].c;
    expect(entryCount).toBe(5); // 1 clearing + 2 sellers + 2 commissions
  });

  it("rejects tampered webhook payloads with invalid signature", async () => {
    const orderRes = await httpPost(appBaseUrl, "/orders", {
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = String(orderRes.body.id);
    const co = await httpPost(appBaseUrl, `/orders/${orderId}/checkout`, {});
    const piId = String(co.body.payment_intent_id);

    const event = fakeStripe.createPaymentIntentSucceededEvent(piId);

    // Tampered payload with valid header of old payload
    const badRes = await httpPost(appBaseUrl, "/webhooks/stripe", '{"tampered": true}', event.headers);
    expect(badRes.status).toBe(400);

    const orderDb = (await dbClient.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderDb.status).toBe("pending_payment");
  });

  it("handles manual capture orders properly, requiring capture call to mark paid and book money", async () => {
    const orderRes = await httpPost(appBaseUrl, "/orders", {
      capture: "manual",
      lines: [{ seller_id: "seller_a", amount: 1200 }],
    });
    const orderId = String(orderRes.body.id);

    const checkoutRes = await httpPost(appBaseUrl, `/orders/${orderId}/checkout`, {});
    expect(checkoutRes.status).toBe(200);
    const piId = String(checkoutRes.body.payment_intent_id);

    // Provider has payment intent in requires_capture
    fakeStripe.markAuthorized(piId);

    // Observation webhook arrives (payment_intent.amount_capturable_updated or created)
    const obsEvent = {
      id: "evt_obs_1",
      object: "event",
      type: "payment_intent.amount_capturable_updated",
      data: { object: fakeStripe.payments.get(piId) },
    };
    const obsPayload = JSON.stringify(obsEvent);
    const obsRes = await httpPost(appBaseUrl, "/webhooks/stripe", obsPayload, {
      "stripe-signature": fakeStripe.constructWebhookHeader(obsPayload),
    });
    expect(obsRes.status).toBe(200);

    // Order still pending_payment or capture_pending, ledger empty
    let orderDb = (await dbClient.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(["pending_payment", "capture_pending"]).toContain(orderDb.status);
    expect(await getLedgerTotal(dbClient)).toBe(0n);
    const entriesCount = (await dbClient.query("SELECT count(*)::int AS c FROM ledger_entries")).rows[0].c;
    expect(entriesCount).toBe(0);

    // Merchant captures order
    const capRes = await httpPost(appBaseUrl, `/orders/${orderId}/capture`, {});
    expect(capRes.status).toBe(200);
    expect(capRes.body.status).toBe("paid");

    orderDb = (await dbClient.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderDb.status).toBe("paid");

    // Now ledger is booked
    expect(await getLedgerTotal(dbClient)).toBe(0n);
    const clearing = await getLedgerAccountBalance(dbClient, "provider:clearing");
    expect(clearing).toBe(1200n);
    const seller = await getLedgerAccountBalance(dbClient, "seller:seller_a");
    expect(seller).toBe(-1080n); // 1200 - 120 fee
  });

  it("handles confirm return endpoint and concurrent webhook without duplicate sales", async () => {
    const orderRes = await httpPost(appBaseUrl, "/orders", {
      lines: [{ seller_id: "seller_b", amount: 2000 }],
    });
    const orderId = String(orderRes.body.id);

    const checkoutRes = await httpPost(appBaseUrl, `/orders/${orderId}/checkout`, {});
    const piId = String(checkoutRes.body.payment_intent_id);

    fakeStripe.markPaid(piId);
    const event = fakeStripe.createPaymentIntentSucceededEvent(piId);

    // Confirm and webhook race
    const [confirmRes, whRes] = await Promise.all([
      httpPost(appBaseUrl, `/orders/${orderId}/confirm`, {}),
      httpPost(appBaseUrl, "/webhooks/stripe", event.payload, event.headers),
    ]);

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.status).toBe("paid");
    expect(whRes.status).toBe(200);

    // Ledger should have exactly one sale posted
    const saleEntries = (await dbClient.query("SELECT count(*)::int AS c FROM ledger_entries WHERE kind='sale'")).rows[0].c;
    expect(saleEntries).toBe(2); // 1 clearing + 1 seller
    expect(await getLedgerTotal(dbClient)).toBe(0n);
  });
});
