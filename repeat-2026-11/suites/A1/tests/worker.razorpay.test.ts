// worker-marketplace on the Razorpay adapter (real razorpay-node SDK + its HTTP client against a fake Razorpay API).
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, migrate } from "../worker-marketplace/src/db.ts";
import { providerFromEnv } from "../worker-marketplace/src/provider.ts";
import { createApp } from "../worker-marketplace/src/server.ts";
import { FakeRazorpay, RZP_SECRET } from "./helpers/fakeRazorpay.ts";
import { createDb } from "./helpers/pgdb.ts";

const fake = new FakeRazorpay();
let pool: ReturnType<typeof createPool>;
let app: ReturnType<typeof createApp>;
let base = "";
let drop: () => Promise<void>;
beforeAll(async () => {
  await fake.start();
  pg.types.setTypeParser(20, (v: string) => BigInt(v));
  const d = await createDb("mi_worker_rzp");
  drop = d.drop;
  pool = createPool(d.url);
  await migrate(pool);
  const provider = providerFromEnv({ PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: "rzp_test_money", RAZORPAY_KEY_SECRET: "secret", RAZORPAY_WEBHOOK_SECRET: RZP_SECRET, MONEYINV_RAZORPAY_API_BASE: fake.base });
  app = createApp(pool, provider);
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app?.stop();
  await pool?.end();
  await fake.stop();
  await drop?.();
});
beforeEach(async () => {
  await pool.query("TRUNCATE jobs, ledger_entries, allocations, refunds, refund_requests, payments, order_lines, orders RESTART IDENTITY CASCADE");
  fake.reset();
});
const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const hook = (event: string, payload: Record<string, any>, eventId?: string) => {
  const s = FakeRazorpay.signed(event, payload, eventId);
  return post("/webhooks/razorpay", s.raw, s.headers);
};
const drain = async () => {
  const end = Date.now() + 8000;
  for (;;) {
    while (await app.worker.runOnce()) {}
    if (!(await pool.query("SELECT 1 FROM jobs WHERE state IN ('queued','running')")).rowCount || Date.now() > end) return;
    await new Promise((r) => setTimeout(r, 60));
  }
};
const bal = async (a: string) => BigInt((await pool.query("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE account=$1", [a])).rows[0].s);
const paidOrder = async () => {
  const o = await post("/orders", { lines: [{ seller_id: "seller_a", amount: 60000 }, { seller_id: "seller_b", amount: 40000 }] });
  const co = await post(`/orders/${o.body.id}/checkout`, {});
  const pay = fake.capturePayment(co.body.payment_ref);
  await hook("payment.captured", { payment: { entity: pay } }, "ev_pay");
  await drain();
  return { id: String(o.body.id), lines: o.body.lines as string[], pay };
};
const sound = async () => {
  expect((await pool.query("SELECT 1 FROM ledger_entries GROUP BY txn_id, currency HAVING sum(amount) <> 0")).rowCount).toBe(0);
  expect((await pool.query("SELECT 1 FROM ledger_entries GROUP BY cause_ref, effect_ref, account, currency HAVING count(*) > 1")).rowCount).toBe(0);
};

describe("Razorpay through the queue marketplace", () => {
  it("books a captured payment once under duplicate / header-less redelivery", async () => {
    const o = await paidOrder();
    for (const id of ["ev_pay", "ev_pay", "other", undefined, undefined]) await hook("payment.captured", { payment: { entity: o.pay } }, id);
    await drain();
    expect(await bal("provider:clearing")).toBe(100000n);
    expect(await bal("seller:seller_a")).toBe(-54000n);
    expect((await pool.query("SELECT 1 FROM allocations")).rowCount).toBe(2);
    await sound();
  });

  it("enforces the INR 1.00 minimum before any reservation or POST, and sends the idempotency header otherwise", async () => {
    const o = await paidOrder();
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 99 })).status).toBe(400);
    expect((await pool.query("SELECT 1 FROM refund_requests")).rowCount).toBe(0);
    expect(fake.posts(/refund$/).length).toBe(0);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 })).status).toBe(200);
    const [p] = fake.posts(/refund$/);
    expect(p!.idem).toMatch(/^rr_/);
    expect(p!.body.notes.refund_request_id).toBe(p!.idem);
  });

  it("a lost refund response stays unknown and is never re-sent; the processed event links it once", async () => {
    const o = await paidOrder();
    fake.faults.push({ method: "POST", path: /refund$/, mode: "drop-after-apply", times: 1 });
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 25000 })).status).toBe(202);
    await drain();
    expect(fake.posts(/refund$/).length).toBe(1);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 35001 })).status).toBe(400);
    const re = [...fake.refunds.values()][0]!;
    for (const id of ["r1", "r1", "r2"]) await hook("refund.processed", { refund: { entity: re }, payment: { entity: o.pay } }, id);
    await drain();
    expect(await bal("seller:seller_a")).toBe(-54000n + 25000n);
    expect(await bal("provider:clearing")).toBe(75000n);
    expect((await pool.query("SELECT state FROM refund_requests")).rows[0].state).toBe("sent");
    await sound();
  });

  it("a failed refund is reversed once", async () => {
    const o = await paidOrder();
    fake.refundInitialStatus = "pending";
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 40000 })).status).toBe(200);
    const re = [...fake.refunds.values()][0]!;
    re.status = "failed";
    for (const id of ["f1", "f2"]) await hook("refund.failed", { refund: { entity: re }, payment: { entity: o.pay } }, id);
    await drain();
    expect(await bal("provider:clearing")).toBe(100000n);
    expect(await bal("seller:seller_b")).toBe(-36000n);
    await sound();
  });
});
