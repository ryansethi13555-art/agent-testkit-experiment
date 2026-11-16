// End to end through the REAL Stripe SDK adapter of the inline marketplace, against a fake Stripe HTTP API that
// replays idempotency keys, applies effects and then returns 500 / 429, rejects oversize refunds, etc.
import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, expectedFee, sleep } from "./helpers/db.ts";

const WHSEC = "whsec_wire_suite";
type Obj = Record<string, any>;
const pis = new Map<string, Obj>();
const refunds = new Map<string, Obj>();
const idem = new Map<string, { status: number; body: Obj }>();
const seen: { method: string; url: string; key: string | undefined; form: Record<string, string> }[] = [];
let n = 0;
const mode: { refund?: "apply500" | "rate429" | "toolarge" | "applyThenReset"; refundStatus: string } = { refundStatus: "succeeded" };

const live = (pi: string) => [...refunds.values()].filter((r) => r.payment_intent === pi && ["pending", "requires_action", "succeeded"].includes(r.status)).reduce((s, r) => s + r.amount, 0);
const fakeStripe = http.createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const form = Object.fromEntries(new URLSearchParams(raw));
  const url = req.url ?? "";
  const key = req.headers["idempotency-key"] as string | undefined;
  seen.push({ method: req.method ?? "", url, key, form });
  const send = (status: number, body: Obj) => {
    res.writeHead(status, { "content-type": "application/json", "request-id": `req_${++n}` });
    res.end(JSON.stringify(body));
  };
  if (req.method === "POST" && key && idem.has(key)) {
    const r = idem.get(key)!;
    return send(r.status, r.body);
  }
  const remember = (status: number, body: Obj) => {
    if (key) idem.set(key, { status, body });
    send(status, body);
  };
  if (url === "/v1/payment_intents" && req.method === "POST") {
    const id = `pi_w${++n}`;
    const pi = { id, object: "payment_intent", amount: Number(form.amount), amount_received: 0, currency: form.currency, capture_method: form.capture_method, status: "requires_payment_method", client_secret: `${id}_s`, metadata: { order_id: form["metadata[order_id]"] }, last_payment_error: null };
    pis.set(id, pi);
    return remember(200, pi);
  }
  let m = /^\/v1\/payment_intents\/(\w+)(\/capture)?$/.exec(url);
  if (m) {
    const pi = pis.get(m[1]!);
    if (!pi) return send(404, { error: { type: "invalid_request_error", message: "no such payment_intent" } });
    if (m[2] && req.method === "POST") {
      if (pi.status === "requires_capture") Object.assign(pi, { status: "succeeded", amount_received: pi.amount });
      return remember(200, pi);
    }
    return send(200, pi);
  }
  if (url === "/v1/refunds" && req.method === "POST") {
    const mode1 = mode.refund;
    mode.refund = undefined;
    if (mode1 === "rate429") return send(429, { error: { type: "rate_limit_error", message: "Too many requests" } });
    const pi = pis.get(form.payment_intent ?? "");
    const amount = Number(form.amount);
    if (mode1 === "toolarge" || !pi || amount > pi.amount_received - live(pi.id))
      return send(400, { error: { type: "invalid_request_error", code: "amount_too_large", message: "Refund amount is greater than unrefunded amount on charge" } });
    const r = { id: `re_w${++n}`, object: "refund", amount, currency: pi.currency, status: mode.refundStatus, payment_intent: pi.id, metadata: { order_id: form["metadata[order_id]"], line_id: form["metadata[line_id]"], refund_id: form["metadata[refund_id]"] } };
    refunds.set(r.id, r);
    mode.refundStatus = "succeeded";
    if (mode1 === "apply500") return remember(500, { error: { type: "api_error", message: "Something went wrong on Stripe's end" } });
    if (mode1 === "applyThenReset") return req.socket.destroy();
    return remember(200, r);
  }
  m = /^\/v1\/refunds\/(\w+)$/.exec(url);
  if (m && req.method === "GET") {
    const r = refunds.get(m[1]!);
    return r ? send(200, r) : send(404, { error: { type: "invalid_request_error", message: "no such refund" } });
  }
  send(404, { error: { type: "invalid_request_error", message: `unexpected ${req.method} ${url}` } });
});

