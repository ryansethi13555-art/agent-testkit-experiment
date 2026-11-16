// Pure money rules of both apps, and the real provider adapters' webhook handling (no network involved).
import { createHmac } from "node:crypto";
import fc from "fast-check";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { MAX_SDK_MINOR, MoneyInputError, parseMinor, refundHoldsMoney as inlineHolds, sdkMinor as inlineSdk, stripeRefundStatus } from "../inline-marketplace/src/money.ts";
import { providerFromEnv as inlineProvider, SignatureError as InlineSigErr } from "../inline-marketplace/src/provider.ts";
import {
  commissionOf, deriveOrderStatus, divHalfEven, lineHeadroom, MAX_AMOUNT, parseMinorUnits, paymentMayMove,
  providerMinor, refundHoldsMoney, saleLegs, sdkMinor, sumLegs, type PaymentStatus, type RefundStatus,
} from "../worker-marketplace/src/money.ts";
import { providerFromEnv as workerProvider, SignatureError as WorkerSigErr } from "../worker-marketplace/src/provider.ts";
import { expectedFee } from "./helpers/db.ts";

describe("inline money.ts", () => {
  it("parses only exact non-negative integers within the SDK-safe range", () => {
    expect(parseMinor(0)).toBe(0n);
    expect(parseMinor("00012")).toBe(12n);
    expect(parseMinor(Number.MAX_SAFE_INTEGER)).toBe(MAX_SDK_MINOR);
    expect(parseMinor("9007199254740991")).toBe(MAX_SDK_MINOR);
    for (const bad of [-1, 1.5, NaN, Infinity, 2 ** 53, "9007199254740992", "99999999999999999", "1.0", "1e3", " 1", "-1", "", "0x10", null, undefined, {}, [], true, 10n])
      expect(() => parseMinor(bad), String(bad)).toThrow(MoneyInputError);
  });
  it("sdkMinor converts only exactly", () => {
    expect(inlineSdk(MAX_SDK_MINOR)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => inlineSdk(MAX_SDK_MINOR + 1n)).toThrow();
    expect(() => inlineSdk(-1n)).toThrow();
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: MAX_SDK_MINOR }), (v) => BigInt(inlineSdk(v)) === v));
  });
  it("refund statuses: money is held while pending, requires_action or succeeded only", () => {
    expect(["pending", "requires_action", "succeeded", "failed", "canceled"].map(inlineHolds)).toEqual([true, true, true, false, false]);
    expect(() => stripeRefundStatus("weird")).toThrow();
    expect(() => stripeRefundStatus(undefined)).toThrow();
  });
});

