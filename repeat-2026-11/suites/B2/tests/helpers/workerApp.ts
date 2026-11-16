// QueueBazaar (worker marketplace) test rig: an in-process fake provider with idempotency keys, fault injection and
// call counters, a real database, the real HTTP app, and an explicitly drained job queue (no timing dependence).
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { expect } from "vitest";
import { createPool, type Db, migrate } from "../../worker-marketplace/src/db.ts";
import type { PaymentStatus, RefundStatus } from "../../worker-marketplace/src/money.ts";
import {
  type PaymentProvider,
  type PaymentSnapshot,
  ProviderError,
  providerFromEnv,
  type RefundSnapshot,
} from "../../worker-marketplace/src/provider.ts";
import { createApp } from "../../worker-marketplace/src/server.ts";
import { signStripe, stripeEvent, WHSEC } from "./fakeStripe.ts";
import { createTestDb } from "./pg.ts";

export type WFaultMode = "before_unknown" | "before_rejected" | "apply_then_unknown";
interface WPayment { status: PaymentStatus; amount: bigint; captured: bigint; currency: string; orderId: string }
interface WRefund { paymentRef: string; amount: bigint; currency: string; status: RefundStatus; requestId?: string | undefined }

export class FakeWorkerProvider implements PaymentProvider {
  readonly name = "stripe" as const;
  payments = new Map<string, WPayment>();
  refunds = new Map<string, WRefund>();
  idem = new Map<string, string>();
  calls = { createPayment: 0, capture: 0, createRefund: 0, retrievePayment: 0, retrieveRefund: 0 };
  faults: { op: keyof FakeWorkerProvider["calls"]; mode: WFaultMode; times: number }[] = [];
  newRefundStatus: RefundStatus = "succeeded";
  /** amount the provider actually captures (default: full authorised amount) */
  captureOverride: bigint | undefined;
  refundRequestError?: (amount: bigint, currency: string) => string | undefined;
  private n = 0;
  readonly real = providerFromEnv({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: WHSEC });

  reset() {
    this.payments.clear();
    this.refunds.clear();
    this.idem.clear();
    this.faults.length = 0;
    this.newRefundStatus = "succeeded";
    this.captureOverride = undefined;
    for (const k of Object.keys(this.calls)) (this.calls as Record<string, number>)[k] = 0;
    delete this.refundRequestError;
  }
  fault(op: keyof FakeWorkerProvider["calls"], mode: WFaultMode, times = 1) {
    this.faults.push({ op, mode, times });
  }
  private async run<T>(op: keyof FakeWorkerProvider["calls"], apply: () => T): Promise<T> {
    this.calls[op]++;
    const f = this.faults.find((x) => x.op === op && x.times > 0);
    if (f) f.times--;
    if (f?.mode === "before_unknown") throw new ProviderError("unknown", 500, `${op}: 500 boom (nothing applied)`);
    if (f?.mode === "before_rejected") throw new ProviderError("rejected", 400, `${op}: 400 rejected`);
    const out = apply();
    if (f?.mode === "apply_then_unknown") throw new ProviderError("unknown", undefined, `${op}: socket hang up`);
    return out;
  }
  pay0(ref: string): PaymentSnapshot {
    const p = this.payments.get(ref);
    if (!p) throw new ProviderError("rejected", 404, "no such payment");
    return { ref, status: p.status, amount: p.amount, amountCaptured: p.captured, currency: p.currency, orderId: p.orderId, clientSecret: `${ref}_s` };
  }
  ref0(ref: string): RefundSnapshot {
    const r = this.refunds.get(ref);
    if (!r) throw new ProviderError("rejected", 404, "no such refund");
    return { ref, paymentRef: r.paymentRef, amount: r.amount, currency: r.currency, status: r.status, requestId: r.requestId };
  }
  liveRefunded(pi: string): bigint {
    let s = 0n;
    for (const r of this.refunds.values())
      if (r.paymentRef === pi && ["pending", "requires_action", "succeeded"].includes(r.status)) s += r.amount;
    return s;
  }
  createPayment(p: { orderId: string; amount: bigint; currency: string; capture: "automatic" | "manual" }) {
    return this.run("createPayment", () => {
      const key = `checkout_${p.orderId}`;
      let ref = this.idem.get(key);
      if (!ref) {
        ref = `pi_${++this.n}`;
        this.idem.set(key, ref);
        this.payments.set(ref, { status: "pending", amount: p.amount, captured: 0n, currency: p.currency, orderId: p.orderId });
      }
      return this.pay0(ref);
    });
  }
  async retrievePayment(ref: string) {
    this.calls.retrievePayment++;
    return this.pay0(ref);
  }
  capture(ref: string) {
    return this.run("capture", () => {
      const p = this.payments.get(ref);
      if (p?.status === "requires_capture") Object.assign(p, { status: "succeeded", captured: this.captureOverride ?? p.amount });
      return this.pay0(ref);
    });
  }
  createRefund(paymentRef: string, p: { amount: bigint; idempotencyKey: string; metadata: Record<string, string> }) {
    return this.run("createRefund", () => {
      let ref = this.idem.get(p.idempotencyKey);
      if (!ref) {
        const pay = this.payments.get(paymentRef);
        if (pay?.status !== "succeeded") throw new ProviderError("rejected", 400, "payment not captured");
        if (p.amount > pay.captured - this.liveRefunded(paymentRef)) throw new ProviderError("rejected", 400, "amount too large");
        ref = `re_${++this.n}`;
        this.idem.set(p.idempotencyKey, ref);
        this.refunds.set(ref, { paymentRef, amount: p.amount, currency: pay.currency, status: this.newRefundStatus, requestId: p.metadata.refund_request_id });
      }
      return this.ref0(ref);
    });
  }
  async retrieveRefund(ref: string) {
    this.calls.retrieveRefund++;
    return this.ref0(ref);
  }
  parseWebhook(raw: string, headers: http.IncomingHttpHeaders) {
    return this.real.parseWebhook(raw, headers);
  }
  // ---- the customer and the dashboard
  pay(ref: string, captured?: bigint) {
    const p = this.payments.get(ref) as WPayment;
    Object.assign(p, { status: "succeeded", captured: captured ?? p.amount });
  }
  authorize(ref: string) {
    (this.payments.get(ref) as WPayment).status = "requires_capture";
  }
  /** a second, independent provider payment for the same order (a retried checkout that also got paid) */
  extraPayment(orderId: string, amount: bigint, currency = "INR"): string {
    const ref = `pi_extra_${++this.n}`;
    this.payments.set(ref, { status: "succeeded", amount, captured: amount, currency, orderId });
    return ref;
  }
  dashboardRefund(pi: string, amount: bigint, status: RefundStatus = "succeeded"): string {
    const ref = `re_dash_${++this.n}`;
    this.refunds.set(ref, { paymentRef: pi, amount, currency: (this.payments.get(pi) as WPayment).currency, status });
    return ref;
  }
  setRefund(ref: string, status: RefundStatus) {
    (this.refunds.get(ref) as WRefund).status = status;
  }
}

