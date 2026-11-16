// In-memory provider for the worker (job queue) marketplace. Same failure modes as the inline fake.
import type http from "node:http";
import { type PaymentProvider, type PaymentSnapshot, ProviderError, type RefundSnapshot, providerFromEnv } from "../../worker-marketplace/src/provider.ts";

type PStatus = PaymentSnapshot["status"];
type Fault = "lose" | "fail" | "reject" | undefined;
export const WHSEC = "whsec_money_suite";

export class WorkerFake implements PaymentProvider {
  readonly name = "stripe" as const;
  payments = new Map<string, { status: PStatus; amount: bigint; captured: bigint; currency: string; orderId: string; manual: boolean }>();
  refunds = new Map<string, RefundSnapshot>();
  idem = new Map<string, { first: RefundSnapshot }>();
  payIdem = new Map<string, string>();
  calls = { createPayment: 0, capture: 0, createRefund: 0, refundApplied: 0 };
  faults: { createPayment?: Fault; capture?: Fault; refund?: Fault } = {};
  nextRefundStatus: RefundSnapshot["status"] = "succeeded";
  partialCapture: bigint | undefined;
  n = 0;
  refundRequestError?: (amount: bigint, currency: string) => string | undefined;
  readonly real = providerFromEnv({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: WHSEC });

  reset() {
    this.payments.clear();
    this.refunds.clear();
    this.idem.clear();
    this.payIdem.clear();
    this.calls = { createPayment: 0, capture: 0, createRefund: 0, refundApplied: 0 };
    this.faults = {};
    this.nextRefundStatus = "succeeded";
    this.partialCapture = undefined;
    this.n = 0;
  }
  snap(ref: string): PaymentSnapshot {
    const p = this.payments.get(ref);
    if (!p) throw new ProviderError("rejected", 404, "no such payment");
    return { ref, status: p.status, amount: p.amount, amountCaptured: p.captured, currency: p.currency, orderId: p.orderId, clientSecret: `${ref}_s` };
  }
  async createPayment(p: { orderId: string; amount: bigint; currency: string; capture: "automatic" | "manual" }) {
    this.calls.createPayment++;
    const f = this.faults.createPayment;
    this.faults.createPayment = undefined;
    if (f === "fail") throw new ProviderError("unknown", undefined, "no response");
    let ref = this.payIdem.get(p.orderId);
    if (!ref) {
      ref = `pi_${++this.n}`;
      this.payIdem.set(p.orderId, ref);
      this.payments.set(ref, { status: "pending", amount: p.amount, captured: 0n, currency: p.currency, orderId: p.orderId, manual: p.capture === "manual" });
    }
    if (f === "lose") throw new ProviderError("unknown", undefined, "timeout after apply");
    return this.snap(ref);
  }
  async retrievePayment(ref: string) {
    return this.snap(ref);
  }
  async capture(ref: string) {
    this.calls.capture++;
    const f = this.faults.capture;
    this.faults.capture = undefined;
    if (f === "fail") throw new ProviderError("unknown", undefined, "no response");
    const p = this.payments.get(ref);
    if (!p) throw new ProviderError("rejected", 404, "no payment");
    if (p.status === "requires_capture") Object.assign(p, { status: "succeeded", captured: this.partialCapture ?? p.amount });
    if (f === "lose") throw new ProviderError("unknown", undefined, "timeout after apply");
    return this.snap(ref);
  }
  live(paymentRef: string) {
    let s = 0n;
    for (const r of this.refunds.values())
      if (r.paymentRef === paymentRef && ["pending", "requires_action", "succeeded"].includes(r.status)) s += r.amount;
    return s;
  }
  async createRefund(paymentRef: string, p: { amount: bigint; idempotencyKey: string; metadata: Record<string, string> }) {
    this.calls.createRefund++;
    const f = this.faults.refund;
    this.faults.refund = undefined;
    if (f === "fail") throw new ProviderError("unknown", undefined, "no response");
    if (f === "reject") throw new ProviderError("rejected", 400, "amount too large");
    const replay = this.idem.get(p.idempotencyKey);
    if (replay) return { ...replay.first };
    const pay = this.payments.get(paymentRef);
    if (!pay || pay.captured === 0n) throw new ProviderError("rejected", 400, "not captured");
    if (p.amount > pay.captured - this.live(paymentRef)) throw new ProviderError("rejected", 400, "amount too large");
    const r: RefundSnapshot = { ref: `re_${++this.n}`, paymentRef, amount: p.amount, currency: pay.currency, status: this.nextRefundStatus, requestId: p.metadata.refund_request_id };
    this.nextRefundStatus = "succeeded";
    this.refunds.set(r.ref, r);
    this.idem.set(p.idempotencyKey, { first: { ...r } });
    this.calls.refundApplied++;
    if (f === "lose") throw new ProviderError("unknown", undefined, "timeout after apply");
    return { ...r };
  }
  async retrieveRefund(ref: string) {
    const r = this.refunds.get(ref);
    if (!r) throw new ProviderError("rejected", 404, "no such refund");
    return { ...r };
  }
  parseWebhook(raw: string, headers: http.IncomingHttpHeaders) {
    return this.real.parseWebhook(raw, headers);
  }
  // ---- controls
  pay(ref: string) {
    const p = this.payments.get(ref)!;
    if (p.manual) p.status = "requires_capture";
    else Object.assign(p, { status: "succeeded", captured: p.amount });
  }
  dashboardRefund(paymentRef: string, amount: bigint, status: RefundSnapshot["status"] = "succeeded") {
    const pay = this.payments.get(paymentRef)!;
    const r: RefundSnapshot = { ref: `re_${++this.n}`, paymentRef, amount, currency: pay.currency, status, requestId: undefined };
    this.refunds.set(r.ref, r);
    return r;
  }
}
export const fakeWorker = new WorkerFake();
