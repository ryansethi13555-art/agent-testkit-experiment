// A provider "world": the true Stripe-like state (payments, refunds, idempotency keys) with fault injection.
// Both apps are tested against the world's state, never against their own HTTP answers.
import Stripe from "stripe";

export const WHSEC = "whsec_test_payments_suite";

export class WorldError extends Error {
  readonly status: number | undefined;
  readonly kind: "http" | "network";
  readonly code: string | undefined;
  constructor(kind: "http" | "network", status: number | undefined, message: string, code?: string) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

export type PiStatus = "requires_payment_method" | "requires_capture" | "succeeded" | "canceled";
export type RStatus = "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
export interface WPayment {
  id: string;
  orderId: string;
  amount: bigint;
  currency: string; // upper
  capture: "automatic" | "manual";
  status: PiStatus;
  received: bigint;
}
export interface WRefund {
  id: string;
  paymentRef: string;
  amount: bigint;
  currency: string;
  status: RStatus;
  metadata: Record<string, string>;
}
export type Op = "createPayment" | "capture" | "refund" | "retrieveRefund" | "retrievePayment";
/** before: fail without applying; after: apply, then fail the response (lost/5xx/timeout). */
export interface Fault {
  op: Op;
  when: "before" | "after";
  status?: number; // undefined = network error
  code?: string;
  type?: string;
}

export const holds = (s: RStatus) => s === "pending" || s === "requires_action" || s === "succeeded";

export class World {
  payments = new Map<string, WPayment>();
  refunds = new Map<string, WRefund>();
  idem = new Map<string, { op: string; ref: string; snap: unknown }>();
  faults: Fault[] = [];
  calls: { op: Op; key?: string | undefined; amount?: bigint | undefined }[] = [];
  n = 0;
  /** artificial latency (ms) per op so concurrent callers genuinely overlap */
  delay: Partial<Record<Op, number>> = {};
  /** new refunds start in this status */
  newRefundStatus: RStatus = "succeeded";