describe("worker money.ts", () => {
  it("divHalfEven is the nearest integer, ties to even (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), fc.bigInt({ min: 1n, max: 10n ** 6n }), (n, d) => {
        const q = divHalfEven(n, d);
        const twiceErr = (2n * (n - q * d) < 0n ? -(2n * (n - q * d)) : 2n * (n - q * d));
        expect(twiceErr <= d).toBe(true); // within half a unit
        if (twiceErr === d) expect(q % 2n).toBe(0n); // exact tie: even
      }),
    );
    expect(() => divHalfEven(-1n, 3n)).toThrow();
    expect(() => divHalfEven(1n, 0n)).toThrow();
    expect([5n, 15n, 25n, 35n, 45n].map((a) => commissionOf(a))).toEqual([0n, 2n, 2n, 4n, 4n]);
  });
  it("commission agrees with an independent implementation and never exceeds the amount", () => {
    fc.assert(fc.property(fc.bigInt({ min: 1n, max: MAX_AMOUNT }), (a) => commissionOf(a) === expectedFee(a) && commissionOf(a) <= a));
  });
  it("saleLegs always sum to zero, credit sellers net of commission, and omit zero legs", () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 1n, max: 10n ** 9n }), { minLength: 1, maxLength: 20 }), (amounts) => {
        const lines = amounts.map((a, i) => ({ id: `l${i}`, seller: `s${i % 3}`, amount: a }));
        const total = amounts.reduce((s, a) => s + a, 0n);
        const legs = saleLegs(total, lines);
        expect(sumLegs(legs)).toBe(0n);
        expect(legs.every((l) => l.amount !== 0n)).toBe(true);
        expect(legs[0]).toMatchObject({ account: "provider:clearing", amount: total });
        const sellers = legs.filter((l) => l.account.startsWith("seller:")).reduce((s, l) => s - l.amount, 0n);
        const fees = legs.filter((l) => l.account === "platform:commission").reduce((s, l) => s - l.amount, 0n);
        expect(sellers + fees).toBe(total);
      }),
    );
  });
  it("parseMinorUnits accepts only exact integers within the domain", () => {
    expect(parseMinorUnits(0)).toBe(0n);
    expect(parseMinorUnits("999999999999")).toBe(MAX_AMOUNT);
    for (const bad of [-1, 1.5, NaN, 2 ** 53, 1e12, "1000000000000", "1e3", "1.5", "-1", "", " 1", "1 ", null, undefined, {}, true, 5n, "1234567890123456"])
      expect(parseMinorUnits(bad), String(bad)).toBeUndefined();
  });
  it("providerMinor and sdkMinor refuse anything inexact", () => {
    expect(providerMinor(500)).toBe(500n);
    for (const bad of ["500", 5.5, -1, 1e15, null]) expect(() => providerMinor(bad)).toThrow();
    expect(sdkMinor(MAX_AMOUNT)).toBe(999_999_999_999);
    expect(() => sdkMinor(MAX_AMOUNT + 1n)).toThrow();
  });
  it("lineHeadroom subtracts only money-holding refunds and every reservation", () => {
    const r = (amount: bigint, status: RefundStatus) => ({ amount, status });
    expect(lineHeadroom(1000n, [r(100n, "succeeded"), r(200n, "pending"), r(300n, "requires_action"), r(400n, "failed"), r(500n, "canceled")], [50n, 25n])).toBe(325n);
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 6n }), fc.array(fc.bigInt({ min: 1n, max: 10n ** 4n }), { maxLength: 8 }), (line, res) =>
        lineHeadroom(line, [], res) === line - res.reduce((s, x) => s + x, 0n)),
    );
    expect(refundHoldsMoney("failed")).toBe(false);
  });
  it("a payment only moves forward; succeeded and canceled are final", () => {
    const all: PaymentStatus[] = ["pending", "failed", "requires_capture", "succeeded", "canceled"];
    for (const to of all) {
      expect(paymentMayMove("succeeded", to)).toBe(false);
      expect(paymentMayMove("canceled", to)).toBe(false);
    }
    expect(paymentMayMove("requires_capture", "pending")).toBe(false);
    expect(paymentMayMove("requires_capture", "succeeded")).toBe(true);
    expect(paymentMayMove("pending", "succeeded")).toBe(true);
    expect(paymentMayMove("pending", "pending")).toBe(false);
  });
  it("order status follows money facts only", () => {
    expect(deriveOrderStatus({ captured: 1000n, refunded: 0n, payments: ["succeeded"] })).toBe("paid");
    expect(deriveOrderStatus({ captured: 1000n, refunded: 1n, payments: ["succeeded"] })).toBe("partially_refunded");
    expect(deriveOrderStatus({ captured: 1000n, refunded: 1000n, payments: ["succeeded"] })).toBe("refunded");
    expect(deriveOrderStatus({ captured: 0n, refunded: 0n, payments: ["requires_capture"] })).toBe("authorized");
    expect(deriveOrderStatus({ captured: 0n, refunded: 0n, payments: ["canceled", "canceled"] })).toBe("canceled");
    expect(deriveOrderStatus({ captured: 0n, refunded: 0n, payments: ["failed", "canceled"] })).toBe("pending_payment");
    expect(deriveOrderStatus({ captured: 0n, refunded: 0n, payments: [] })).toBe("pending_payment");
  });
});

