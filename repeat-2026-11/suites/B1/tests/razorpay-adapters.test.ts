// Both apps end to end through the REAL Razorpay adapters, against a fake Razorpay HTTP API.
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Db, migrate } from "../worker-marketplace/src/db.ts";
import { providerFromEnv as workerProvider } from "../worker-marketplace/src/provider.ts";
import { createApp } from "../worker-marketplace/src/server.ts";
import { createDb, dropDb } from "./helpers/db.ts";
import { RZP_SECRET, RzpWorld, rzpEvent, rzpSign } from "./helpers/rzp.ts";

type Any = any; // eslint-disable-line
const rz = new RzpWorld();
await rz.listen();
const idb = await createDb("rzpinline");
const wdb = await createDb("rzpworker");
Object.assign(process.env, {
  PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: "sec", RAZORPAY_WEBHOOK_SECRET: RZP_SECRET,
  MONEYINV_RAZORPAY_API_BASE: rz.base, DATABASE_URL: idb.url,
});
let inl: Any; let ibase = ""; let idbc: pg.Client;
let wpool: Db; let wapp: ReturnType<typeof createApp>; let wbase = ""; let wc: pg.Client;

beforeAll(async () => {
  inl = await import("../inline-marketplace/src/server.ts");
  await inl.migrate();
  await new Promise<void>((r) => inl.server.listen(0, "127.0.0.1", () => r()));
  ibase = `http://127.0.0.1:${(inl.server.address() as AddressInfo).port}`;
  idbc = new pg.Client({ connectionString: idb.url }); await idbc.connect();
  wpool = createPool(wdb.url); await migrate(wpool);
  wc = new pg.Client({ connectionString: wdb.url }); await wc.connect();
});
afterAll(async () => {
  await idbc?.end(); await wc?.end(); await wapp?.stop().catch(() => {}); await inl?.stop(); await wpool?.end(); await rz.close();
  await dropDb(idb.name); await dropDb(wdb.name);
});
beforeEach(async () => {
  rz.reset();
  await idbc.query("TRUNCATE orders, order_lines, refunds, refund_requests, ledger_entries, processed_events CASCADE");
  await wpool.query("TRUNCATE jobs, ledger_entries, allocations, refunds, refund_requests, payments, order_lines, orders RESTART IDENTITY CASCADE");
  await wapp?.stop().catch(() => {});
  wapp = createApp(wpool, workerProvider(process.env));
  await new Promise<void>((r) => wapp.server.listen(0, "127.0.0.1", () => r()));
  wbase = `http://127.0.0.1:${(wapp.server.address() as AddressInfo).port}`;
});

const call = async (base: string, path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Any };
};
let evn = 0;
const hook = (base: string, payload: string, o: { id?: string | null; sig?: string } = {}) =>
  call(base, "/webhooks/razorpay", payload, { "x-razorpay-signature": o.sig ?? rzpSign(payload), ...(o.id === null ? {} : { "x-razorpay-event-id": o.id ?? `ev_${++evn}` }) });
const iq = async (sql: string, p: unknown[] = []) => (await idbc.query(sql, p)).rows as Any[];
const wq = async (sql: string, p: unknown[] = []) => (await wc.query(sql, p)).rows as Any[];
const ibal = async (a: string) => BigInt((await iq("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE account=$1", [a]))[0].s);
const wbal = async (a: string) => BigInt((await wq("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE account=$1", [a]))[0].s);
const drain = async () => { while (await wapp.worker.runOnce()) { /* ready jobs */ } };
const due = () => wpool.query("UPDATE jobs SET run_after = now() WHERE state='queued'");
const balanced = async (q: typeof iq) => expect(await q("SELECT txn_id FROM ledger_entries GROUP BY txn_id, currency HAVING sum(amount)<>0")).toEqual([]);

async function newOrder(base: string, lines: [string, number][], capture = "automatic") {
  const r = await call(base, "/orders", { currency: "INR", capture, lines: lines.map(([s, a]) => ({ seller_id: s, amount: a })) });
  expect(r.status).toBe(201);
  return r.body as { id: string };
}

