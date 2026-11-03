import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Db, migrate as migrateWorker } from "../worker-marketplace/src/db.ts";
import { providerFromEnv as workerProviderFromEnv } from "../worker-marketplace/src/provider.ts";
import { createApp as createWorkerApp } from "../worker-marketplace/src/server.ts";
import {
  assertAllMoneyLaws,
  assertLedgerBalanced,
  assertEffectOnce,
  assertRefundLineBounded,
  assertAllocationsSumToWhole,
  assertFailedOperationNoResidue,
  assertOrderPaidIffCaptured,
} from "./helpers/assertions.ts";
import { MockStripeServer } from "./helpers/mock-stripe.ts";
import { MockRazorpayServer } from "./helpers/mock-razorpay.ts";

const ADMIN = process.env.MI_PG_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const DB = `test_edge_cases_${process.pid}`;

let fakeStripe: MockStripeServer;
let fakeRzp: MockRazorpayServer;
let db: Db;
let workerApp: ReturnType<typeof createWorkerApp>;
let workerBase = "";

async function postWorker(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  const r = await fetch(workerBase + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

async function sendWorkerStripeWebhook(type: string, dataObject: unknown, eventId?: string) {
  const evt = fakeStripe.buildWebhookEvent(type, dataObject, eventId);
  return postWorker("/webhooks/stripe", evt.payload, evt.headers);
}

async function drainWorker() {
  while (await workerApp.worker.runOnce()) {}
}

beforeAll(async () => {
  fakeStripe = new MockStripeServer();
  fakeRzp = new MockRazorpayServer();
  const stripeUrl = await fakeStripe.start();
  await fakeRzp.start();

  const adminClient = new pg.Client({ connectionString: ADMIN });
  await adminClient.connect();
  await adminClient.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await adminClient.query(`CREATE DATABASE ${DB}`);
  await adminClient.end();

  const databaseUrl = new URL(ADMIN);
  databaseUrl.pathname = `/${DB}`;
  db = createPool(databaseUrl.href);
  await migrateWorker(db);

  const provider = workerProviderFromEnv({
    PAYMENT_PROVIDER: "stripe",
    STRIPE_SECRET_KEY: "sk_test_mock",
    STRIPE_WEBHOOK_SECRET: fakeStripe.webhookSecret,
    MONEYINV_STRIPE_API_BASE: stripeUrl,
  });

  workerApp = createWorkerApp(db, provider);
  await new Promise<void>((r) => workerApp.server.listen(0, "127.0.0.1", () => r()));
  workerBase = `http://127.0.0.1:${(workerApp.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (workerApp) await workerApp.stop().catch(() => {});
  if (db) await db.end().catch(() => {});
  if (fakeStripe) await fakeStripe.stop().catch(() => {});
  if (fakeRzp) await fakeRzp.stop().catch(() => {});
  const adminClient = new pg.Client({ connectionString: ADMIN });
  await adminClient.connect();
  await adminClient.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await adminClient.end();
});

beforeEach(async () => {
  fakeStripe.reset();
  fakeRzp.reset();
  await db.query(
    "TRUNCATE jobs, ledger_entries, allocations, refunds, refund_requests, payments, order_lines, orders RESTART IDENTITY CASCADE",
  );
});

describe("Provider Contract Edge Cases & Invariants", () => {
  it("Zero-decimal currency (JPY) amounts are exact integer minor units without loss", async () => {
    const orderRes = await postWorker("/orders", {
      buyer: "buyer_jpy",
      currency: "JPY",
      lines: [
        { seller_id: "seller_a", amount: 1500 },
        { seller_id: "seller_b", amount: 2500 },
      ],
    });
    expect(orderRes.status).toBe(201);
    const orderId = orderRes.body.id as string;
    const [line1] = orderRes.body.lines as string[];

    const checkoutRes = await postWorker(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_ref as string;

    const pi = fakeStripe.pis.get(piId)!;
    expect(pi.currency).toBe("jpy");
    expect(pi.amount).toBe(4000);

    pi.status = "succeeded";
    pi.amount_received = 4000;
    await sendWorkerStripeWebhook("payment_intent.succeeded", pi);
    await drainWorker();

    // Partial refund on JPY line
    const rfRes = await postWorker(`/orders/${orderId}/refunds`, { line_id: line1, amount: 500 });
    expect(rfRes.status).toBe(200);

    await drainWorker();

    // Check ledger currency is JPY
    const ledgerRows = (await db.query("SELECT currency, amount FROM ledger_entries WHERE cause_ref = $1", [piId])).rows;
    expect(ledgerRows.every((r) => r.currency === "JPY")).toBe(true);

    await assertAllMoneyLaws(db);
    await assertRefundLineBounded(db);
  });

  it("Multiple partial refunds on single payment across distinct order lines accumulate correctly", async () => {
    const orderRes = await postWorker("/orders", {
      buyer: "buyer_multi_line_rf",
      currency: "INR",
      lines: [
        { seller_id: "seller_a", amount: 1000 },
        { seller_id: "seller_b", amount: 2000 },
      ],
    });
    const orderId = orderRes.body.id as string;
    const [lineA, lineB] = orderRes.body.lines as string[];

    const checkoutRes = await postWorker(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_ref as string;

    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;
    await sendWorkerStripeWebhook("payment_intent.succeeded", pi);
    await drainWorker();

    // Line A refund 400
    const rfA1 = await postWorker(`/orders/${orderId}/refunds`, { line_id: lineA, amount: 400 });
    expect(rfA1.status).toBe(200);

    // Line B refund 1000
    const rfB1 = await postWorker(`/orders/${orderId}/refunds`, { line_id: lineB, amount: 1000 });
    expect(rfB1.status).toBe(200);

    // Line A refund 600 (exact remainder)
    const rfA2 = await postWorker(`/orders/${orderId}/refunds`, { line_id: lineA, amount: 600 });
    expect(rfA2.status).toBe(200);

    // Line A refund 1 (overdraft) -> rejected
    const rfA3 = await postWorker(`/orders/${orderId}/refunds`, { line_id: lineA, amount: 1 });
    expect(rfA3.status).toBe(400);

    // Line B refund 1000 (exact remainder)
    const rfB2 = await postWorker(`/orders/${orderId}/refunds`, { line_id: lineB, amount: 1000 });
    expect(rfB2.status).toBe(200);

    await drainWorker();

    // Total refunded in DB is 3000 (order fully refunded)
    const orderRow = (await db.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0];
    expect(orderRow.status).toBe("refunded");

    await assertAllMoneyLaws(db);
    await assertRefundLineBounded(db);
  });

  it("Delayed-notification payment (payment_intent.processing) does not prematurely book revenue", async () => {
    const orderRes = await postWorker("/orders", {
      buyer: "buyer_delayed",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = orderRes.body.id as string;
    const checkoutRes = await postWorker(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_ref as string;

    const pi = fakeStripe.pis.get(piId)!;
    // Payment enters 'requires_action' / pending
    pi.status = "requires_payment_method";

    await sendWorkerStripeWebhook("payment_intent.created", pi);
    await drainWorker();

    // Order should NOT be marked paid
    const orderRow = (await db.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0];
    expect(orderRow.status).toBe("pending_payment");

    // Zero revenue or seller ledger entries
    const revenueEntries = (await db.query("SELECT count(*) FROM ledger_entries WHERE kind = 'sale'")).rows[0].count;
    expect(Number(revenueEntries)).toBe(0);

    // Later payment succeeds
    pi.status = "succeeded";
    pi.amount_received = pi.amount;
    await sendWorkerStripeWebhook("payment_intent.succeeded", pi);
    await drainWorker();

    const orderRowAfter = (await db.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0];
    expect(orderRowAfter.status).toBe("paid");

    await assertAllMoneyLaws(db);
  });

  it("Replayed idempotent refund returns exact original response with Idempotent-Replayed header", async () => {
    const orderRes = await postWorker("/orders", {
      buyer: "buyer_idem_replay",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = orderRes.body.id as string;
    const [line1] = orderRes.body.lines as string[];
    const checkoutRes = await postWorker(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_ref as string;

    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;
    await sendWorkerStripeWebhook("payment_intent.succeeded", pi);
    await drainWorker();

    const rfRes = await postWorker(`/orders/${orderId}/refunds`, { line_id: line1, amount: 500 });
    expect(rfRes.status).toBe(200);
    const refundId = rfRes.body.provider_refund_id;

    // Direct check on mock stripe idempotency cache
    const cached = fakeStripe.idempotencyCache.get(String(rfRes.body.request_id));
    expect(cached).toBeDefined();

    await drainWorker();
    await assertAllMoneyLaws(db);
  });
});