  reset() {
    this.payments.clear();
    this.refunds.clear();
    this.idem.clear();
    this.faults = [];
    this.calls = [];
    this.n = 0;
    this.delay = {};
    this.newRefundStatus = "succeeded";
  }
  count(op: Op) {
    return this.calls.filter((c) => c.op === op).length;
  }
  failNext(f: Fault) {
    this.faults.push(f);
  }
  async #enter(op: Op, key?: string, amount?: bigint): Promise<Fault | undefined> {
    this.calls.push({ op, key, amount });
    const d = this.delay[op];
    if (d) await new Promise((r) => setTimeout(r, d));
    const i = this.faults.findIndex((f) => f.op === op);
    return i >= 0 ? this.faults.splice(i, 1)[0] : undefined;
  }
  #fail(f: Fault): never {
    if (f.status === undefined) throw new WorldError("network", undefined, "socket hang up");
    throw new WorldError("http", f.status, `injected ${f.status}`, f.code);
  }
  /** Stripe-style: idempotency key replays the first result (including its then-current snapshot). */
  expireIdempotency() {
    this.idem.clear();
  }

  async createPayment(p: { orderId: string; amount: bigint; currency: string; capture: "automatic" | "manual" }) {
    const f = await this.#enter("createPayment");
    if (f?.when === "before") this.#fail(f);
    const key = `checkout_${p.orderId}`;
    let hit = this.idem.get(key);
    if (!hit) {
      const id = `pi_${++this.n}`;
      this.payments.set(id, {
        id,
        orderId: p.orderId,
        amount: p.amount,
        currency: p.currency.toUpperCase(),
        capture: p.capture,
        status: "requires_payment_method",
        received: 0n,
      });
      hit = { op: "createPayment", ref: id, snap: undefined };
      this.idem.set(key, hit);
    }
    if (f?.when === "after") this.#fail(f);
    return this.payments.get(hit.ref) as WPayment;
  }
  payment(ref: string): WPayment {
    const p = this.payments.get(ref);
    if (!p) throw new WorldError("http", 404, "no such payment");
    return p;
  }
  async retrievePayment(ref: string) {
    const f = await this.#enter("retrievePayment");
    if (f) this.#fail(f);
    return this.payment(ref);
  }
  /** The customer completes payment at the provider (automatic: captured; manual: authorised). */
  customerPays(ref: string) {
    const p = this.payment(ref);
    if (p.status !== "requires_payment_method") return;
    if (p.capture === "automatic") Object.assign(p, { status: "succeeded", received: p.amount });
    else p.status = "requires_capture";
  }
  async capture(ref: string, key: string, amount?: bigint) {
    const f = await this.#enter("capture", key, amount);
    if (f?.when === "before") this.#fail(f);
    const p = this.payment(ref);
    const hit = this.idem.get(key);
    if (!hit) {
      if (p.status !== "requires_capture") throw new WorldError("http", 400, "not capturable", "payment_intent_unexpected_state");
      const amt = amount ?? p.amount;
      Object.assign(p, { status: "succeeded", received: amt });
      this.idem.set(key, { op: "capture", ref, snap: undefined });
    }
    if (f?.when === "after") this.#fail(f);
    return p;
  }
  async createRefund(paymentRef: string, a: { amount: bigint; key: string; metadata: Record<string, string> }) {
    const f = await this.#enter("refund", a.key, a.amount);
    if (f?.when === "before") this.#fail(f);
    const hit = this.idem.get(a.key);
    let r: WRefund;
    if (hit) {
      r = this.refunds.get(hit.ref) as WRefund;
      // replay returns the ORIGINAL response (stale status)
      r = { ...r, status: (hit.snap as RStatus) ?? r.status };
    } else {
      const p = this.payment(paymentRef);
      if (p.status !== "succeeded") throw new WorldError("http", 400, "not captured", "charge_not_refundable");
      const used = this.heldOn(paymentRef);
      if (a.amount > p.received - used)
        throw new WorldError("http", 400, "Refund amount exceeds remaining", "amount_too_large");
      const id = `re_${++this.n}`;
      const real: WRefund = {
        id,
        paymentRef,
        amount: a.amount,
        currency: p.currency,
        status: this.newRefundStatus,
        metadata: { ...a.metadata },
      };
      this.refunds.set(id, real);
      this.idem.set(a.key, { op: "refund", ref: id, snap: this.newRefundStatus });
      r = { ...real };
    }
    if (f?.when === "after") this.#fail(f);
    return r;
  }
  heldOn(paymentRef: string): bigint {
    let s = 0n;
    for (const r of this.refunds.values()) if (r.paymentRef === paymentRef && holds(r.status)) s += r.amount;
    return s;
  }
  async retrieveRefund(ref: string) {
    const f = await this.#enter("retrieveRefund");
    if (f) this.#fail(f);
    const r = this.refunds.get(ref);
    if (!r) throw new WorldError("http", 404, "no such refund");
    return r;
  }
  /** Out-of-band (dashboard) refund. */
  dashboardRefund(paymentRef: string, amount: bigint, status: RStatus = "succeeded"): WRefund {
    const p = this.payment(paymentRef);
    if (amount > p.received - this.heldOn(paymentRef)) throw new Error("test bug: dashboard over-refund");
    const id = `re_${++this.n}`;
    const r: WRefund = { id, paymentRef, amount, currency: p.currency, status, metadata: {} };
    this.refunds.set(id, r);
    return r;
  }
  setRefundStatus(ref: string, status: RStatus) {
    const r = this.refunds.get(ref);
    if (!r) throw new Error("no refund");
    r.status = status;
  }
}

// ---- Stripe wire objects and signed events ------------------------------------------------------------------
export const piObject = (p: WPayment) => ({
  id: p.id,
  object: "payment_intent",
  amount: Number(p.amount),
  amount_received: Number(p.received),
  currency: p.currency.toLowerCase(),
  status: p.status,
  metadata: { order_id: p.orderId },
  client_secret: `${p.id}_secret`,
  last_payment_error: null,
});
export const refundObject = (r: WRefund, status: RStatus = r.status) => ({
  id: r.id,
  object: "refund",
  amount: Number(r.amount),
  currency: r.currency.toLowerCase(),
  status,
  payment_intent: r.paymentRef,
  metadata: r.metadata,
});
let evn = 0;
export const newEventId = () => `evt_${++evn}_${Math.random().toString(36).slice(2, 8)}`;
export const event = (type: string, object: unknown, id = newEventId()) => ({
  id,
  object: "event",
  type,
  data: { object },
});
export function sign(ev: object, opts: { secret?: string; timestamp?: number } = {}) {
  const payload = JSON.stringify(ev);
  const header = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: opts.secret ?? WHSEC,
    ...(opts.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
  });
  return { payload, header };
}