export async function startWorker() {
  const tdb = await createTestDb("wrk");
  const db: Db = createPool(tdb.url);
  await migrate(db);
  const fake = new FakeWorkerProvider();
  const app = createApp(db, fake);
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await r.text();
    let parsed: Record<string, any> = {};
    try { parsed = JSON.parse(text); } catch {}
    return { status: r.status, body: parsed };
  };
  let evn = 0;
  const hook = (event: Record<string, any>) => {
    const s = signStripe(event);
    return post("/webhooks/stripe", s.payload, { "stripe-signature": s.header });
  };
  const payEvent = (ref: string, id = `evt_p_${++evn}`) => stripeEvent(id, "payment_intent.succeeded", { id: ref, object: "payment_intent" });
  const refundEv = (ref: string, pi: string, id = `evt_r_${++evn}`, type = "refund.updated") => stripeEvent(id, type, { id: ref, object: "refund", payment_intent: pi });
  const drain = async () => {
    let n = 0;
    while (await app.worker.runOnce()) n++;
    return n;
  };
  const forceDue = () => db.query("UPDATE jobs SET run_after = now() WHERE state = 'queued'");
  /** drain, forcing backed-off retries due, a bounded number of rounds */
  const settle = async (rounds = 3) => {
    for (let i = 0; i < rounds; i++) {
      await forceDue();
      await drain();
    }
  };
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const newOrder = async (
    lines: { seller_id: string; amount: number | string }[] = [
      { seller_id: "seller_a", amount: 600 },
      { seller_id: "seller_b", amount: 400 },
    ],
    capture: "automatic" | "manual" = "automatic",
    currency = "INR",
  ) => {
    const o = await post("/orders", { buyer: "b", currency, lines, capture });
    if (o.status !== 201) throw new Error(`order ${o.status} ${JSON.stringify(o.body)}`);
    return o.body as { id: string; total: string; lines: string[] };
  };
  const checkedOut = async (...a: Parameters<typeof newOrder>) => {
    const order = await newOrder(...a);
    const co = await post(`/orders/${order.id}/checkout`);
    if (co.status !== 200) throw new Error(`checkout ${co.status} ${JSON.stringify(co.body)}`);
    return { order, pi: String(co.body.payment_ref) };
  };
  /** customer pays, signed notice delivered, queue drained */
  const paidOrder = async (...a: Parameters<typeof newOrder>) => {
    const x = await checkedOut(...a);
    fake.pay(x.pi);
    expect((await hook(payEvent(x.pi))).status).toBe(200);
    await drain();
    return x;
  };
  const refund = (orderId: string, lineId: string, amount: unknown) => post(`/orders/${orderId}/refunds`, { line_id: lineId, amount });
  const status = async (id: string) => (await one("SELECT status FROM orders WHERE id=$1", [id])).status as string;
  const reset = async () => {
    await app.worker.stop();
    await db.query("TRUNCATE jobs, ledger_entries, allocations, refunds, refund_requests, payments, order_lines, orders RESTART IDENTITY CASCADE");
    fake.reset();
  };
  const stop = async () => {
    await app.stop();
    await db.end();
    await tdb.drop();
  };
  return { db, fake, app, post, hook, payEvent, refundEv, drain, forceDue, settle, one, newOrder, checkedOut, paidOrder, refund, status, reset, stop };
}
export type Worker = Awaited<ReturnType<typeof startWorker>>;
