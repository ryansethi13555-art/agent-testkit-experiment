// Inline marketplace on Razorpay (Orders API, X-Refund-Idempotency, INR minimum refund, header-based event ids).
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRazorpay, RZP_WHSEC, rzpSign } from "../helpers/fakeRazorpay.ts";
import { acct, commonLaws } from "../helpers/laws.ts";
import { createTestDb, sleep, type TestDb } from "../helpers/pg.ts";

let fake: FakeRazorpay;
let tdb: TestDb;
let app: typeof import("../../inline-marketplace/src/server.ts");
let base = "";
let db: pg.Pool;
let evn = 0;

beforeAll(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  fake = new FakeRazorpay();
  await fake.start();
  tdb = await createTestDb("inr");
  process.env.NO_PROXY = "127.0.0.1,localhost";
  process.env.no_proxy = "127.0.0.1,localhost";
  Object.assign(process.env, {
    DATABASE_URL: tdb.url,
    PAYMENT_PROVIDER: "razorpay",
    RAZORPAY_KEY_ID: "rzp_test_independent",
    RAZORPAY_KEY_SECRET: "secret_independent",
    RAZORPAY_WEBHOOK_SECRET: RZP_WHSEC,
    MONEYINV_RAZORPAY_API_BASE: fake.base,
  });
  app = await import("../../inline-marketplace/src/server.ts");
  await app.migrate();
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  pg.types.setTypeParser(20, (v: string) => BigInt(v));
  db = new pg.Pool({ connectionString: tdb.url, max: 4 });
});
afterAll(async () => {
  await db?.end();
  await app?.stop();
  await fake?.stop();
  await tdb?.drop();
});
beforeEach(async () => {
  await db.query("TRUNCATE orders, order_lines, refunds, refund_requests, ledger_entries, processed_events CASCADE");
  fake.orders.clear();
  fake.payments.clear();
  fake.refunds.clear();
  fake.idem.clear();
  fake.log.length = 0;
  fake.faults.length = 0;
  fake.newRefundStatus = "processed";
});

const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const text = await r.text();
  let b: Record<string, any> = {};
  try { b = JSON.parse(text); } catch {}
  return { status: r.status, body: b };
};
const hook = (event: Record<string, any>, opts: { id?: string | null; secret?: string } = {}) => {
  const raw = JSON.stringify(event);
  const headers: Record<string, string> = { "x-razorpay-signature": rzpSign(raw, opts.secret) };
  if (opts.id !== null) headers["x-razorpay-event-id"] = opts.id ?? `rzp_evt_${++evn}`;
  return post("/webhooks/razorpay", raw, headers);
};
const payEvent = (event: string, pay: Record<string, any>) => ({ event, payload: { payment: { entity: fake.snap(pay) } } });
const refundEvent = (event: string, r: Record<string, any>, pay?: Record<string, any>) => ({ event, payload: { refund: { entity: fake.snap(r) }, ...(pay ? { payment: { entity: fake.snap(pay) } } : {}) } });
const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
const sales = async () => Number((await one("SELECT count(*) c FROM ledger_entries WHERE kind IN ('sale','commission')")).c);
const checkedOut = async (lines = [{ seller_id: "seller_a", amount: 60000 }, { seller_id: "seller_b", amount: 40000 }], currency = "INR") => {
  const o = await post("/orders", { currency, lines });
  const co = await post(`/orders/${o.body.id}/checkout`);
  return { order: o.body as { id: string; lines: string[] }, ref: String(co.body.payment_intent_id) };
};
const paid = async (...a: Parameters<typeof checkedOut>) => {
  const x = await checkedOut(...a);
  const pay = fake.pay(x.ref);
  expect((await hook(payEvent("payment.captured", pay))).status).toBe(200);
  return { ...x, pay };
};
const refund = (id: string, line: string, amount: unknown) => post(`/orders/${id}/refunds`, { line_id: line, amount });
const refundPosts = () => fake.posts(/\/refund$/);

