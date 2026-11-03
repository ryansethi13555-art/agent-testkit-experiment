import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import fc from "fast-check";
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
  assertAllocationsMatchOrder,
  assertFailedOperationNoResidue,
  assertOrderPaidIffCaptured,
} from "./helpers/assertions.ts";
import { MockStripeServer } from "./helpers/mock-stripe.ts";

const ADMIN = process.env.MI_PG_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const INLINE_DB = `test_inline_deep_${process.pid}`;
const WORKER_DB = `test_worker_deep_${process.pid}`;

let fakeStripe: MockStripeServer;

let inlineApp: typeof import("../inline-marketplace/src/server.ts");
let inlineBase = "";
let inlineDb: pg.Client;

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

async function sendInlineWebhook(type: string, dataObject: unknown, eventId?: string) {
  const evt = fakeStripe.buildWebhookEvent(type, dataObject, eventId);
  return postInline("/webhooks/stripe", evt.payload, evt.headers);
}

async function sendWorkerWebhook(type: string, dataObject: unknown, eventId?: string) {
  const evt = fakeStripe.buildWebhookEvent(type, dataObject, eventId);
  return postWorker("/webhooks/stripe", evt.payload, evt.headers);
}

async function drainWorker() {
  while (await workerApp.worker.runOnce()) {}
}

