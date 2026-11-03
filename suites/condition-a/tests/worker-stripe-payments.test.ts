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

describe.skipIf(!pgUp)("Worker Marketplace - Stripe Payment Processing & Job Queue", () => {
  let testDb: TestDatabase;
  let fakeStripe: FakeStripeServer;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let appBaseUrl = "";

  beforeAll(async () => {
    testDb = await createTestDb("worker_stripe_pay");
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

  it("validates line count, currencies and sellers during order creation", async () => {
    const resNoLines = await httpPost(appBaseUrl, "/orders", { lines: [] });
    expect(resNoLines.status).toBe(400);

    const resUnknownSeller = await httpPost(appBaseUrl, "/orders", {
      lines: [{ seller_id: "nonexistent_seller", amount: 1000 }],
    });
    expect(resUnknownSeller.status).toBe(400);

    const resNegative = await httpPost(appBaseUrl, "/orders", {
      lines: [{ seller_id: "seller_a", amount: -100 }],
    });
    expect(resNegative.status).toBe(400);

    const resValid = await httpPost(appBaseUrl, "/orders", {
      currency: "INR",
      lines: [
        { seller_id: "seller_a", amount: 1000 },
        { seller_id: "seller_b", amount: 500 },
      ],
    });
    expect(resValid.status).toBe(201);
    expect(resValid.body.total).toBe("1500");
  });

  it("completes checkout, enqueues webhook notice, and asynchronously reconciles payment with balanced ledger", async () => {
    const oRes = await httpPost(appBaseUrl, "/orders", {
      currency: "INR",
      lines: [
        { seller_id: "seller_a", amount: 1000 },
        { seller_id: "seller_b", amount: 600 },
      ],
    });
    const orderId = String(oRes.body.id);

    const coRes = await httpPost(appBaseUrl, `/orders/${orderId}/checkout`, {});
    expect(coRes.status).toBe(200);
    const piId = String(coRes.body.payment_ref);

    // Customer pays
    fakeStripe.markPaid(piId);

    // Webhook POST arrives: returns 200 immediately
    const event = fakeStripe.createPaymentIntentSucceededEvent(piId);
    const whRes = await httpPost(appBaseUrl, "/webhooks/stripe", event.payload, event.headers);
    expect(whRes.status).toBe(200);
    expect(whRes.body.received).toBe(true);

    // Wait for worker queue to process job
    await drainQueue();

    // Verify order marked paid
    const orderRow = (await db.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderRow.status).toBe("paid");

    // Verify payment record
    const payRow = (await db.query("SELECT * FROM payments WHERE provider_ref=$1", [piId])).rows[0];
    expect(payRow.status).toBe("succeeded");
    expect(payRow.amount_captured).toBe(1600n);

    // Verify ledger: debit-positive, balanced
    expect(await getLedgerTotal(db)).toBe(0n);
    expect(await areAllLedgerTransactionsBalanced(db)).toBe(true);

    const clearing = await getLedgerAccountBalance(db, "provider:clearing");
    expect(clearing).toBe(1600n);

    // Seller a: 1000 - 100 = 900
    const sellerA = await getLedgerAccountBalance(db, "seller:seller_a");
    expect(sellerA).toBe(-900n);

    // Seller b: 600 - 60 = 540
    const sellerB = await getLedgerAccountBalance(db, "seller:seller_b");
    expect(sellerB).toBe(-540n);

    // Platform commission: 160
    const commission = await getLedgerAccountBalance(db, "platform:commission");
    expect(commission).toBe(-160n);

    // Allocations recorded
    const allocCount = (await db.query("SELECT count(*)::int AS c FROM allocations WHERE order_id=$1", [orderId])).rows[0].c;
    expect(allocCount).toBe(2);
  });

  it("deduplicates redundant webhooks via provider_event_id without duplicate processing or ledger postings", async () => {
    const oRes = await httpPost(appBaseUrl, "/orders", {
      lines: [{ seller_id: "seller_a", amount: 1200 }],
    });
    const orderId = String(oRes.body.id);
    const coRes = await httpPost(appBaseUrl, `/orders/${orderId}/checkout`, {});
    const piId = String(coRes.body.payment_ref);

    fakeStripe.markPaid(piId);
    const event = fakeStripe.createPaymentIntentSucceededEvent(piId, "evt_unique_100");

    // Send webhook twice with same event ID
    const res1 = await httpPost(appBaseUrl, "/webhooks/stripe", event.payload, event.headers);
    const res2 = await httpPost(appBaseUrl, "/webhooks/stripe", event.payload, event.headers);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    await drainQueue();

    // Jobs table has exactly 1 job for this event
    const jobRows = (await db.query("SELECT count(*)::int AS c FROM jobs WHERE provider_event_id='stripe:evt_unique_100'")).rows[0].c;
    expect(jobRows).toBe(1);

    // Ledger has exactly 1 sale entry
    const entryCount = (await db.query("SELECT count(*)::int AS c FROM ledger_entries WHERE kind='sale' AND account='provider:clearing'")).rows[0].c;
    expect(entryCount).toBe(1);
  });

  it("routes mismatched or unexpected payment amounts to platform:unallocated_receipts suspense account", async () => {
    const oRes = await httpPost(appBaseUrl, "/orders", {
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = String(oRes.body.id);

    // Directly apply a payment that does not match the order total (e.g. 1500 instead of 1000)
    await app.shop.applyPayment({
      ref: "pi_mismatched_amount",
      status: "succeeded",
      amount: 1500n,
      amountCaptured: 1500n,
      currency: "INR",
      orderId,
      clientSecret: null,
    });

    // Ledger must be balanced
    expect(await getLedgerTotal(db)).toBe(0n);
    expect(await areAllLedgerTransactionsBalanced(db)).toBe(true);

    // Must be booked to platform:unallocated_receipts
    const suspense = await getLedgerAccountBalance(db, "platform:unallocated_receipts");
    expect(suspense).toBe(-1500n);

    // Clearing balance is +1500
    const clearing = await getLedgerAccountBalance(db, "provider:clearing");
    expect(clearing).toBe(1500n);

    // Seller A must NOT have received false money!
    const sellerA = await getLedgerAccountBalance(db, "seller:seller_a");
    expect(sellerA).toBe(0n);
  });

  it("handles manual capture flow and merchant capture API", async () => {
    const oRes = await httpPost(appBaseUrl, "/orders", {
      capture: "manual",
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = String(oRes.body.id);

    const coRes = await httpPost(appBaseUrl, `/orders/${orderId}/checkout`, {});
    const piId = String(coRes.body.payment_ref);

    fakeStripe.markAuthorized(piId);

    // Observation webhook
    const event = {
      id: "evt_manual_obs",
      object: "event",
      type: "payment_intent.amount_capturable_updated",
      data: { object: fakeStripe.payments.get(piId) },
    };
    const payload = JSON.stringify(event);
    await httpPost(appBaseUrl, "/webhooks/stripe", payload, {
      "stripe-signature": fakeStripe.constructWebhookHeader(payload),
    });
    await drainQueue();

    // Order should be authorized, no ledger entries yet
    const orderRow1 = (await db.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderRow1.status).toBe("authorized");
    expect((await db.query("SELECT count(*)::int AS c FROM ledger_entries")).rows[0].c).toBe(0);

    // Merchant calls capture
    const capRes = await httpPost(appBaseUrl, `/orders/${orderId}/capture`, {});
    expect(capRes.status).toBe(200);

    const orderRow2 = (await db.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
    expect(orderRow2.status).toBe("paid");

    expect(await getLedgerAccountBalance(db, "provider:clearing")).toBe(1000n);
    expect(await getLedgerTotal(db)).toBe(0n);
  });

  it("recovers running jobs left behind by a simulated crash on startup", async () => {
    await db.query(
      "INSERT INTO jobs (provider_event_id, type, payload, state) VALUES ('stripe:evt_crashed', 'payment', '{\"ref\":\"pi_crash\"}', 'running')",
    );

    const recovered = await app.worker.recover();
    expect(recovered).toBe(1);

    const jobRow = (await db.query("SELECT state FROM jobs WHERE provider_event_id='stripe:evt_crashed'")).rows[0];
    expect(jobRow.state).toBe("queued");
  });
});