describe("razorpay + inline-marketplace", () => {
  const setup = async (lines: [string, number][] = [["seller_a", 1000], ["seller_b", 500]]) => {
    const order = await newOrder(ibase, lines);
    const co = await call(ibase, `/orders/${order.id}/checkout`);
    expect(co.status).toBe(200);
    const orderRef = String(co.body.payment_intent_id);
    return { order, orderRef };
  };
  const capture = async (orderRef: string) => {
    const pay = rz.pay(orderRef);
    const r = await hook(ibase, rzpEvent("payment.captured", { payment: pay }));
    expect(r.status).toBe(200);
    return pay;
  };

  it("creates one Razorpay order with the exact integer amount, currency and order identity", async () => {
    const { order, orderRef } = await setup();
    const o = rz.orders.get(orderRef);
    expect(o).toMatchObject({ amount: 1500, currency: "INR", receipt: order.id });
    expect(rz.count(/POST \/v1\/orders$/)).toBe(1);
    await call(ibase, `/orders/${order.id}/checkout`);
    expect(rz.count(/POST \/v1\/orders$/)).toBe(1);
  });
  it("books a capture once across captured/authorized snapshots, duplicate event ids and body-hash dedupe", async () => {
    const { order, orderRef } = await setup();
    const pay = await capture(orderRef);
    const cap = rzpEvent("payment.captured", { payment: pay });
    expect((await hook(ibase, cap, { id: "ev_same" })).status).toBe(200);
    expect((await hook(ibase, cap, { id: "ev_same" })).status).toBe(200);
    expect((await hook(ibase, cap, { id: null })).status).toBe(200);
    expect((await hook(ibase, cap, { id: null })).status).toBe(200);
    // payment.authorized arrives late with the authorised-time snapshot
    expect((await hook(ibase, rzpEvent("payment.authorized", { payment: { ...pay, status: "authorized", captured: false } }))).status).toBe(200);
    expect((await iq("SELECT count(*)::int c FROM ledger_entries WHERE kind IN ('sale','commission')"))[0].c).toBe(5);
    expect((await iq("SELECT status FROM orders"))[0].status).toBe("paid");
    expect(await ibal("provider:clearing")).toBe(1500n);
    await balanced(iq);
    expect(order.id).toBeTruthy();
  });
  it("rejects forged signatures and tampered bodies", async () => {
    const { orderRef } = await setup();
    const pay = rz.pay(orderRef);
    const body = rzpEvent("payment.captured", { payment: pay });
    expect((await hook(ibase, body, { sig: "00" })).status).toBe(400);
    expect((await hook(ibase, body, { sig: rzpSign(body, "other") })).status).toBe(400);
    expect((await hook(ibase, body.replace("1500", "1"), { sig: rzpSign(body) })).status).toBe(400);
    expect((await iq("SELECT 1 FROM ledger_entries")).length).toBe(0);
  });
  it("a failed attempt then a captured one: confirm books the captured payment exactly once", async () => {
    const { order, orderRef } = await setup();
    rz.pay(orderRef, "failed");
    rz.pay(orderRef, "captured");
    expect((await call(ibase, `/orders/${order.id}/confirm`)).body.status).toBe("paid");
    await call(ibase, `/orders/${order.id}/confirm`);
    expect((await iq("SELECT count(*)::int c FROM ledger_entries WHERE kind='sale'"))[0].c).toBe(3);
    expect(await ibal("provider:clearing")).toBe(1500n);
  });
  it("refund: idempotency header is the durable request id, INR minimum is local, partials and over-refund are bounded", async () => {
    const { order, orderRef } = await setup();
    const pay = await capture(orderRef);
    const l1 = `${order.id}_l1`;
    expect((await call(ibase, `/orders/${order.id}/refunds`, { line_id: l1, amount: 99 })).status).toBe(400);
    expect(rz.refundPosts.length).toBe(0);
    const r = await call(ibase, `/orders/${order.id}/refunds`, { line_id: l1, amount: 400 });
    expect(r.status).toBe(200);
    expect(rz.refundPosts[0]).toMatchObject({ paymentId: pay.id, amount: 400, key: r.body.refund_id });
    expect(rz.refundPosts[0]?.notes).toMatchObject({ refund_id: r.body.refund_id, line_id: l1, order_id: order.id });
    expect((await call(ibase, `/orders/${order.id}/refunds`, { line_id: l1, amount: 601 })).status).toBe(400);
    expect((await call(ibase, `/orders/${order.id}/refunds`, { line_id: l1, amount: 600 })).status).toBe(200);
    expect(rz.heldOn(pay.id)).toBe(1000);
    expect(await ibal("seller:seller_a")).toBe(-900n + 1000n);
    await balanced(iq);
  });
  it("refund response lost: never re-POSTed; the processed webhook links it once", async () => {
    const { order, orderRef } = await setup();
    const pay = await capture(orderRef);
    rz.faults.push({ match: /POST \/v1\/payments\/.*\/refund/, when: "after", status: 500 });
    const l1 = `${order.id}_l1`;
    expect((await call(ibase, `/orders/${order.id}/refunds`, { line_id: l1, amount: 700 })).status).toBe(502);
    await idbc.query("UPDATE refund_requests SET next_attempt_at = now() - interval '1 second'");
    await inl.recoverPendingRefunds();
    expect(rz.refundPosts.length).toBe(1);
    expect(rz.heldOn(pay.id)).toBe(700);
    const rf = [...rz.refunds.values()][0];
    expect((await hook(ibase, rzpEvent("refund.processed", { refund: rf, payment: pay }))).status).toBe(200);
    expect((await hook(ibase, rzpEvent("refund.processed", { refund: rf, payment: pay }))).status).toBe(200);
    const rows = await iq("SELECT origin, line_id, status FROM refunds");
    expect(rows).toEqual([{ origin: "api", line_id: l1, status: "succeeded" }]);
    expect(await ibal("provider:clearing")).toBe(800n);
    await balanced(iq);
  });
  it("provider-side over-refund refusal (dashboard refund unseen) releases the reservation and the dashboard refund is recorded", async () => {
    const { order, orderRef } = await setup();
    const pay = await capture(orderRef);
    const dash = rz.dashboardRefund(pay.id, 1500);
    expect((await call(ibase, `/orders/${order.id}/refunds`, { line_id: `${order.id}_l1`, amount: 200 })).status).toBe(409);
    expect((await iq("SELECT resolution FROM refund_requests"))[0].resolution).toBe("rejected");
    expect((await hook(ibase, rzpEvent("refund.processed", { refund: dash, payment: pay }))).status).toBe(200);
    expect((await iq("SELECT status FROM orders"))[0].status).toBe("refunded");
    expect(await ibal("platform:unallocated_refunds")).toBe(1500n);
    await balanced(iq);
  });
  it("refund.failed after a pending acceptance reverses once; a replayed processed event cannot revive it", async () => {
    const { order, orderRef } = await setup();
    const pay = await capture(orderRef);
    const r = await call(ibase, `/orders/${order.id}/refunds`, { line_id: `${order.id}_l1`, amount: 300 });
    expect(r.status).toBe(200);
    const rf = [...rz.refunds.values()][0];
    rf.status = "failed";
    for (const id of ["f1", "f1", "f2"]) expect((await hook(ibase, rzpEvent("refund.failed", { refund: rf, payment: pay }), { id })).status).toBe(200);
    expect((await hook(ibase, rzpEvent("refund.processed", { refund: { ...rf, status: "processed" }, payment: pay }))).status).toBe(200);
    expect((await iq("SELECT status FROM refunds"))[0].status).toBe("failed");
    expect((await iq("SELECT status FROM orders"))[0].status).toBe("paid");
    expect(await ibal("provider:clearing")).toBe(1500n);
    expect(await ibal("seller:seller_a")).toBe(-900n);
  });
  it("refunds on two orders stay on their own order and seller", async () => {
    const a = await setup([["seller_a", 1000]]);
    const b = await setup([["seller_b", 1000]]);
    const pa = await capture(a.orderRef);
    const pb = await capture(b.orderRef);
    expect((await call(ibase, `/orders/${a.order.id}/refunds`, { line_id: `${b.order.id}_l1`, amount: 200 })).status).toBe(404);
    expect((await call(ibase, `/orders/${a.order.id}/refunds`, { line_id: `${a.order.id}_l1`, amount: 200 })).status).toBe(200);
    const dash = rz.dashboardRefund(pb.id, 300);
    expect((await hook(ibase, rzpEvent("refund.processed", { refund: dash, payment: pb }))).status).toBe(200);
    const rows = await iq("SELECT order_id, amount::int a FROM refunds ORDER BY a");
    expect(rows).toEqual([{ order_id: a.order.id, a: 200 }, { order_id: b.order.id, a: 300 }]);
    expect(rz.heldOn(pa.id)).toBe(200);
    expect(await ibal("seller:seller_a")).toBe(-900n + 200n);
    expect(await ibal("seller:seller_b")).toBe(-900n);
  });
  it("manual capture: authorised is not money; capture response lost is recovered once", async () => {
    const order = await newOrder(ibase, [["seller_a", 600], ["seller_b", 400]], "manual");
    const orderRef = String((await call(ibase, `/orders/${order.id}/checkout`)).body.payment_intent_id);
    const pay = rz.pay(orderRef);
    expect(pay.status).toBe("authorized");
    expect((await hook(ibase, rzpEvent("payment.authorized", { payment: pay }))).status).toBe(200);
    expect((await iq("SELECT 1 FROM ledger_entries")).length).toBe(0);
    rz.faults.push({ match: /POST \/v1\/payments\/.*\/capture/, when: "after", status: 500 });
    expect((await call(ibase, `/orders/${order.id}/capture`)).status).toBe(502);
    expect((await hook(ibase, rzpEvent("payment.captured", { payment: rz.payments.get(pay.id) }))).status).toBe(200);
    // retrying capture on an already captured Razorpay payment is refused by the provider; only money state matters
    expect([200, 502]).toContain((await call(ibase, `/orders/${order.id}/capture`)).status);
    expect((await iq("SELECT status FROM orders"))[0].status).toBe("paid");
    expect((await iq("SELECT count(*)::int c FROM ledger_entries WHERE kind='sale'"))[0].c).toBe(3);
    expect(await ibal("provider:clearing")).toBe(1000n);
  });
});