describe("Razorpay payments", () => {
  it("a concurrent double submit creates one Razorpay order", async () => {
    const o = await post("/orders", { lines: [{ seller_id: "seller_a", amount: 5000 }] });
    await Promise.all(Array.from({ length: 5 }, () => post(`/orders/${o.body.id}/checkout`)));
    expect(fake.orders.size).toBe(1);
    expect(fake.posts(/\/v1\/orders$/)).toBe(1);
  });
  it("books one balanced sale; duplicate and distinct-id deliveries, with or without the event id header, add nothing", async () => {
    const { order, ref } = await checkedOut();
    const pay = fake.pay(ref);
    const ev = payEvent("payment.captured", pay);
    const rs = await Promise.all([
      hook(ev, { id: "evt_same" }), hook(ev, { id: "evt_same" }), hook(ev, { id: "evt_same" }),
      hook(ev, { id: null }), hook(ev, { id: null }), hook(ev),
    ]);
    for (const r of rs) expect(r.status).toBe(200);
    expect(await sales()).toBe(5);
    expect((await one("SELECT status FROM orders WHERE id=$1", [order.id])).status).toBe("paid");
    expect(await acct(db, "provider:clearing")).toBe(100000n);
    await commonLaws(db);
  });
  it("a late payment.authorized after payment.captured (reordered fan-out) changes nothing", async () => {
    const { ref } = await checkedOut();
    const pay = fake.pay(ref);
    const authorizedSnapshot = { ...fake.snap(pay), status: "authorized", captured: false };
    expect((await hook(payEvent("payment.captured", pay))).status).toBe(200);
    expect((await hook({ event: "payment.authorized", payload: { payment: { entity: authorizedSnapshot } } })).status).toBe(200);
    expect(await sales()).toBe(5);
    await commonLaws(db);
  });
  it("rejects forged signatures and a body signed with another secret", async () => {
    const { ref } = await checkedOut();
    const ev = payEvent("payment.captured", fake.pay(ref));
    expect((await hook(ev, { secret: "other" })).status).toBe(400);
    expect((await post("/webhooks/razorpay", JSON.stringify(ev))).status).toBe(400);
    const raw = JSON.stringify(ev);
    expect((await post("/webhooks/razorpay", raw.replace("60000", "1") + " ", { "x-razorpay-signature": rzpSign(raw) })).status).toBe(400);
    expect(await sales()).toBe(0);
  });
  it("a capture for a different amount than the order books nothing", async () => {
    const { order, ref } = await checkedOut();
    const pay = fake.pay(ref);
    const bad = { ...fake.snap(pay), amount: 99999 };
    expect((await hook(payEvent("payment.captured", bad))).status).not.toBe(200);
    expect((await one("SELECT status FROM orders WHERE id=$1", [order.id])).status).toBe("pending_payment");
    expect(await sales()).toBe(0);
  });
  it("manual capture of an authorised payment books once", async () => {
    const o = await post("/orders", { capture: "manual", lines: [{ seller_id: "seller_a", amount: 5000 }] });
    const co = await post(`/orders/${o.body.id}/checkout`);
    fake.pay(String(co.body.payment_intent_id), "authorized");
    expect((await post(`/orders/${o.body.id}/capture`)).body.status).toBe("paid");
    await post(`/orders/${o.body.id}/confirm`);
    expect(await sales()).toBe(3);
    expect(fake.posts(/\/capture$/)).toBe(1);
  });
});