let testDb: Awaited<ReturnType<typeof createDb>>;
let app: typeof import("../inline-marketplace/src/server.ts");
let db: pg.Client;
let base = "";
beforeAll(async () => {
  testDb = await createDb("wire");
  await new Promise<void>((r) => fakeStripe.listen(0, "127.0.0.1", () => r()));
  process.env.DATABASE_URL = testDb.url;
  process.env.PAYMENT_PROVIDER = "stripe";
  process.env.STRIPE_SECRET_KEY = "sk_test_wire";
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
  process.env.MONEYINV_STRIPE_API_BASE = `http://127.0.0.1:${(fakeStripe.address() as AddressInfo).port}`;
  app = await import("../inline-marketplace/src/server.ts");
  await app.migrate();
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  db = new pg.Client({ connectionString: testDb.url });
  await db.connect();
});
afterAll(async () => {
  await db?.end();
  await app?.stop();
  await new Promise<void>((r) => fakeStripe.close(() => r()));
  fakeStripe.closeAllConnections?.();
  await testDb?.drop();
});
beforeEach(async () => {
  pis.clear();
  refunds.clear();
  idem.clear();
  seen.length = 0;
  mode.refund = undefined;
  mode.refundStatus = "succeeded";
  await db.query("TRUNCATE orders, order_lines, refunds, refund_requests, ledger_entries, processed_events CASCADE");
});

const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Obj };
};
const hook = async (type: string, object: Obj, id = `evt_${++n}`, timestamp?: number) => {
  const payload = JSON.stringify({ id, object: "event", type, data: { object } });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC, ...(timestamp ? { timestamp } : {}) });
  return post("/webhooks/stripe", payload, { "stripe-signature": signature });
};
const rows = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as any[];
const big = async (sql: string) => BigInt((await rows(sql))[0].v);
const posts = (url: string) => seen.filter((s) => s.method === "POST" && s.url === url);
async function paid(lines: [string, number][] = [["seller_a", 600], ["seller_b", 400]], extra: Obj = {}) {
  const o = await post("/orders", { currency: "INR", lines: lines.map(([s, a]) => ({ seller_id: s, amount: a })), ...extra });
  const ref = String((await post(`/orders/${o.body.id}/checkout`, {})).body.payment_intent_id);
  const pi = pis.get(ref)!;
  if (extra.capture === "manual") pi.status = "requires_capture";
  else Object.assign(pi, { status: "succeeded", amount_received: pi.amount });
  if (extra.capture !== "manual") expect((await hook("payment_intent.succeeded", pi)).status).toBe(200);
  return { id: o.body.id as string, lines: o.body.lines as string[], ref };
}
const soundness = async () => {
  expect(await rows("SELECT txn_id FROM ledger_entries GROUP BY txn_id, currency HAVING sum(amount)<>0")).toEqual([]);
  const sold = await big("SELECT coalesce(sum(total),0)::text v FROM orders WHERE status IN ('paid','partially_refunded','refunded')");
  const out = await big("SELECT coalesce(sum(amount),0)::text v FROM refunds WHERE booked AND status IN ('pending','requires_action','succeeded')");
  expect(await big("SELECT coalesce(sum(amount),0)::text v FROM ledger_entries WHERE account='provider:clearing'")).toBe(sold - out);
};