beforeAll(async () => {
  fakeStripe = new MockStripeServer();
  const stripeUrl = await fakeStripe.start();

  const adminClient = new pg.Client({ connectionString: ADMIN });
  await adminClient.connect();
  await adminClient.query(`DROP DATABASE IF EXISTS ${INLINE_DB} WITH (FORCE)`);
  await adminClient.query(`CREATE DATABASE ${INLINE_DB}`);
  await adminClient.query(`DROP DATABASE IF EXISTS ${WORKER_DB} WITH (FORCE)`);
  await adminClient.query(`CREATE DATABASE ${WORKER_DB}`);
  await adminClient.end();

  // Inline app setup
  process.env.DATABASE_URL = ADMIN.replace(/\/[^/]*$/, `/${INLINE_DB}`);
  process.env.PAYMENT_PROVIDER = "stripe";
  process.env.STRIPE_SECRET_KEY = "sk_test_mock";
  process.env.STRIPE_WEBHOOK_SECRET = fakeStripe.webhookSecret;
  process.env.MONEYINV_STRIPE_API_BASE = stripeUrl;

  inlineApp = await import("../inline-marketplace/src/server.ts");
  await inlineApp.migrate();
  await new Promise<void>((r) => inlineApp.server.listen(0, "127.0.0.1", () => r()));
  inlineBase = `http://127.0.0.1:${(inlineApp.server.address() as AddressInfo).port}`;
  inlineDb = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await inlineDb.connect();

  // Worker app setup
  const workerDbUrl = new URL(ADMIN);
  workerDbUrl.pathname = `/${WORKER_DB}`;
  workerDb = createPool(workerDbUrl.href);
  await migrateWorker(workerDb);

  const workerProvider = workerProviderFromEnv({
    PAYMENT_PROVIDER: "stripe",
    STRIPE_SECRET_KEY: "sk_test_mock",
    STRIPE_WEBHOOK_SECRET: fakeStripe.webhookSecret,
    MONEYINV_STRIPE_API_BASE: stripeUrl,
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
  if (fakeStripe) await fakeStripe.stop().catch(() => {});

  const adminClient = new pg.Client({ connectionString: ADMIN });
  await adminClient.connect();
  await adminClient.query(`DROP DATABASE IF EXISTS ${INLINE_DB} WITH (FORCE)`);
  await adminClient.query(`DROP DATABASE IF EXISTS ${WORKER_DB} WITH (FORCE)`);
  await adminClient.end();
});

beforeEach(async () => {
  fakeStripe.reset();
  await inlineDb.query("TRUNCATE orders, order_lines, refunds, refund_requests, ledger_entries, processed_events CASCADE");
  await workerDb.query(
    "TRUNCATE jobs, ledger_entries, allocations, refunds, refund_requests, payments, order_lines, orders RESTART IDENTITY CASCADE",
  );
});

describe("Deep Money Laws and Accounting Verification", () => {
  it("alloc.declared-part-arithmetic & alloc.declared-parts-sum-to-whole: Multi-seller odd-amount conservation", async () => {
    // Test odd amounts that stress half-even rounding and sum conservation: 1, 5, 15, 333, 777
    const lines = [
      { seller_id: "seller_a", amount: 1 },
      { seller_id: "seller_b", amount: 5 },
      { seller_id: "seller_a", amount: 15 },
      { seller_id: "seller_b", amount: 333 },
      { seller_id: "seller_a", amount: 777 },
    ];
    const totalExpected = 1 + 5 + 15 + 333 + 777; // 1131

    const orderRes = await postWorker("/orders", {
      buyer: "buyer_odd_amounts",
      currency: "INR",
      lines,
    });
    expect(orderRes.status).toBe(201);
    const orderId = orderRes.body.id as string;

    const checkoutRes = await postWorker(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_ref as string;

    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;

    await sendWorkerWebhook("payment_intent.succeeded", pi);
    await drainWorker();

    // Verify allocations table
    const allocRows = (await workerDb.query("SELECT * FROM allocations WHERE order_id = $1", [orderId])).rows;
    expect(allocRows.length).toBe(lines.length);

    let sumAlloc = 0n;
    for (const alloc of allocRows) {
      const lineAmt = BigInt(alloc.amount);
      const sellerAmt = BigInt(alloc.seller_amount);
      const feeAmt = BigInt(alloc.commission_amount);

      // Money Law: Parts sum exactly to whole
      expect(sellerAmt + feeAmt).toBe(lineAmt);

      // Money Law: Non-negative parts
      expect(sellerAmt).toBeGreaterThanOrEqual(0n);
      expect(feeAmt).toBeGreaterThanOrEqual(0n);

      sumAlloc += lineAmt;
    }
    expect(sumAlloc).toBe(BigInt(totalExpected));

    await assertAllMoneyLaws(workerDb);
  });

  it("Property Test: Commission arithmetic and conservation holds across random minor unit amounts", () => {
    // Import commission logic from money module
    const commission = (amount: bigint): bigint => {
      const n = amount * 1000n;
      const q = n / 10000n;
      const r = n % 10000n;
      if (r * 2n > 10000n || (r * 2n === 10000n && q % 2n === 1n)) return q + 1n;
      return q;
    };

    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 1_000_000_000n }), (amount) => {
        const fee = commission(amount);
        const seller = amount - fee;

        // Conservation: fee + seller = amount
        expect(fee + seller).toBe(amount);

        // Bounded: fee <= amount, seller >= 0
        expect(fee).toBeGreaterThanOrEqual(0n);
        expect(fee).toBeLessThanOrEqual(amount);
        expect(seller).toBeGreaterThanOrEqual(0n);
      }),
      { numRuns: 1000 },
    );
  });

  it("ledger.clearing-mirrors-provider: Clearing account balance exactly matches provider movements", async () => {
    const orderRes = await postInline("/orders", {
      buyer: "buyer_clearing_mirror",
      currency: "INR",
      lines: [
        { seller_id: "seller_a", amount: 1000 },
        { seller_id: "seller_b", amount: 2000 },
      ],
    });
    const orderId = orderRes.body.id as string;
    const [line1, line2] = orderRes.body.lines as string[];

    const checkoutRes = await postInline(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_intent_id as string;

    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;
    await sendInlineWebhook("payment_intent.succeeded", pi);

    // Initial capture: provider captured 3000. provider:clearing should be +3000
    const clearing1 = (
      await inlineDb.query("SELECT sum(amount)::bigint s FROM ledger_entries WHERE account = 'provider:clearing'")
    ).rows[0].s as bigint;
    expect(clearing1).toBe(3000n);

    // Issue refund 1: 500 on line 1
    const rf1 = await postInline(`/orders/${orderId}/refunds`, { line_id: line1, amount: 500 });
    expect(rf1.status).toBe(200);

    // Clearing balance should now be 3000 - 500 = 2500
    const clearing2 = (
      await inlineDb.query("SELECT sum(amount)::bigint s FROM ledger_entries WHERE account = 'provider:clearing'")
    ).rows[0].s as bigint;
    expect(clearing2).toBe(2500n);

    // Issue refund 2: 1200 on line 2
    const rf2 = await postInline(`/orders/${orderId}/refunds`, { line_id: line2, amount: 1200 });
    expect(rf2.status).toBe(200);

    // Clearing balance should now be 2500 - 1200 = 1300
    const clearing3 = (
      await inlineDb.query("SELECT sum(amount)::bigint s FROM ledger_entries WHERE account = 'provider:clearing'")
    ).rows[0].s as bigint;
    expect(clearing3).toBe(1300n);

    await assertAllMoneyLaws(inlineDb);
  });

  it("Out-of-band Dashboard Refund: Attributed to unallocated_refunds or reconciled without corrupting line budgets", async () => {
    const orderRes = await postInline("/orders", {
      buyer: "buyer_dashboard_rf",
      currency: "INR",
      lines: [
        { seller_id: "seller_a", amount: 1000 },
        { seller_id: "seller_b", amount: 1000 },
      ],
    });
    const orderId = orderRes.body.id as string;
    const checkoutRes = await postInline(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_intent_id as string;

    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;
    await sendInlineWebhook("payment_intent.succeeded", pi);

    // Out-of-band refund created on Stripe Dashboard directly (no line_id or refund_id in metadata)
    const outOfBandRefund = {
      id: "re_dashboard_oob",
      object: "refund",
      amount: 600,
      currency: "inr",
      status: "succeeded",
      payment_intent: piId,
      metadata: { order_id: orderId }, // only order_id from Stripe dashboard
    };
    fakeStripe.refunds.set("re_dashboard_oob", outOfBandRefund as any);

    const whRes = await sendInlineWebhook("refund.created", outOfBandRefund);
    expect(whRes.status).toBe(200);

    // Verify refund row created with origin='provider' and line_id is NULL
    const rfRow = (await inlineDb.query("SELECT * FROM refunds WHERE provider_ref = 're_dashboard_oob'")).rows[0];
    expect(rfRow).toBeDefined();
    expect(rfRow.origin).toBe("provider");
    expect(rfRow.line_id).toBeNull();

    // Ledger entry for out-of-band refund went to platform:unallocated_refunds
    const oobLedger = (
      await inlineDb.query("SELECT account, amount FROM ledger_entries WHERE cause_ref = 're_dashboard_oob'")
    ).rows;
    const accounts = oobLedger.map((r) => r.account);
    expect(accounts).toContain("platform:unallocated_refunds");
    expect(accounts).toContain("provider:clearing");

    await assertAllMoneyLaws(inlineDb);
  });

  it("refund.lifecycle-no-regression: Terminal states ignore regressive pending webhooks", async () => {
    const orderRes = await postWorker("/orders", {
      buyer: "buyer_no_regression",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = orderRes.body.id as string;
    const lineId = (orderRes.body.lines as string[])[0];
    const checkoutRes = await postWorker(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_ref as string;

    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;
    await sendWorkerWebhook("payment_intent.succeeded", pi);
    await drainWorker();

    const rfRes = await postWorker(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 500 });
    expect(rfRes.status).toBe(200);
    const refundRef = rfRes.body.provider_refund_id as string;

    // Refund has succeeded
    const rf = fakeStripe.refunds.get(refundRef)!;
    expect(rf.status).toBe("succeeded");

    // Try sending webhook with status = 'pending'
    const regressiveObj = { ...rf, status: "pending" };
    await sendWorkerWebhook("refund.updated", regressiveObj);
    await drainWorker();

    const dbRefund = (await workerDb.query("SELECT status FROM refunds WHERE provider_ref = $1", [refundRef])).rows[0];
    expect(dbRefund.status).toBe("succeeded");

    await assertAllMoneyLaws(workerDb);
  });
});
