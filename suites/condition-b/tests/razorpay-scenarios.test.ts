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
  assertFailedOperationNoResidue,
  assertOrderPaidIffCaptured,
} from "./helpers/assertions.ts";
import { MockRazorpayServer } from "./helpers/mock-razorpay.ts";

const ADMIN = process.env.MI_PG_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const INLINE_DB = `test_inline_rzp_${process.pid}`;
const WORKER_DB = `test_worker_rzp_${process.pid}`;

let fakeRzp: MockRazorpayServer;

// Inline App state
let inlineApp: typeof import("../inline-marketplace/src/server.ts");
let inlineBase = "";
let inlineDb: pg.Client;

// Worker App state
let workerApp: ReturnType<typeof createWorkerApp>;
let workerBase = "";
let workerDb: Db;

async function postInline(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  const r = await fetch(inlineBase + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

async function postWorker(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  const r = await fetch(workerBase + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

async function sendInlineWebhook(event: string, payload: { payment?: unknown; refund?: unknown }, eventId?: string, overrideSig?: string) {
  const evt = fakeRzp.buildWebhookEvent(event, payload, eventId);
  const headers = overrideSig !== undefined
    ? { ...evt.headers, "x-razorpay-signature": overrideSig }
    : evt.headers;
  return postInline("/webhooks/razorpay", evt.payload, headers);
}

async function sendWorkerWebhook(event: string, payload: { payment?: unknown; refund?: unknown }, eventId?: string, overrideSig?: string) {
  const evt = fakeRzp.buildWebhookEvent(event, payload, eventId);
  const headers = overrideSig !== undefined
    ? { ...evt.headers, "x-razorpay-signature": overrideSig }
    : evt.headers;
  return postWorker("/webhooks/razorpay", evt.payload, headers);
}

async function drainWorker() {
  while (await workerApp.worker.runOnce()) {}
}

beforeAll(async () => {
  fakeRzp = new MockRazorpayServer();
  const rzpUrl = await fakeRzp.start();

  const adminClient = new pg.Client({ connectionString: ADMIN });
  await adminClient.connect();
  await adminClient.query(`DROP DATABASE IF EXISTS ${INLINE_DB} WITH (FORCE)`);
  await adminClient.query(`CREATE DATABASE ${INLINE_DB}`);
  await adminClient.query(`DROP DATABASE IF EXISTS ${WORKER_DB} WITH (FORCE)`);
  await adminClient.query(`CREATE DATABASE ${WORKER_DB}`);
  await adminClient.end();

  // Setup inline marketplace with Razorpay
  process.env.DATABASE_URL = ADMIN.replace(/\/[^/]*$/, `/${INLINE_DB}`);
  process.env.PAYMENT_PROVIDER = "razorpay";
  process.env.RAZORPAY_KEY_ID = "rzp_test_mock";
  process.env.RAZORPAY_KEY_SECRET = "rzp_secret_mock";
  process.env.RAZORPAY_WEBHOOK_SECRET = fakeRzp.webhookSecret;
  process.env.MONEYINV_RAZORPAY_API_BASE = rzpUrl;

  inlineApp = await import("../inline-marketplace/src/server.ts");
  await inlineApp.migrate();
  await new Promise<void>((r) => inlineApp.server.listen(0, "127.0.0.1", () => r()));
  inlineBase = `http://127.0.0.1:${(inlineApp.server.address() as AddressInfo).port}`;
  inlineDb = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await inlineDb.connect();

  // Setup worker marketplace with Razorpay
  const workerDbUrl = new URL(ADMIN);
  workerDbUrl.pathname = `/${WORKER_DB}`;
  workerDb = createPool(workerDbUrl.href);
  await migrateWorker(workerDb);

  const workerProvider = workerProviderFromEnv({
    PAYMENT_PROVIDER: "razorpay",
    RAZORPAY_KEY_ID: "rzp_test_mock",
    RAZORPAY_KEY_SECRET: "rzp_secret_mock",
    RAZORPAY_WEBHOOK_SECRET: fakeRzp.webhookSecret,
    MONEYINV_RAZORPAY_API_BASE: rzpUrl,
  });
  workerApp = createWorkerApp(workerDb, workerProvider);
  await new Promise<void>((r) => workerApp.server.listen(0, "127.0.0.1", () => r()));
  workerBase = `http://127.0.0.1:${(workerApp.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (inlineDb) await inlineDb.end().catch(() => {});
  if (inlineApp) await inlineApp.stop().catch(() => {});
  if (workerApp) await workerApp.stop().catch(() => {});
  if (workerDb) await workerDb.end().catch(() => {});
  if (fakeRzp) await fakeRzp.stop().catch(() => {});

  const adminClient = new pg.Client({ connectionString: ADMIN });
  await adminClient.connect();
  await adminClient.query(`DROP DATABASE IF EXISTS ${INLINE_DB} WITH (FORCE)`);
  await adminClient.query(`DROP DATABASE IF EXISTS ${WORKER_DB} WITH (FORCE)`);
  await adminClient.end();
});

beforeEach(async () => {
  fakeRzp.reset();
  await inlineDb.query("TRUNCATE orders, order_lines, refunds, refund_requests, ledger_entries, processed_events CASCADE");
  await workerDb.query(
    "TRUNCATE jobs, ledger_entries, allocations, refunds, refund_requests, payments, order_lines, orders RESTART IDENTITY CASCADE",
  );
});

describe("Razorpay Provider Contracts and Scenarios", () => {
  it("Razorpay INR minimum refund amount (100 paise = 1.00 INR) is enforced before or during refund", async () => {
    // 1. Inline marketplace check
    const orderRes = await postInline("/orders", {
      buyer: "buyer_rzp_min",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = orderRes.body.id as string;
    const lineId = (orderRes.body.lines as string[])[0];
    const checkoutRes = await postInline(`/orders/${orderId}/checkout`);
    const rzpOrderRef = checkoutRes.body.payment_intent_id as string;

    // Simulate payment captured on Razorpay
    const rzpOrder = fakeRzp.orders.get(rzpOrderRef)!;
    const paymentId = rzpOrder.payments[0];
    const payment = fakeRzp.payments.get(paymentId)!;
    payment.status = "captured";

    // Mark paid via webhook
    await sendInlineWebhook("payment.captured", { payment });

    // Request refund of 99 paise (< 100) -> must be rejected with 400!
    const badRfRes = await postInline(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 99 });
    expect(badRfRes.status).toBe(400);

    // Request refund of 100 paise (>= 100) -> succeeds!
    const goodRfRes = await postInline(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 100 });
    expect(goodRfRes.status).toBe(200);

    await assertAllMoneyLaws(inlineDb);

    // 2. Worker marketplace check
    const wOrderRes = await postWorker("/orders", {
      buyer: "buyer_w_min",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const wOrderId = wOrderRes.body.id as string;
    const wLineId = (wOrderRes.body.lines as string[])[0];
    const wCheckoutRes = await postWorker(`/orders/${wOrderId}/checkout`);
    const wRzpOrderRef = wCheckoutRes.body.payment_ref as string;

    const wRzpOrder = fakeRzp.orders.get(wRzpOrderRef)!;
    const wPaymentId = wRzpOrder.payments[0];
    const wPayment = fakeRzp.payments.get(wPaymentId)!;
    wPayment.status = "captured";

    await sendWorkerWebhook("payment.captured", { payment: wPayment });
    await drainWorker();

    const wBadRfRes = await postWorker(`/orders/${wOrderId}/refunds`, { line_id: wLineId, amount: 50 });
    expect(wBadRfRes.status).toBe(400);

    const wGoodRfRes = await postWorker(`/orders/${wOrderId}/refunds`, { line_id: wLineId, amount: 150 });
    expect(wGoodRfRes.status).toBe(200);

    await drainWorker();
    await assertAllMoneyLaws(workerDb);
  });

  it("Razorpay concurrent operation conflict (400) preserves reservation without corruption", async () => {
    const orderRes = await postInline("/orders", {
      buyer: "buyer_rzp_concurrent",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = orderRes.body.id as string;
    const lineId = (orderRes.body.lines as string[])[0];
    const checkoutRes = await postInline(`/orders/${orderId}/checkout`);
    const rzpOrderRef = checkoutRes.body.payment_intent_id as string;

    const rzpOrder = fakeRzp.orders.get(rzpOrderRef)!;
    const payment = fakeRzp.payments.get(rzpOrder.payments[0])!;
    payment.status = "captured";
    await sendInlineWebhook("payment.captured", { payment });

    // Enable concurrentOperation simulation on MockRazorpay
    fakeRzp.concurrentOperation = true;

    // Refund call fails with 409 DefinitiveRefundRejection because of concurrent operation error
    const rfRes = await postInline(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 300 });
    expect([409, 502]).toContain(rfRes.status);

    fakeRzp.concurrentOperation = false;

    // After conflict clears, retry succeeds
    const rfRes2 = await postInline(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 300 });
    expect(rfRes2.status).toBe(200);

    await assertAllMoneyLaws(inlineDb);
  });

  it("Razorpay webhook signature verification and forgery rejection", async () => {
    const orderRes = await postInline("/orders", {
      buyer: "buyer_rzp_sig",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = orderRes.body.id as string;
    const checkoutRes = await postInline(`/orders/${orderId}/checkout`);
    const rzpOrderRef = checkoutRes.body.payment_intent_id as string;

    const rzpOrder = fakeRzp.orders.get(rzpOrderRef)!;
    const payment = fakeRzp.payments.get(rzpOrder.payments[0])!;
    payment.status = "captured";

    // Forged signature
    const badSigRes = await sendInlineWebhook("payment.captured", { payment }, "evt_rzp_forged", "forged_hex_sig_12345");
    expect(badSigRes.status).toBe(400);

    // Valid signature
    const goodSigRes = await sendInlineWebhook("payment.captured", { payment }, "evt_rzp_valid");
    expect(goodSigRes.status).toBe(200);

    await assertAllMoneyLaws(inlineDb);
  });

  it("Razorpay duplicate webhook delivery with x-razorpay-event-id is processed once", async () => {
    const orderRes = await postWorker("/orders", {
      buyer: "buyer_rzp_dedupe",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1500 }],
    });
    const orderId = orderRes.body.id as string;
    const checkoutRes = await postWorker(`/orders/${orderId}/checkout`);
    const rzpOrderRef = checkoutRes.body.payment_ref as string;

    const rzpOrder = fakeRzp.orders.get(rzpOrderRef)!;
    const payment = fakeRzp.payments.get(rzpOrder.payments[0])!;
    payment.status = "captured";

    // Deliver same event twice
    const r1 = await sendWorkerWebhook("payment.captured", { payment }, "evt_rzp_dedupe_1");
    expect(r1.status).toBe(200);
    const r2 = await sendWorkerWebhook("payment.captured", { payment }, "evt_rzp_dedupe_1");
    expect(r2.status).toBe(200);

    await drainWorker();

    // Verify exactly 1 job was created/processed
    const jobsCount = (await workerDb.query("SELECT count(*) FROM jobs")).rows[0].count;
    expect(Number(jobsCount)).toBe(1);

    await assertAllMoneyLaws(workerDb);
  });

  it("Razorpay out-of-order webhook delivery (payment.captured before payment.authorized)", async () => {
    const orderRes = await postWorker("/orders", {
      buyer: "buyer_rzp_order",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 800 }],
    });
    const orderId = orderRes.body.id as string;
    const checkoutRes = await postWorker(`/orders/${orderId}/checkout`);
    const rzpOrderRef = checkoutRes.body.payment_ref as string;

    const rzpOrder = fakeRzp.orders.get(rzpOrderRef)!;
    const payment = fakeRzp.payments.get(rzpOrder.payments[0])!;

    // Deliver captured first
    payment.status = "captured";
    await sendWorkerWebhook("payment.captured", { payment }, "evt_rzp_cap");
    await drainWorker();

    const orderRow = (await workerDb.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0];
    expect(orderRow.status).toBe("paid");

    // Later authorized event arrives (snapshot in past)
    payment.status = "authorized";
    await sendWorkerWebhook("payment.authorized", { payment }, "evt_rzp_auth");
    await drainWorker();

    // Order status should not regress to requires_capture or pending
    const orderAfter = (await workerDb.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0];
    expect(orderAfter.status).toBe("paid");

    await assertAllMoneyLaws(workerDb);
  });
});