describe("razorpay + worker-marketplace", () => {
  const setup = async (lines: [string, number][] = [["seller_a", 1000], ["seller_b", 500]]) => {
    const order = await newOrder(wbase, lines);
    const co = await call(wbase, `/orders/${order.id}/checkout`);
    expect(co.status).toBe(200);
    const orderRef = String(co.body.payment_ref);
    const pay = rz.pay(orderRef);
    expect((await hook(wbase, rzpEvent("payment.captured", { payment: pay }))).status).toBe(200);
    await drain();
    return { order, orderRef, pay };
  };
  it("books a capture once through jobs, dedupes event ids and body hashes, and rejects forged events", async () => {
    const { order, pay } = await setup();
    const cap = rzpEvent("payment.captured", { payment: pay });
    for (const o of [{ id: "same" }, { id: "same" }, { id: null }, { id: null }]) expect((await hook(wbase, cap, o)).status).toBe(200);
    expect((await hook(wbase, cap, { sig: "bad" })).status).toBe(400);
    await drain();
    expect((await wq("SELECT count(*)::int c FROM ledger_entries WHERE kind='sale'"))[0].c).toBe(3);
    expect((await wq("SELECT status FROM orders"))[0].status).toBe("paid");
    expect(await wbal("provider:clearing")).toBe(1500n);
    expect((await wq("SELECT count(*)::int c FROM jobs"))[0].c).toBe(3);
    await balanced(wq);
    expect(order.id).toBeTruthy();
  });
  it("refund POST carries the request id as idempotency key; min, over-refund and bound hold", async () => {
    const { order, pay } = await setup();
    const l1 = `${order.id}_l1`;
    expect((await call(wbase, `/orders/${order.id}/refunds`, { line_id: l1, amount: 99 })).status).toBe(400);
    expect(rz.refundPosts.length).toBe(0);
    const r = await call(wbase, `/orders/${order.id}/refunds`, { line_id: l1, amount: 400 });
    expect(r.status).toBe(200);
    expect(rz.refundPosts[0]).toMatchObject({ paymentId: pay.id, amount: 400, key: r.body.request_id });
    expect((await call(wbase, `/orders/${order.id}/refunds`, { line_id: l1, amount: 601 })).status).toBe(400);
    expect((await call(wbase, `/orders/${order.id}/refunds`, { line_id: l1, amount: 600 })).status).toBe(200);
    expect(rz.heldOn(pay.id)).toBe(1000);
    expect(await wbal("seller:seller_a")).toBe(-900n + 1000n);
    await balanced(wq);
  });
  it("refund response lost: 202, never re-POSTed through retries, linked by the exact processed event", async () => {
    const { order, pay } = await setup();
    rz.faults.push({ match: /POST \/v1\/payments\/.*\/refund/, when: "after", status: 503 });
    const r = await call(wbase, `/orders/${order.id}/refunds`, { line_id: `${order.id}_l1`, amount: 700 });
    expect(r.status).toBe(202);
    for (let i = 0; i < 9; i++) { await due(); await drain(); }
    expect(rz.refundPosts.length).toBe(1);
    const rf = [...rz.refunds.values()][0];
    expect((await hook(wbase, rzpEvent("refund.processed", { refund: rf, payment: pay }))).status).toBe(200);
    await drain();
    expect((await wq("SELECT state FROM refund_requests"))[0].state).toBe("sent");
    expect((await wq("SELECT origin, status FROM refunds"))).toEqual([{ origin: "shop", status: "succeeded" }]);
    expect(await wbal("provider:clearing")).toBe(800n);
    await balanced(wq);
  });
  it("dashboard refund is recorded against the right order; a failed attempt plus captured attempt are handled by the captured one", async () => {
    const order = await newOrder(wbase, [["seller_a", 1000]]);
    const orderRef = String((await call(wbase, `/orders/${order.id}/checkout`)).body.payment_ref);
    rz.pay(orderRef, "failed");
    const good = rz.pay(orderRef, "captured");
    expect((await call(wbase, `/orders/${order.id}/confirm`)).body.status).toBe("paid");
    const dash = rz.dashboardRefund(good.id, 250);
    expect((await hook(wbase, rzpEvent("refund.processed", { refund: dash, payment: good }))).status).toBe(200);
    await drain();
    expect((await wq("SELECT status FROM orders"))[0].status).toBe("partially_refunded");
    expect(await wbal("platform:unallocated_refunds")).toBe(250n);
    expect(await wbal("provider:clearing")).toBe(750n);
    await balanced(wq);
  });
});
