// An in-memory payment provider for the inline marketplace, with the failure modes the brief lists:
// lost responses (effect applied, caller sees an error), failures before the effect, idempotency keys that replay
// the FIRST response, refunds that are pending and later succeed or fail, partial captures, dashboard refunds.
import type http from "node:http";
import type { Payment, PaymentProvider, Refund, WebhookEvent } from "../../inline-marketplace/src/provider.ts";

export class TestSignatureError extends Error {}
export class FakeProviderError extends Error {
  providerError = true;
  definitive?: string;
}

type Fault = "lose" | "fail" | "reject" | undefined;
interface Pay {
  status: Payment["status"];
  amount: bigint;
  received: bigint;
  currency: string;
  orderId: string | undefined;
  capture: string;
}

export class FakeStripe implements PaymentProvider {
  readonly name = "stripe";
  payments = new Map<string, Pay>();
  refunds = new Map<string, Refund>();
  idem = new Map<string, { ref: string; first: Refund }>();
  payIdem = new Map<string, string>();
  events = new Map<string, WebhookEvent>();
  calls = { createPayment: 0, capture: 0, refund: 0, refundApplied: 0 };
  faults: { createPayment?: Fault; capture?: Fault; refund?: Fault } = {};
  nextRefundStatus: Refund["status"] = "succeeded";
  partialCapture: bigint | undefined;
  refundCurrency: string | undefined;
  n = 0;
  refundRequestError?: (amount: bigint, currency: string) => string | undefined;

  reset() {
    this.payments.clear();
    this.refunds.clear();
    this.idem.clear();
    this.payIdem.clear();
    this.events.clear();
    this.calls = { createPayment: 0, capture: 0, refund: 0, refundApplied: 0 };
    this.faults = {};
    this.nextRefundStatus = "succeeded";
    this.partialCapture = undefined;
    this.refundCurrency = undefined;
    this.n = 0;
  }

  snap(ref: string): Payment {
    const p = this.payments.get(ref);
    if (!p) throw Object.assign(new FakeProviderError("no such payment"), { definitive: undefined });
    return {
      ref,
      status: p.status,
      amount: p.amount,
      amountReceived: p.received,
      currency: p.currency,
      orderId: p.orderId,
      clientSecret: `${ref}_secret`,
    };
  }

