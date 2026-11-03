import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Db, migrate } from "../worker-marketplace/src/db.ts";
import { providerFromEnv } from "../worker-marketplace/src/provider.ts";
import { createApp } from "../worker-marketplace/src/server.ts";
import {
  assertAllMoneyLaws,
  assertLedgerBalanced,
  assertEffectOnce,
  assertAllocationsSumToWhole,
  assertAllocationsMatchOrder,
  assertOrderPaidIffCaptured,
} from "./helpers/assertions.ts";
import { MockStripeServer } from "./helpers/mock-stripe.ts";

const ADMIN = process.env.MI_PG_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const DB = `test_worker_wh_${process.pid}`;

let fakeStripe: MockStripeServer;
let db: Db;
let app: ReturnType<typeof createApp>;
let base = "";

async function post(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

async function sendWebhook(type: string, dataObject: unknown, eventId?: string, overrideHeader?: string) {
  const evt = fakeStripe.buildWebhookEvent(type, dataObject, eventId);
  const headers = overrideHeader !== undefined ? { "stripe-signature": overrideHeader } : evt.headers;
  return post("/webhooks/stripe", evt.payload, headers);
}

async function drainWorker() {
  while (await app.worker.runOnce()) {}
}

beforeAll(async () => {
  fakeStripe = new MockStripeServer();
  const stripeUrl = await fakeStripe.start();

  const adminClient = new pg.Client({ connectionString: ADMIN });
  await adminClient.connect();
  await adminClient.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await adminClient.query(`CREATE DATABASE ${DB}`);
  await adminClient.end();

  const databaseUrl = new URL(ADMIN);
  databaseUrl.pathname = `/${DB}`;
  db = createPool(databaseUrl.href);
  await migrate(db);

  const provider = providerFromEnv({
    PAYMENT_PROVIDER: "stripe",
    STRIPE_SECRET_KEY: "sk_test_mock",
    STRIPE_WEBHOOK_SECRET: fakeStripe.webhookSecret,
    MONEYINV_STRIPE_API_BASE: stripeUrl,
  });

  app = createApp(db, provider);
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (app) await app.stop().catch(() => {});
  if (db) await db.end().catch(() => {});
  if (fakeStripe) await fakeStripe.stop().catch(() => {});
  const adminClient = new pg.Client({ connectionString: ADMIN });
  await adminClient.connect();
  await adminClient.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await adminClient.end();
});

beforeEach(async () => {
  fakeStripe.reset();
  await db.query(
    "TRUNCATE jobs, ledger_entries, allocations, refunds, refund_requests, payments, order_lines, orders RESTART IDENTITY CASCADE",
  );
});

describe("Worker Marketplace: S01-S05 Webhooks and Interleavings", () => {
  it("S01: Duplicate webhook (sequential, fresh event id) is processed idempotently by worker", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_w1",
      currency: "INR",
      lines: [
        { seller_id: "seller_a", amount: 700 },
        { seller_id: "seller_b", amount: 300 },
      ],
    });
    const orderId = orderRes.body.id as string;
    const checkoutRes = await post(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_ref as string;

    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;

    // Delivery 1
    const wh1 = await sendWebhook("payment_intent.succeeded", pi, "evt_w_first");
    expect(wh1.status).toBe(200);
    await drainWorker();

    const ledgerCount1 = (await db.query("SELECT count(*) FROM ledger_entries")).rows[0].count;
    expect(Number(ledgerCount1)).toBeGreaterThan(0);

    // Delivery 2 with fresh event id
    const wh2 = await sendWebhook("payment_intent.succeeded", pi, "evt_w_second");
    expect(wh2.status).toBe(200);
    await drainWorker();

    const ledgerCount2 = (await db.query("SELECT count(*) FROM ledger_entries")).rows[0].count;
    expect(ledgerCount2).toBe(ledgerCount1);

    await assertAllMoneyLaws(db);
    await assertOrderPaidIffCaptured(db, orderId, true);
  });

  it("S02: Duplicate webhook (concurrent) enqueues and drains cleanly without duplicate postings", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_w2",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1500 }],
    });
    const orderId = orderRes.body.id as string;
    const checkoutRes = await post(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_ref as string;

    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;

    // Concurrent deliveries
    await Promise.all([
      sendWebhook("payment_intent.succeeded", pi, "evt_w_c1"),
      sendWebhook("payment_intent.succeeded", pi, "evt_w_c2"),
      sendWebhook("payment_intent.succeeded", pi, "evt_w_c1"),
    ]);

    await drainWorker();

    await assertAllMoneyLaws(db);
    await assertEffectOnce(db);
  });

  it("S03: Refund event delivered before payment event is reconciled cleanly by worker", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_w3",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = orderRes.body.id as string;
    const checkoutRes = await post(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_ref as string;

    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;

    // Direct dashboard refund on provider
    const refundObj = {
      id: "re_worker_early",
      object: "refund",
      amount: 500,
      currency: "inr",
      status: "succeeded",
      payment_intent: piId,
      metadata: { order_id: orderId },
    };
    fakeStripe.refunds.set("re_worker_early", refundObj as any);

    // Send refund webhook FIRST
    const whRefund = await sendWebhook("refund.created", refundObj, "evt_w_early_rf");
    expect(whRefund.status).toBe(200);

    // Drain worker: onRefundJob reconciles payment first, so order becomes paid and refund is applied!
    await drainWorker();

    const orderRow = (await db.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0];
    expect(orderRow.status).toBe("partially_refunded");

    await assertAllMoneyLaws(db);
  });

  it("S04: Stale refund event delivered after final one does not regress refund status", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_w4",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = orderRes.body.id as string;
    const lineId = (orderRes.body.lines as string[])[0];
    const checkoutRes = await post(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_ref as string;

    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;
    await sendWebhook("payment_intent.succeeded", pi);
    await drainWorker();

    // Issue refund via shop API
    const rfRes = await post(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 400 });
    expect(rfRes.status).toBe(200);
    const refundRef = rfRes.body.provider_refund_id as string;

    const refund = fakeStripe.refunds.get(refundRef)!;
    expect(refund.status).toBe("succeeded");

    // Late arriving webhook claiming refund is still pending
    const staleObj = { ...refund, status: "pending" };
    await sendWebhook("refund.updated", staleObj, "evt_w_stale");
    await drainWorker();

    const dbRefund = (await db.query("SELECT status FROM refunds WHERE provider_ref = $1", [refundRef])).rows[0];
    expect(dbRefund.status).toBe("succeeded");

    await assertAllMoneyLaws(db);
  });

  it("S05: Payment webhook dropped, retried after shop confirm - books once", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_w5",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1200 }],
    });
    const orderId = orderRes.body.id as string;
    const checkoutRes = await post(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_ref as string;

    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;

    // Buyer confirms on return
    const confirmRes = await post(`/orders/${orderId}/confirm`);
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.status).toBe("paid");

    const ledgerCountAfterConfirm = (await db.query("SELECT count(*) FROM ledger_entries")).rows[0].count;

    // Late webhook arrives
    await sendWebhook("payment_intent.succeeded", pi, "evt_w_late");
    await drainWorker();

    const ledgerCountAfterWebhook = (await db.query("SELECT count(*) FROM ledger_entries")).rows[0].count;
    expect(ledgerCountAfterWebhook).toBe(ledgerCountAfterConfirm);

    await assertAllMoneyLaws(db);
  });

  it("S16: Forged payment webhook rejected with 400, no jobs enqueued", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_w6",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = orderRes.body.id as string;
    const checkoutRes = await post(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_ref as string;

    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;

    const badRes = await sendWebhook("payment_intent.succeeded", pi, "evt_w_forged", "t=123,v1=bad_sig");
    expect(badRes.status).toBe(400);

    // No jobs enqueued in queue
    const jobsCount = (await db.query("SELECT count(*) FROM jobs")).rows[0].count;
    expect(Number(jobsCount)).toBe(0);

    await assertAllMoneyLaws(db);
  });
});