describe("Razorpay refunds", () => {
  it("INR refunds under 100 paise are refused locally: no reservation, no POST; 100 is accepted with the idempotency header", async () => {
    const { order } = await paid();
    const l1 = `${order.id}_l1`;
    expect((await refund(order.id, l1, 99)).status).toBe(400);
    expect((await refund(order.id, l1, 1)).status).toBe(400);
    expect(refundPosts()).toBe(0);
    expect(Number((await one("SELECT count(*) c FROM refund_requests")).c)).toBe(0);
    expect((await refund(order.id, l1, 100)).status).toBe(200);
    expect(refundPosts()).toBe(1);
    const sent = fake.log.find((l) => /\/refund$/.test(l.path)) as { idemKey?: string; body: Record<string, any> };
    expect(sent.idemKey).toMatch(/^rf_/);
    expect(sent.body.notes.refund_id).toBe(sent.idemKey);
  });
  it("a refund books once and agrees with the provider; processed notices (with new ids) add nothing", async () => {
    const { order, pay } = await paid();
    expect((await refund(order.id, `${order.id}_l1`, 25000)).status).toBe(200);
    const r = [...fake.refunds.values()][0] as Record<string, any>;
    for (let i = 0; i < 3; i++) expect((await hook(refundEvent("refund.processed", r, pay))).status).toBe(200);
    expect(await acct(db, "provider:clearing")).toBe(75000n);
    expect(await acct(db, "seller:seller_a")).toBe(-54000n + 25000n);
    expect((await one("SELECT status FROM orders WHERE id=$1", [order.id])).status).toBe("partially_refunded");
    expect(fake.liveRefunded(pay.id)).toBe(25000);
    await commonLaws(db);
  });
  it("refunds cannot exceed the line, sequentially or concurrently", async () => {
    const { order, pay } = await paid();
    const l1 = `${order.id}_l1`;
    expect((await refund(order.id, l1, 50000)).status).toBe(200);
    expect((await refund(order.id, l1, 10001)).status).toBe(400);
    const rs = await Promise.all([refund(order.id, l1, 5000), refund(order.id, l1, 5000), refund(order.id, l1, 5000)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 400]);
    expect(fake.liveRefunded(pay.id)).toBe(60000);
    await commonLaws(db);
  });
  it("applied but response lost: the same request is never POSTed again; the refund notice links it", async () => {
    const { order, pay } = await paid();
    fake.fault("POST /v1/payments/\\w+/refund", "apply_then_drop", 1);
    expect((await refund(order.id, `${order.id}_l1`, 30000)).status).toBe(502);
    expect(fake.refunds.size).toBe(1);
    await sleep(1700);
    expect(refundPosts()).toBe(1);
    const r = [...fake.refunds.values()][0] as Record<string, any>;
    expect((await hook(refundEvent("refund.created", r, pay))).status).toBe(200);
    expect(Number((await one("SELECT count(*) c FROM refunds")).c)).toBe(1);
    expect((await one("SELECT origin FROM refunds")).origin).toBe("api");
    expect(await acct(db, "provider:clearing")).toBe(70000n);
    expect(refundPosts()).toBe(1);
    await commonLaws(db);
  });
  it("5xx with nothing applied keeps the reservation and never resends", async () => {
    const { order } = await paid();
    const l1 = `${order.id}_l1`;
    fake.fault("POST /v1/payments/\\w+/refund", "before_500", 1);
    expect((await refund(order.id, l1, 30000)).status).toBe(502);
    await sleep(1700);
    expect(refundPosts()).toBe(1);
    expect((await refund(order.id, l1, 30001)).status).toBe(400);
    expect((await refund(order.id, l1, 30000)).status).toBe(200);
    await commonLaws(db);
  });
  it("a refund that is pending and then fails is reversed once and capacity returns", async () => {
    const { order, pay } = await paid();
    fake.newRefundStatus = "pending";
    expect((await refund(order.id, `${order.id}_l1`, 20000)).status).toBe(200);
    const r = [...fake.refunds.values()][0] as Record<string, any>;
    expect(await acct(db, "provider:clearing")).toBe(80000n);
    r.status = "failed";
    for (let i = 0; i < 2; i++) expect((await hook(refundEvent("refund.failed", r, pay))).status).toBe(200);
    expect(await acct(db, "provider:clearing")).toBe(100000n);
    expect((await one("SELECT status FROM orders WHERE id=$1", [order.id])).status).toBe("paid");
    fake.newRefundStatus = "processed";
    expect((await refund(order.id, `${order.id}_l1`, 60000)).status).toBe(200);
    await commonLaws(db);
  });
  it("a dashboard refund is recorded once into the unallocated account and counts against the order", async () => {
    const { order, pay } = await paid();
    const r = fake.dashboardRefund(pay.id, 90000);
    await Promise.all([hook(refundEvent("refund.processed", r, pay), { id: "d1" }), hook(refundEvent("refund.processed", r, pay), { id: "d1" }), hook(refundEvent("refund.created", r, pay))]);
    expect(Number((await one("SELECT count(*) c FROM refunds")).c)).toBe(1);
    expect(await acct(db, "platform:unallocated_refunds")).toBe(90000n);
    expect((await refund(order.id, `${order.id}_l1`, 10001)).status).toBe(400);
    expect((await refund(order.id, `${order.id}_l1`, 10000)).status).toBe(200);
    expect((await one("SELECT status FROM orders WHERE id=$1", [order.id])).status).toBe("refunded");
    await commonLaws(db);
  });
});