  async createPayment(p: { orderId: string; amount: bigint; currency: string; capture: "automatic" | "manual" }) {
    this.calls.createPayment++;
    const f = this.faults.createPayment;
    this.faults.createPayment = undefined;
    if (f === "fail") throw new Error("socket hang up before request");
    const key = `checkout_${p.orderId}`;
    let ref = this.payIdem.get(key);
    if (!ref) {
      ref = `pi_${++this.n}`;
      this.payIdem.set(key, ref);
      this.payments.set(ref, {
        status: "pending",
        amount: p.amount,
        received: 0n,
        currency: p.currency,
        orderId: p.orderId,
        capture: p.capture,
      });
    }
    if (f === "lose") throw new Error("timeout after provider applied create");
    return this.snap(ref);
  }
  async retrievePayment(ref: string) {
    return this.snap(ref);
  }
  async retrieveRefund(ref: string) {
    const r = this.refunds.get(ref);
    if (!r) throw new FakeProviderError("no such refund");
    return { ...r };
  }
  async capture(ref: string, _p: { amount: bigint; currency: string; idempotencyKey: string }) {
    this.calls.capture++;
    const f = this.faults.capture;
    this.faults.capture = undefined;
    if (f === "fail") throw new Error("connection reset before capture");
    const p = this.payments.get(ref);
    if (!p) throw new FakeProviderError("no such payment");
    if (p.status === "requires_capture") {
      p.status = "succeeded";
      p.received = this.partialCapture ?? p.amount;
    }
    if (f === "lose") throw new Error("timeout after provider applied capture");
    return this.snap(ref);
  }
  async cancel() {}
  async refundTarget(ref: string) {
    return ref;
  }
  async refund(
    ref: string,
    p: { amount: bigint; idempotencyKey: string; metadata: Record<string, string>; targetRef?: string },
  ) {
    this.calls.refund++;
    const f = this.faults.refund;
    this.faults.refund = undefined;
    if (f === "fail") throw new Error("connection reset before refund");
    if (f === "reject") {
      const e = new FakeProviderError("amount_too_large");
      e.definitive = "amount_too_large";
      throw e;
    }
    const replay = this.idem.get(p.idempotencyKey);
    if (replay) return { ...replay.first };
    const pay = this.payments.get(ref);
    if (!pay || pay.received === 0n) throw new FakeProviderError("payment not captured");
    const used = this.liveRefunded(ref);
    if (p.amount > pay.received - used) {
      const e = new FakeProviderError("amount_too_large");
      e.definitive = "amount_too_large";
      throw e;
    }
    const r: Refund = {
      ref: `re_${++this.n}`,
      requestId: p.metadata.refund_id,
      paymentRef: ref,
      amount: p.amount,
      currency: this.refundCurrency ?? pay.currency,
      status: this.nextRefundStatus,
    };
    this.nextRefundStatus = "succeeded";
    this.refunds.set(r.ref, r);
    this.idem.set(p.idempotencyKey, { ref: r.ref, first: { ...r } });
    this.calls.refundApplied++;
    if (f === "lose") throw new Error("timeout after provider applied refund");
    return { ...r };
  }
  liveRefunded(paymentRef: string) {
    let s = 0n;
    for (const r of this.refunds.values())
      if (r.paymentRef === paymentRef && ["pending", "requires_action", "succeeded"].includes(r.status))
        s += r.amount;
    return s;
  }
  async parseWebhook(raw: string, headers: http.IncomingHttpHeaders): Promise<WebhookEvent> {
    if (headers["x-sig"] !== "ok") throw new TestSignatureError("invalid signature");
    const ev = this.events.get((JSON.parse(raw) as { key: string }).key);
    if (!ev) throw new Error("test bug: unknown event key");
    return ev;
  }
  isProviderError(e: unknown) {
    return (e as { providerError?: boolean })?.providerError === true;
  }
  definitiveRefundRejection(e: unknown) {
    return (e as { definitive?: string })?.definitive;
  }

  // ---- test controls
  /** Customer completes payment (automatic) or authorises (manual). */
  pay(ref: string) {
    const p = this.payments.get(ref);
    if (!p) throw new Error("no payment");
    if (p.capture === "manual") p.status = "requires_capture";
    else Object.assign(p, { status: "succeeded", received: p.amount });
  }
  /** A refund made in the provider dashboard (no marketplace request id). */
  dashboardRefund(paymentRef: string, amount: bigint, status: Refund["status"] = "succeeded"): Refund {
    const pay = this.payments.get(paymentRef);
    if (!pay) throw new Error("no payment");
    const r: Refund = {
      ref: `re_${++this.n}`,
      requestId: undefined,
      paymentRef,
      amount,
      currency: pay.currency,
      status,
    };
    this.refunds.set(r.ref, r);
    return r;
  }
  payEvent(eventId: string, ref: string, kind: "payment_succeeded" | "payment_observed" = "payment_succeeded"): WebhookEvent {
    return {
      eventId,
      kind,
      objectId: ref,
      type: kind === "payment_succeeded" ? "payment_intent.succeeded" : "payment_intent.amount_capturable_updated",
      payment: this.snap(ref),
    } as WebhookEvent;
  }
  refundEvent(eventId: string, refundRef: string, override: Partial<Refund> = {}): WebhookEvent {
    const r = this.refunds.get(refundRef);
    if (!r) throw new Error("no refund");
    return {
      eventId,
      kind: "refund_changed",
      objectId: refundRef,
      type: "refund.updated",
      refund: { ...r, ...override },
    } as WebhookEvent;
  }
}

export const fake = new FakeStripe();
