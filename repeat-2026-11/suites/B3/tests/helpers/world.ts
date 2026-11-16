// A stateful in-memory payment provider ("the world") shared by the test suites of both apps.
// It models payments, captures and refunds with idempotency keys, and supports fault injection around every call:
//   before5xx: fails without applying; reject: definitive 4xx without applying; rate429: rate limited, not applied;
//   lost: applies the effect, then fails with an unknown outcome (timeout / 5xx after commit).
// Money laws are asserted against this world's true state, never against HTTP responses.
import Stripe from "stripe";

export type PayStatus = "pending" | "requires_capture" | "succeeded" | "canceled" | "failed";
export type RefStatus = "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
export interface WPayment {
  ref: string;
  orderId: string;
  amount: bigint;
  currency: string;
  capture: "automatic" | "manual";
  status: PayStatus;
  captured: bigint;
}
export interface WRefund {
  ref: string;
  paymentRef: string;
  amount: bigint;
  currency: string;
  status: RefStatus;
  metadata: Record<string, string>;
}
export type Op = "createPayment" | "capture" | "createRefund" | "retrievePayment" | "retrieveRefund";
export type FaultKind = "before5xx" | "reject" | "rate429" | "lost";

export class FakeError extends Error {
  readonly kind: "unknown" | "rejected";
  readonly status: number | undefined;
  readonly definitive: string | undefined;
  constructor(kind: "unknown" | "rejected", status: number | undefined, message: string, definitive?: string) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.definitive = definitive;
  }
}

export const holdsMoney = (s: RefStatus) => s === "pending" || s === "requires_action" || s === "succeeded";

export class World {
  payments = new Map<string, WPayment>();
  refunds = new Map<string, WRefund>();
  idem = new Map<string, string>();
  faults: Partial<Record<Op, FaultKind[]>> = {};
  /** Optional async gates run at the start of an op (for deterministic rendezvous). */
  gates: Partial<Record<Op, () => Promise<void>>> = {};
  calls: { op: Op; args: unknown }[] = [];
  n = 0;
  /** Status given to newly created API refunds. */
  newRefundStatus: RefStatus = "succeeded";

