// inline-marketplace on the Razorpay adapter (real razorpay-node SDK against a fake Razorpay API).
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeRazorpay, RZP_SECRET } from "./helpers/fakeRazorpay.ts";
import { createDb } from "./helpers/pgdb.ts";

const fake = new FakeRazorpay();
let app: typeof import("../inline-marketplace/src/server.ts");
let db: pg.Client;
let base = "";
let drop: () => Promise<void>;
beforeAll(async () => {
  await fake.start();
  const d = await createDb("mi_inline_rzp");
  drop = d.drop;
  Object.assign(process.env, {
    DATABASE_URL: d.url,
    PAYMENT_PROVIDER: "razorpay",
    RAZORPAY_KEY_ID: "rzp_test_money",
    RAZORPAY_KEY_SECRET: "secret",
    RAZORPAY_WEBHOOK_SECRET: RZP_SECRET,
    MONEYINV_RAZORPAY_API_BASE: fake.base,
  });
  app = await import("../inline-marketplace/src/server.ts");
  await app.migrate();
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  db = new pg.Client({ connectionString: d.url });
  await db.connect();
});
afterAll(async () => {
  await db?.end();
  await app?.stop();
  await fake.stop();
  await drop?.();
});
beforeEach(async () => {
  await db.query("TRUNCATE orders, order_lines, refunds, refund_requests, ledger_entries, processed_events CASCADE");
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
const bal = async (a: string) => BigInt((await db.query("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE account=$1", [a])).rows[0].s);
const paidOrder = async () => {
  const o = await post("/orders", { lines: [{ seller_id: "seller_a", amount: 60000 }, { seller_id: "seller_b", amount: 40000 }] });
  const co = await post(`/orders/${o.body.id}/checkout`, {});
  const pay = fake.capturePayment(co.body.payment_intent_id);
  expect((await hook("payment.captured", { payment: { entity: pay } }, "ev_pay")).status).toBe(200);
  return { id: String(o.body.id), lines: o.body.lines as string[], order: String(co.body.payment_intent_id), pay };
};
const sound = async () => {
  expect((await db.query("SELECT 1 FROM ledger_entries GROUP BY txn_id, currency HAVING sum(amount) <> 0")).rowCount).toBe(0);
  expect((await db.query("SELECT 1 FROM ledger_entries GROUP BY cause_ref, kind, effect_ref, account HAVING count(*) > 1")).rowCount).toBe(0);
};

describe("Razorpay through the inline marketplace", () => {
  it("books a captured payment once however it is redelivered (event-id header, or payload hash when absent)", async () => {
    const o = await paidOrder();
    expect((await hook("payment.captured", { payment: { entity: o.pay } }, "ev_pay")).status).toBe(200);
    expect((await hook("payment.captured", { payment: { entity: o.pay } }, "ev_pay_other_id")).status).toBe(200);
    expect((await hook("payment.captured", { payment: { entity: o.pay } })).status).toBe(200);
    expect((await hook("payment.captured", { payment: { entity: o.pay } })).status).toBe(200);
    expect(await bal("provider:clearing")).toBe(100000n);
    expect((await db.query("SELECT 1 FROM ledger_entries WHERE kind='sale'")).rowCount).toBe(3);
    await sound();
  });

  it("rejects bad signatures and a captured amount different from the order", async () => {
    const o = await post("/orders", { lines: [{ seller_id: "seller_a", amount: 5000 }] });
    const co = await post(`/orders/${o.body.id}/checkout`, {});
    const pay = fake.capturePayment(co.body.payment_intent_id, 4000);
    const s = FakeRazorpay.signed("payment.captured", { payment: { entity: pay } }, "e1");
    expect((await post("/webhooks/razorpay", s.raw, { ...s.headers, "x-razorpay-signature": "00" })).status).toBe(400);
    expect((await hook("payment.captured", { payment: { entity: pay } }, "e2")).status).not.toBe(200);
    expect((await db.query("SELECT 1 FROM ledger_entries")).rowCount).toBe(0);
  });

  it("enforces the INR 1.00 refund minimum locally: no reservation, no provider POST", async () => {
    const o = await paidOrder();
    for (const amount of [1, 50, 99]) expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount })).status).toBe(400);
    expect(fake.posts(/refund$/).length).toBe(0);
    expect((await db.query("SELECT 1 FROM refund_requests")).rowCount).toBe(0);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 })).status).toBe(200);
    expect(await bal("provider:clearing")).toBe(100000n - 100n);
  });

  it("a lost refund response is never re-sent; the processed webhook links it once", async () => {
    const o = await paidOrder();
    fake.faults.push({ method: "POST", path: /refund$/, mode: "drop-after-apply", times: 1 });
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 25000 })).status).toBe(502);
    const [p] = fake.posts(/refund$/);
    expect(p!.idem).toMatch(/^rf_/);
    expect(p!.body.notes).toMatchObject({ order_id: o.id, line_id: o.lines[0], refund_id: p!.idem });
    await db.query("UPDATE refund_requests SET next_attempt_at = now() - interval '1 minute'");
    await app.recoverPendingRefunds();
    expect(fake.posts(/refund$/).length).toBe(1);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 35001 })).status).toBe(400); // 25000 reserved
    const re = [...fake.refunds.values()][0]!;
    const ev = (id: string) => hook("refund.processed", { refund: { entity: re }, payment: { entity: o.pay } }, id);
    const rs = await Promise.all([ev("r1"), ev("r1"), ev("r2")]);
    for (const [i, r] of rs.entries()) if (r.status !== 200) expect((await ev(["r1", "r1", "r2"][i]!)).status).toBe(200);
    expect(await bal("seller:seller_a")).toBe(-54000n + 25000n);
    expect(await bal("provider:clearing")).toBe(75000n);
    expect((await db.query("SELECT resolution FROM refund_requests")).rows[0].resolution).toBe("linked");
    await sound();
  });

  it("pending then failed refunds are reversed exactly once", async () => {
    const o = await paidOrder();
    fake.refundInitialStatus = "pending";
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 40000 })).status).toBe(200);
    const re = [...fake.refunds.values()][0]!;
    expect((await db.query("SELECT status FROM orders WHERE id=$1", [o.id])).rows[0].status).toBe("partially_refunded");
    re.status = "failed";
    for (const id of ["f1", "f2"]) expect((await hook("refund.failed", { refund: { entity: re }, payment: { entity: o.pay } }, id)).status).toBe(200);
    expect(await bal("provider:clearing")).toBe(100000n);
    expect(await bal("seller:seller_b")).toBe(-36000n);
    expect((await db.query("SELECT status FROM orders WHERE id=$1", [o.id])).rows[0].status).toBe("paid");
    await sound();
  });
});