describe("inline marketplace through the real Stripe adapter", () => {
  it("creates exactly one PaymentIntent per order with minor-unit amount, lowercase currency, order metadata and a stable idempotency key", async () => {
    const o = await post("/orders", { currency: "INR", lines: [{ seller_id: "seller_a", amount: 12345 }] });
    await Promise.all(Array.from({ length: 8 }, () => post(`/orders/${o.body.id}/checkout`, {})));
    const creates = posts("/v1/payment_intents");
    expect(creates).toHaveLength(1);
    expect(creates[0]!.form).toMatchObject({ amount: "12345", currency: "inr", "metadata[order_id]": o.body.id });
    expect(creates[0]!.key).toBe(`checkout_${o.body.id}`);
  });

  it("verifies webhook signatures (forged, unsigned, expired) and books a duplicated delivery once", async () => {
    const o = await post("/orders", { currency: "INR", lines: [{ seller_id: "seller_a", amount: 600 }, { seller_id: "seller_b", amount: 400 }] });
    const ref = String((await post(`/orders/${o.body.id}/checkout`, {})).body.payment_intent_id);
    Object.assign(pis.get(ref)!, { status: "succeeded", amount_received: 1000 });
    const body = { id: "evt_fixed", object: "event", type: "payment_intent.succeeded", data: { object: pis.get(ref) } };
    const payload = JSON.stringify(body);
    expect((await post("/webhooks/stripe", payload, { "stripe-signature": "t=1,v1=abc" })).status).toBe(400);
    expect((await post("/webhooks/stripe", payload)).status).toBe(400);
    expect((await hook("payment_intent.succeeded", pis.get(ref)!, "evt_old", Math.floor(Date.now() / 1000) - 7200)).status).toBe(400);
    expect((await post("/webhooks/stripe", payload, { "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_forged" }) })).status).toBe(400);
    expect(await rows("SELECT 1 FROM ledger_entries")).toHaveLength(0);
    const sig = { "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC }) };
    const rs = await Promise.all(Array.from({ length: 8 }, () => post("/webhooks/stripe", payload, sig)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(await rows("SELECT 1 FROM ledger_entries WHERE kind='sale' AND account='provider:clearing'")).toHaveLength(1);
    expect(await big("SELECT amount::text v FROM ledger_entries WHERE account='seller:seller_a'")).toBe(-540n);
    await soundness();
  });

  it("a payment webhook whose amount_received differs from the order total books nothing", async () => {
    const o = await post("/orders", { currency: "INR", lines: [{ seller_id: "seller_a", amount: 1000 }] });
    const ref = String((await post(`/orders/${o.body.id}/checkout`, {})).body.payment_intent_id);
    Object.assign(pis.get(ref)!, { status: "succeeded", amount_received: 999 });
    expect((await hook("payment_intent.succeeded", pis.get(ref)!)).status).not.toBe(200);
    expect(await rows("SELECT 1 FROM ledger_entries")).toHaveLength(0);
  });

  it("manual capture sends one idempotent capture per order; concurrent calls book once", async () => {
    const o = await paid([["seller_a", 1000]], { capture: "manual" });
    const rs = await Promise.all(Array.from({ length: 5 }, () => post(`/orders/${o.id}/capture`, {})));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(new Set(posts(`/v1/payment_intents/${o.ref}/capture`).map((p) => p.key))).toEqual(new Set([`capture_${o.id}`]));
    expect(await rows("SELECT 1 FROM ledger_entries WHERE kind='sale' AND account='provider:clearing'")).toHaveLength(1);
    await soundness();
  });

  it("refund POST carries the request id as idempotency key and metadata, and an exact integer amount", async () => {
    const o = await paid([["seller_a", 1000]]);
    const r = await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 250 });
    expect(r.status).toBe(200);
    const sent = posts("/v1/refunds");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.form).toMatchObject({ payment_intent: o.ref, amount: "250", "metadata[order_id]": o.id, "metadata[line_id]": o.lines[0], "metadata[refund_id]": r.body.refund_id });
    expect(sent[0]!.key).toBe(r.body.refund_id);
    await soundness();
  });

  it("a refund applied by Stripe but answered 500 is never reposted; the signed webhook later books it once", async () => {
    const o = await paid([["seller_a", 1000]]);
    mode.refund = "apply500";
    const r = await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 600 });
    expect(r.status).toBe(502);
    expect(refunds.size).toBe(1);
    await sleep(1800); // background recovery runs every 500 ms; it must not repost
    expect(posts("/v1/refunds")).toHaveLength(1);
    expect(await rows("SELECT 1 FROM ledger_entries WHERE kind='refund'")).toHaveLength(0);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 401 })).status).toBe(400);
    const stripeRefund = [...refunds.values()][0]!;
    for (let i = 0; i < 3; i++) expect((await hook("refund.created", stripeRefund)).status).toBe(200);
    expect(await rows("SELECT 1 FROM ledger_entries WHERE kind='refund'")).toHaveLength(2);
    expect(await rows("SELECT 1 FROM refunds")).toHaveLength(1);
    expect(await rows("SELECT 1 FROM refund_requests WHERE NOT resolved")).toHaveLength(0);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 400 })).status).toBe(200);
    await soundness();
  });

  it("a connection dropped after Stripe applied the refund is treated as unknown, not as failure", async () => {
    const o = await paid([["seller_a", 1000]]);
    mode.refund = "applyThenReset";
    const r = await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 500 });
    expect(r.status).toBe(502);
    await sleep(1500);
    expect(posts("/v1/refunds")).toHaveLength(1);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 501 })).status).toBe(400);
    expect((await hook("refund.created", [...refunds.values()][0]!)).status).toBe(200);
    expect(await big("SELECT coalesce(sum(amount),0)::text v FROM ledger_entries WHERE account='seller:seller_a'")).toBe(-900n + 500n);
    await soundness();
  });

  it("a 429 (rejected before execution) releases the reservation; the retry succeeds and refunds exactly once", async () => {
    const o = await paid([["seller_a", 1000]]);
    mode.refund = "rate429";
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 1000 })).status).toBe(409);
    expect(refunds.size).toBe(0);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 1000 })).status).toBe(200);
    expect(refunds.size).toBe(1);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 1 })).status).toBe(409); // fully refunded: order no longer refundable
    await soundness();
  });

  it("Stripe's amount_too_large rejection releases the reservation and books nothing", async () => {
    const o = await paid([["seller_a", 1000]]);
    refunds.set("re_dash", { id: "re_dash", object: "refund", amount: 900, currency: "inr", status: "succeeded", payment_intent: o.ref, metadata: {} }); // refunded outside the app
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 500 })).status).toBe(409);
    expect(await rows("SELECT 1 FROM ledger_entries WHERE kind='refund'")).toHaveLength(0);
    expect(await rows("SELECT resolution FROM refund_requests")).toEqual([{ resolution: "rejected" }]);
    // the dashboard refund arrives later and is recorded against the order, not the line
    expect((await hook("refund.created", refunds.get("re_dash")!)).status).toBe(200);
    expect(await big("SELECT coalesce(sum(amount),0)::text v FROM ledger_entries WHERE account='platform:unallocated_refunds'")).toBe(900n);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 101 })).status).toBe(400);
    await soundness();
  });

  it("pending refund then failure: the event body is not trusted, the retrieved refund is; reversal posted once", async () => {
    const o = await paid([["seller_a", 1000]]);
    mode.refundStatus = "pending";
    const r = await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 700 });
    expect(r.body.status).toBe("pending");
    const re = refunds.get(r.body.provider_refund_id)!;
    const staleBody = { ...re }; // still says pending
    re.status = "failed";
    for (let i = 0; i < 3; i++) expect((await hook("refund.updated", staleBody)).status).toBe(200);
    expect(await rows("SELECT status FROM refunds")).toEqual([{ status: "failed" }]);
    expect(await rows("SELECT 1 FROM ledger_entries WHERE kind='refund_reversal'")).toHaveLength(2);
    expect(await big("SELECT coalesce(sum(amount),0)::text v FROM ledger_entries WHERE account='provider:clearing'")).toBe(1000n);
    expect(await rows("SELECT status FROM orders WHERE id=$1", [o.id])).toEqual([{ status: "paid" }]);
    await soundness();
  });

  it("commission on the wire path rounds half to even per line", async () => {
    const amounts = [15, 25, 35, 45];
    const o = await paid(amounts.map((a) => ["seller_a", a] as [string, number]));
    for (const [i, a] of amounts.entries())
      expect(await big(`SELECT coalesce(sum(-amount),0)::text v FROM ledger_entries WHERE account='platform:revenue:${o.lines[i]}'`)).toBe(expectedFee(BigInt(a)));
    await soundness();
  });
});
