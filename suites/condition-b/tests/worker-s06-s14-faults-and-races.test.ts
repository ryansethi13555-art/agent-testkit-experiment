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
  assertRefundLineBounded,
  assertFailedOperationNoResidue,
  assertOrderPaidIffCaptured,
} from "./helpers/assertions.ts";
import { MockStripeServer } from "./helpers/mock-stripe.ts";

const ADMIN = process.env.MI_PG_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const DB = `test_worker_faults_${process.pid}`;

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

async function sendWebhook(type: string, dataObject: unknown, eventId?: string) {
  const evt = fakeStripe.buildWebhookEvent(type, dataObject, eventId);
  return post("/webhooks/stripe", evt.payload, evt.headers);
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

describe("Worker Marketplace: S06-S14 Faults, Races and Lifecycle", () => {
  it("S06: Capture applied, response lost across retries - reconcile job settles order to paid", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_w_s06",
      currency: "INR",
      capture: "manual",
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = orderRes.body.id as string;
    const checkoutRes = await post(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_ref as string;

    // Drop capture response across all retries
    fakeStripe.dropCaptureCount = 3;
    const captureRes = await post(`/orders/${orderId}/capture`);
    expect(captureRes.status).toBe(502);

    // Capture succeeded on provider
    const pi = fakeStripe.pis.get(piId)!;
    expect(pi.status).toBe("succeeded");

    // Queue has reconcile_payment job enqueued by the capture handler
    const jobRow = (await db.query("SELECT * FROM jobs WHERE type = 'reconcile_payment'")).rows[0];
    expect(jobRow).toBeDefined();

    // Drain worker
    await drainWorker();

    // Order is paid now
    const orderAfter = (await db.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0];
    expect(orderAfter.status).toBe("paid");

    await assertAllMoneyLaws(db);
    await assertOrderPaidIffCaptured(db, orderId, true);
  });

  it("S08: Provider 5xx on refund keeps reservation in unknown state, preventing line overdraft", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_w_s08",
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

    // Provider fails refund with 500
    fakeStripe.failBeforeApplying = {
      status: 500,
      body: { error: { message: "Internal provider error" } },
    };

    const rfRes = await post(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 400 });
    // Returns 202 processing because outcome is unknown
    expect(rfRes.status).toBe(202);

    // Reservation is saved in refund_requests with state = 'unknown'
    const reqRow = (await db.query("SELECT state, amount FROM refund_requests WHERE order_id = $1", [orderId])).rows[0];
    expect(reqRow.state).toBe("unknown");
    expect(reqRow.amount).toBe(400n);

    // Overdraft attempt: remaining headroom is 1000 - 400 = 600. Requesting 700 must be rejected with 400!
    const overRes = await post(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 700 });
    expect(overRes.status).toBe(400);

    await assertAllMoneyLaws(db);
  });

  it("S09: Concurrent refunds on one line strictly bounded by line amount", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_w_s09",
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

    // Two concurrent refunds for 700 on a 1000 line
    const [resA, resB] = await Promise.all([
      post(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 700 }),
      post(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 700 }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 400]);

    await drainWorker();
    await assertAllMoneyLaws(db);
    await assertRefundLineBounded(db);
  });

  it("S10: Sequential partial refunds bounded by line amount", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_w_s10",
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

    // 1st: 600 -> 200
    const rf1 = await post(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 600 });
    expect(rf1.status).toBe(200);

    // 2nd: 500 -> 400 (exceeds 1000)
    const rf2 = await post(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 500 });
    expect(rf2.status).toBe(400);

    // 3rd: 400 -> 200 (exact)
    const rf3 = await post(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 400 });
    expect(rf3.status).toBe(200);

    await drainWorker();
    await assertAllMoneyLaws(db);
    await assertRefundLineBounded(db);
  });

  it("S11: Client double-submits checkout returns same payment reference", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_w_s11",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1000 }],
    });
    const orderId = orderRes.body.id as string;

    const [c1, c2] = await Promise.all([
      post(`/orders/${orderId}/checkout`),
      post(`/orders/${orderId}/checkout`),
    ]);

    if (c1.status === 200 && c2.status === 200) {
      expect(c1.body.payment_ref).toBe(c2.body.payment_ref);
    } else {
      const successful = [c1, c2].find((c) => c.status === 200);
      expect(successful).toBeDefined();
    }

    const piCount = [...fakeStripe.pis.values()].filter((p) => p.metadata.order_id === orderId).length;
    expect(piCount).toBe(1);

    await assertAllMoneyLaws(db);
  });

  it("S13: Refund fails asynchronously after acceptance - worker reverses ledger entry leaving zero residue", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_w_s13",
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

    // Create refund
    const rfRes = await post(`/orders/${orderId}/refunds`, { line_id: lineId, amount: 500 });
    expect(rfRes.status).toBe(200);
    const refundRef = rfRes.body.provider_refund_id as string;

    // Drain worker to book recognition
    await drainWorker();

    // Refund fails asynchronously
    const refundObj = fakeStripe.refunds.get(refundRef)!;
    refundObj.status = "failed";

    await sendWebhook("refund.failed", refundObj, "evt_w_rf_failed");
    await drainWorker();

    const dbRefund = (await db.query("SELECT status FROM refunds WHERE provider_ref = $1", [refundRef])).rows[0];
    expect(dbRefund.status).toBe("failed");

    await assertFailedOperationNoResidue(db, [refundRef]);
    await assertAllMoneyLaws(db);
  });

  it("S14: Worker process restarts after crash and re-queues running jobs", async () => {
    const orderRes = await post("/orders", {
      buyer: "buyer_w_s14",
      currency: "INR",
      lines: [{ seller_id: "seller_a", amount: 1500 }],
    });
    const orderId = orderRes.body.id as string;
    const checkoutRes = await post(`/orders/${orderId}/checkout`);
    const piId = checkoutRes.body.payment_ref as string;

    const pi = fakeStripe.pis.get(piId)!;
    pi.status = "succeeded";
    pi.amount_received = pi.amount;

    // Simulate job was in 'running' state when previous process crashed
    await db.query(
      "INSERT INTO jobs (provider_event_id, type, payload, state) VALUES ($1, 'payment', $2, 'running')",
      ["evt_crashed_job", JSON.stringify({ ref: piId })],
    );

    // Call worker.recover() to re-queue it
    const recovered = await app.worker.recover();
    expect(recovered).toBe(1);

    // Drain worker
    await drainWorker();

    const orderRow = (await db.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0];
    expect(orderRow.status).toBe("paid");

    await assertAllMoneyLaws(db);
  });
});