  count(op: Op): number {
    return this.calls.filter((c) => c.op === op).length;
  }
  fault(op: Op, kind: FaultKind, times = 1): void {
    this.faults[op] = [...(this.faults[op] ?? []), ...Array(times).fill(kind)];
  }
  /** The provider forgets idempotency keys (retention window passed). */
  expireIdempotency(): void {
    this.idem.clear();
  }
  async #enter(op: Op, args: unknown): Promise<FaultKind | undefined> {
    this.calls.push({ op, args });
    await this.gates[op]?.();
    const f = this.faults[op]?.shift();
    if (f === "before5xx") throw new FakeError("unknown", 503, `${op}: simulated 5xx before apply`);
    if (f === "reject") throw new FakeError("rejected", 400, `${op}: simulated rejection`, "amount_too_large");
    if (f === "rate429") throw new FakeError("rejected", 429, `${op}: rate limited`, "rate_limited");
    return f;
  }
  #lost(f: FaultKind | undefined, op: Op): void {
    if (f === "lost") throw new FakeError("unknown", undefined, `${op}: response lost after apply`);
  }

  get(ref: string): WPayment {
    const p = this.payments.get(ref);
    if (!p) throw new FakeError("rejected", 404, "no such payment");
    return p;
  }
  getRefund(ref: string): WRefund {
    const r = this.refunds.get(ref);
    if (!r) throw new FakeError("rejected", 404, "no such refund");
    return r;
  }
  heldOn(paymentRef: string): bigint {
    return [...this.refunds.values()]
      .filter((r) => r.paymentRef === paymentRef && holdsMoney(r.status))
      .reduce((s, r) => s + r.amount, 0n);
  }

  // ------------------------------------------------------------------ provider operations
  async createPayment(p: {
    orderId: string;
    amount: bigint;
    currency: string;
    capture: "automatic" | "manual";
  }): Promise<WPayment> {
    const f = await this.#enter("createPayment", p);
    const key = `checkout_${p.orderId}`;
    let ref = this.idem.get(key);
    if (!ref) {
      ref = `pi_${++this.n}`;
      this.idem.set(key, ref);
      this.payments.set(ref, { ref, ...p, status: "pending", captured: 0n });
    }
    this.#lost(f, "createPayment");
    return { ...this.get(ref) };
  }
  async retrievePayment(ref: string): Promise<WPayment> {
    await this.#enter("retrievePayment", ref);
    return { ...this.get(ref) };
  }
  async capture(ref: string, p: { amount: bigint; idempotencyKey: string }): Promise<WPayment> {
    const f = await this.#enter("capture", { ref, ...p });
    const pay = this.get(ref);
    if (!this.idem.has(p.idempotencyKey)) {
      if (pay.status === "requires_capture") {
        pay.status = "succeeded";
        pay.captured = p.amount < pay.amount ? p.amount : pay.amount;
      }
      this.idem.set(p.idempotencyKey, ref);
    }
    this.#lost(f, "capture");
    return { ...pay };
  }
  async createRefund(
    paymentRef: string,
    p: { amount: bigint; idempotencyKey: string; metadata: Record<string, string> },
  ): Promise<WRefund> {
    const f = await this.#enter("createRefund", { paymentRef, ...p });
    let ref = this.idem.get(p.idempotencyKey);
    if (!ref) {
      const pay = this.get(paymentRef);
      if (pay.status !== "succeeded") throw new FakeError("rejected", 400, "payment not captured", "not_captured");
      if (p.amount > pay.captured - this.heldOn(paymentRef))
        throw new FakeError("rejected", 400, "amount too large", "amount_too_large");
      ref = `re_${++this.n}`;
      this.idem.set(p.idempotencyKey, ref);
      this.refunds.set(ref, {
        ref,
        paymentRef,
        amount: p.amount,
        currency: pay.currency,
        status: this.newRefundStatus,
        metadata: { ...p.metadata },
      });
    }
    this.#lost(f, "createRefund");
    return { ...this.getRefund(ref) };
  }
  async retrieveRefund(ref: string): Promise<WRefund> {
    await this.#enter("retrieveRefund", ref);
    return { ...this.getRefund(ref) };
  }

  // ------------------------------------------------------------------ actions of the outside world
  /** The buyer pays: automatic capture succeeds, manual capture authorises. */
  customerPays(ref: string): void {
    const p = this.get(ref);
    if (p.capture === "automatic") Object.assign(p, { status: "succeeded", captured: p.amount });
    else p.status = "requires_capture";
  }
  /** A refund made in the provider dashboard (no metadata). */
  dashboardRefund(paymentRef: string, amount: bigint, status: RefStatus = "succeeded"): WRefund {
    const pay = this.get(paymentRef);
    const ref = `re_${++this.n}`;
    const r = { ref, paymentRef, amount, currency: pay.currency, status, metadata: {} };
    this.refunds.set(ref, r);
    return r;
  }
  setRefundStatus(ref: string, status: RefStatus): void {
    this.getRefund(ref).status = status;
  }
  /** A second provider payment for an order (retried checkout, late authorisation), captured in full. */
  rogueCapturedPayment(orderId: string, amount: bigint, currency: string): WPayment {
    const ref = `pi_${++this.n}`;
    const p: WPayment = { ref, orderId, amount, currency, capture: "automatic", status: "succeeded", captured: amount };
    this.payments.set(ref, p);
    return p;
  }

  // ------------------------------------------------------------------ Stripe-shaped webhook bodies (snapshot at call time)
  piJson(ref: string) {
    const p = this.get(ref);
    const status =
      p.status === "pending" || p.status === "failed" ? "requires_payment_method" : p.status;
    return {
      id: p.ref,
      object: "payment_intent",
      amount: Number(p.amount),
      amount_received: Number(p.captured),
      currency: p.currency.toLowerCase(),
      status,
      capture_method: p.capture,
      metadata: { order_id: p.orderId },
      client_secret: `${p.ref}_secret`,
      last_payment_error: null,
    };
  }
  refundJson(ref: string) {
    const r = this.getRefund(ref);
    return {
      id: r.ref,
      object: "refund",
      amount: Number(r.amount),
      currency: r.currency.toLowerCase(),
      status: r.status,
      payment_intent: r.paymentRef,
      metadata: { ...r.metadata },
    };
  }
}

const signer = new Stripe("sk_test_x");
let evn = 0;
export interface SignedEvent {
  id: string;
  payload: string;
  headers: Record<string, string>;
}
export function signedEvent(secret: string, type: string, object: unknown, id = `evt_${++evn}`): SignedEvent {
  const payload = JSON.stringify({ id, object: "event", type, data: { object } });
  return {
    id,
    payload,
    headers: { "stripe-signature": signer.webhooks.generateTestHeaderString({ payload, secret }) },
  };
}

/** Commission reference model: 10% of a line, rounded half to even, integers only. */
export function refCommission(amount: bigint): bigint {
  const n = amount * 1000n;
  const q = n / 10000n;
  const r = n % 10000n;
  if (r * 2n > 10000n || (r * 2n === 10000n && q % 2n === 1n)) return q + 1n;
  return q;
}

export async function http(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body ?? {}) }),
  });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, body: json };
}