// ---------------------------------------------------------------------------------- adapters
const WH = "whsec_adapters";
const RZP = "rzp_hook_secret";
const stripeEnv = { PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: WH };
const rzpEnv = { PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: "k", RAZORPAY_WEBHOOK_SECRET: RZP };
const stripeSigned = (event: object, timestamp?: number) => {
  const payload = JSON.stringify(event);
  return { payload, headers: { "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload, secret: WH, ...(timestamp ? { timestamp } : {}) }) } };
};
const rzpSigned = (event: object, eventId?: string) => {
  const payload = JSON.stringify(event);
  const sig = createHmac("sha256", RZP).update(payload).digest("hex");
  return { payload, headers: { "x-razorpay-signature": sig, ...(eventId ? { "x-razorpay-event-id": eventId } : {}) } as Record<string, string> };
};
const pi = (over: object = {}) => ({ id: "pi_1", object: "payment_intent", amount: 1000, amount_received: 1000, currency: "inr", status: "succeeded", metadata: { order_id: "ord_1" }, client_secret: "s", last_payment_error: null, ...over });
const stripeRefund = (over: object = {}) => ({ id: "re_1", object: "refund", amount: 300, currency: "inr", status: "succeeded", payment_intent: "pi_1", metadata: { refund_id: "rf_1" }, ...over });

describe("Stripe adapters", () => {
  it("inline: a verified payment_intent.succeeded carries exact money, currency and order identity", async () => {
    const s = stripeSigned({ id: "evt_a", object: "event", type: "payment_intent.succeeded", data: { object: pi() } });
    const ev = await inlineProvider(stripeEnv).parseWebhook(s.payload, s.headers);
    expect(ev).toMatchObject({ eventId: "evt_a", kind: "payment_succeeded" });
    if (ev.kind !== "payment_succeeded") throw new Error();
    expect(ev.payment).toMatchObject({ ref: "pi_1", status: "succeeded", amount: 1000n, amountReceived: 1000n, currency: "INR", orderId: "ord_1" });
  });
  it("inline: authorisation events are observations that carry no received money; refunds map status exactly", async () => {
    const p = inlineProvider(stripeEnv);
    let s = stripeSigned({ id: "evt_b", object: "event", type: "payment_intent.amount_capturable_updated", data: { object: pi({ status: "requires_capture", amount_received: 0 }) } });
    let ev = await p.parseWebhook(s.payload, s.headers);
    expect(ev.kind).toBe("payment_observed");
    if (ev.kind === "payment_observed") expect(ev.payment).toMatchObject({ status: "requires_capture", amountReceived: 0n });
    for (const [st, kind] of [["pending", "refund_changed"], ["failed", "refund_changed"], ["canceled", "refund_changed"]] as const) {
      s = stripeSigned({ id: `evt_${st}`, object: "event", type: "refund.updated", data: { object: stripeRefund({ status: st }) } });
      ev = await p.parseWebhook(s.payload, s.headers);
      expect(ev.kind).toBe(kind);
      if (ev.kind === "refund_changed") expect(ev.refund).toMatchObject({ ref: "re_1", paymentRef: "pi_1", amount: 300n, currency: "INR", status: st, requestId: "rf_1" });
    }
    s = stripeSigned({ id: "evt_x", object: "event", type: "customer.created", data: { object: { id: "cus_1" } } });
    expect((await p.parseWebhook(s.payload, s.headers)).kind).toBe("ignored");
  });
  it("both adapters reject forged, unsigned, altered and stale-timestamp deliveries", async () => {
    const ev = { id: "evt_s", object: "event", type: "payment_intent.succeeded", data: { object: pi() } };
    const good = stripeSigned(ev);
    const old = stripeSigned(ev, Math.floor(Date.now() / 1000) - 3600);
    const other = { payload: good.payload, headers: { "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload: good.payload, secret: "whsec_other" }) } };
    for (const [p, E] of [[inlineProvider(stripeEnv), InlineSigErr], [workerProvider(stripeEnv), WorkerSigErr]] as const) {
      const run = async (raw: string, headers: Record<string, string>) => Promise.resolve().then(() => p.parseWebhook(raw, headers));
      await expect(run(good.payload, {})).rejects.toBeInstanceOf(E);
      await expect(run(good.payload + " ", good.headers)).rejects.toBeInstanceOf(E);
      await expect(run(old.payload, old.headers)).rejects.toBeInstanceOf(E);
      await expect(run(other.payload, other.headers)).rejects.toBeInstanceOf(E);
      await expect(run(good.payload, good.headers)).resolves.toBeDefined();
    }
  });
  it("worker: a webhook yields only 'which object changed' (never state), keyed by the event id", () => {
    const p = workerProvider(stripeEnv);
    let s = stripeSigned({ id: "evt_w1", object: "event", type: "payment_intent.succeeded", data: { object: pi() } });
    expect(p.parseWebhook(s.payload, s.headers)).toEqual({ eventId: "evt_w1", type: "payment_intent.succeeded", object: "payment", ref: "pi_1" });
    s = stripeSigned({ id: "evt_w2", object: "event", type: "charge.refunded", data: { object: { id: "ch_1", object: "charge", payment_intent: "pi_1" } } });
    expect(p.parseWebhook(s.payload, s.headers)).toMatchObject({ object: "payment", ref: "pi_1" });
    s = stripeSigned({ id: "evt_w3", object: "event", type: "refund.updated", data: { object: stripeRefund() } });
    expect(p.parseWebhook(s.payload, s.headers)).toMatchObject({ object: "refund", ref: "re_1", paymentRef: "pi_1" });
    s = stripeSigned({ id: "evt_w4", object: "event", type: "customer.created", data: { object: { id: "cus_1", object: "customer" } } });
    expect(p.parseWebhook(s.payload, s.headers).object).toBe("none");
  });
});

describe("Razorpay adapters", () => {
  const payEntity = (over: object = {}) => ({ id: "pay_1", status: "captured", amount: 1000, currency: "INR", order_id: "order_1", notes: { order_id: "ord_1" }, ...over });
  const refundEntity = (over: object = {}) => ({ id: "rfnd_1", payment_id: "pay_1", amount: 300, currency: "INR", status: "processed", notes: { refund_id: "rf_1" }, ...over });

  it("enforces the 100 minor unit INR minimum only for INR", () => {
    for (const p of [inlineProvider(rzpEnv), workerProvider(rzpEnv)]) {
      expect(p.refundRequestError?.(99n, "INR")).toBeTruthy();
      expect(p.refundRequestError?.(1n, "INR")).toBeTruthy();
      expect(p.refundRequestError?.(100n, "INR")).toBeUndefined();
      expect(p.refundRequestError?.(1n, "USD")).toBeUndefined();
    }
    expect(inlineProvider(stripeEnv).refundRequestError).toBeUndefined();
  });
  it("inline: captured vs authorised carry the right received money; the order id is the payment reference", async () => {
    const p = inlineProvider(rzpEnv);
    let s = rzpSigned({ event: "payment.captured", payload: { payment: { entity: payEntity() } } }, "evt_r1");
    let ev = await p.parseWebhook(s.payload, s.headers);
    expect(ev.kind).toBe("payment_succeeded");
    if (ev.kind === "payment_succeeded") expect(ev.payment).toMatchObject({ ref: "order_1", amount: 1000n, amountReceived: 1000n, currency: "INR", orderId: "ord_1" });
    s = rzpSigned({ event: "payment.authorized", payload: { payment: { entity: payEntity({ status: "authorized" }) } } }, "evt_r2");
    ev = await p.parseWebhook(s.payload, s.headers);
    expect(ev.kind).toBe("payment_observed");
    if (ev.kind === "payment_observed") expect(ev.payment.amountReceived).toBe(0n);
    s = rzpSigned({ event: "payment.failed", payload: { payment: { entity: payEntity({ status: "failed" }) } } }, "evt_r3");
    expect((await p.parseWebhook(s.payload, s.headers)).kind).toBe("ignored");
  });
  it("inline: refund events map processed/failed/pending exactly and keep the request id", async () => {
    const p = inlineProvider(rzpEnv);
    for (const [raw, want] of [["processed", "succeeded"], ["failed", "failed"], ["pending", "pending"], ["created", "pending"]] as const) {
      const s = rzpSigned({ event: "refund.processed", payload: { payment: { entity: payEntity() }, refund: { entity: refundEntity({ status: raw }) } } }, `evt_${raw}`);
      const ev = await p.parseWebhook(s.payload, s.headers);
      if (ev.kind !== "refund_changed") throw new Error("expected refund");
      expect(ev.refund).toMatchObject({ ref: "rfnd_1", paymentRef: "order_1", amount: 300n, currency: "INR", status: want, requestId: "rf_1" });
    }
  });
  it("both adapters dedupe on the provider event id, falling back to the signed body, and verify the signature", async () => {
    const body = { event: "payment.captured", payload: { payment: { entity: payEntity() } } };
    const a = rzpSigned(body, "evt_same");
    const b = rzpSigned(body);
    const c = rzpSigned(body);
    const inl = inlineProvider(rzpEnv);
    const wrk = workerProvider(rzpEnv);
    expect((await inl.parseWebhook(a.payload, a.headers)).eventId).toBe("evt_same");
    expect((await inl.parseWebhook(b.payload, b.headers)).eventId).toBe((await inl.parseWebhook(c.payload, c.headers)).eventId);
    expect(wrk.parseWebhook(a.payload, a.headers)).toMatchObject({ eventId: "evt_same", object: "payment", ref: "order_1" });
    expect(wrk.parseWebhook(b.payload, b.headers).eventId).toBe(wrk.parseWebhook(c.payload, c.headers).eventId);
    const other = rzpSigned({ ...body, event: "payment.authorized" });
    expect(wrk.parseWebhook(other.payload, other.headers).eventId).not.toBe(wrk.parseWebhook(b.payload, b.headers).eventId);
    await expect(Promise.resolve().then(() => inl.parseWebhook(a.payload, {}))).rejects.toBeInstanceOf(InlineSigErr);
    await expect(Promise.resolve().then(() => inl.parseWebhook(a.payload + " ", a.headers))).rejects.toBeInstanceOf(InlineSigErr);
    expect(() => wrk.parseWebhook(a.payload, { "x-razorpay-signature": "00" })).toThrow(WorkerSigErr);
    expect(() => wrk.parseWebhook(a.payload + " ", a.headers)).toThrow(WorkerSigErr);
  });
});
