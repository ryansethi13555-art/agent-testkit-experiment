// QueueBazaar's payment provider port. The shop logic is provider-neutral; each adapter wraps one official SDK.
// Selected by PAYMENT_PROVIDER (stripe | razorpay). Keys and webhook secrets come from env only.
//
// Every call returns a normalised snapshot of the provider object as the provider reports it NOW. The worker never
// trusts a webhook body for state: it uses the webhook only to learn which object changed, then fetches it.
import { createHash } from "node:crypto";
import type http from "node:http";
import Razorpay from "razorpay";
import Stripe from "stripe";
import { isRefundStatus, type PaymentStatus, providerMinor, type RefundStatus, sdkMinor } from "./money.ts";

export interface PaymentSnapshot {
  /** The reference the shop stores for the payment: Stripe PaymentIntent id, Razorpay order id. */
  readonly ref: string;
  readonly status: PaymentStatus;
  readonly amount: bigint;
  readonly amountCaptured: bigint;
  readonly currency: string;
  /** The shop's order id, from the metadata/notes the shop attached when it created the payment. */
  readonly orderId: string | undefined;
  readonly clientSecret: string | null;
}

export interface RefundSnapshot {
  readonly ref: string;
  /** The payment reference in the same form as PaymentSnapshot.ref. */
  readonly paymentRef: string;
  readonly amount: bigint;
  readonly currency: string;
  readonly status: RefundStatus;
  /** The shop's refund request id, from the metadata/notes the shop attached (absent for dashboard refunds). */
  readonly requestId: string | undefined;
}

/** What a verified webhook tells the shop: which provider object to reconcile. Never its state. */
export interface WebhookNotice {
  readonly eventId: string;
  readonly type: string;
  readonly object: "payment" | "refund" | "none";
  readonly ref: string;
  readonly paymentRef?: string;
}

export class SignatureError extends Error {}

/**
 * A provider call that did not return a usable object. `rejected`: the provider answered and did not apply it (4xx).
 * `unknown`: no answer, a server error, a rate limit or an in-progress conflict: it may or may not have been applied.
 */
export class ProviderError extends Error {
  readonly outcome: "rejected" | "unknown";
  readonly status: number | undefined;
  constructor(outcome: "rejected" | "unknown", status: number | undefined, message: string) {
    super(message);
    this.outcome = outcome;
    this.status = status;
  }
}

const outcomeOf = (status: number | undefined): "rejected" | "unknown" =>
  status !== undefined && status >= 400 && status < 500 && status !== 409 && status !== 429
    ? "rejected"
    : "unknown";

export interface PaymentProvider {
  readonly name: "stripe" | "razorpay";
  createPayment(p: {
    orderId: string;
    amount: bigint;
    currency: string;
    capture: "automatic" | "manual";
  }): Promise<PaymentSnapshot>;
  retrievePayment(ref: string): Promise<PaymentSnapshot>;
  capture(
    ref: string,
    p: { amount: bigint; currency: string; idempotencyKey: string },
  ): Promise<PaymentSnapshot>;
  /** Validate locally known contract limits before recording an ambiguous external operation. */
  refundRequestError?(amount: bigint, currency: string): string | undefined;
  createRefund(
    paymentRef: string,
    p: { amount: bigint; idempotencyKey: string; metadata: Record<string, string> },
  ): Promise<RefundSnapshot>;
  retrieveRefund(ref: string): Promise<RefundSnapshot>;
  /** Verify the signature over the raw body; throws SignatureError. */
  parseWebhook(raw: string, headers: http.IncomingHttpHeaders): WebhookNotice;
}

async function guarded<T>(
  what: string,
  fn: () => Promise<T>,
  statusOf: (e: unknown) => number | undefined,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    const status = statusOf(e);
    const msg = (e as { message?: unknown })?.message;
    throw new ProviderError(
      outcomeOf(status),
      status,
      `${what}: ${status ?? "no response"} ${typeof msg === "string" ? msg : ""}`.trim(),
    );
  }
}

// ---------------------------------------------------------------------------------------------------------- Stripe
function stripeProvider(env: NodeJS.ProcessEnv): PaymentProvider {
  // MoneyInvariant redirect: one guarded option, active only when the variable is set (test runs).
  const miBase = env.MONEYINV_STRIPE_API_BASE ? new URL(env.MONEYINV_STRIPE_API_BASE) : null;
  const stripe = new Stripe(env.STRIPE_SECRET_KEY ?? "sk_test_missing", {
    maxNetworkRetries: 2, // retries reuse the same idempotency key
    ...(miBase
      ? { host: miBase.hostname, port: miBase.port, protocol: miBase.protocol === "http:" ? "http" : "https" }
      : {}),
  });
  // Keep refund attempts visible to the durable queue: the Node transport can silently retry
  // a closed connection even at maxNetworkRetries:0. Fetch surfaces that unknown outcome.
  const refundStripe = new Stripe(env.STRIPE_SECRET_KEY ?? "sk_test_missing", {
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(),
    ...(miBase
      ? { host: miBase.hostname, port: miBase.port, protocol: miBase.protocol === "http:" ? "http" : "https" }
      : {}),
  });
  const secret = env.STRIPE_WEBHOOK_SECRET ?? "";
  const statusOf = (e: unknown) => {
    const s = (e as { statusCode?: unknown })?.statusCode;
    return typeof s === "number" ? s : undefined;
  };
  const payment = (pi: Stripe.PaymentIntent): PaymentSnapshot => ({
    ref: pi.id,
    status:
      pi.status === "succeeded"
        ? "succeeded"
        : pi.status === "requires_capture"
          ? "requires_capture"
          : pi.status === "canceled"
            ? "canceled"
            : pi.status === "requires_payment_method" && pi.last_payment_error
              ? "failed"
              : "pending",
    amount: providerMinor(pi.amount),
    amountCaptured: providerMinor(pi.amount_received ?? 0),
    currency: pi.currency.toUpperCase(),
    orderId: pi.metadata?.order_id,
    clientSecret: pi.client_secret,
  });
  const refund = (r: Stripe.Refund): RefundSnapshot => {
    const piRef = typeof r.payment_intent === "string" ? r.payment_intent : r.payment_intent?.id;
    if (!piRef) throw new ProviderError("unknown", undefined, `refund ${r.id} has no payment_intent`);
    if (!isRefundStatus(r.status))
      throw new ProviderError("unknown", undefined, `refund ${r.id}: unknown status`);
    return {
      ref: r.id,
      paymentRef: piRef,
      amount: providerMinor(r.amount),
      currency: r.currency.toUpperCase(),
      status: r.status,
      requestId: r.metadata?.refund_request_id,
    };
  };
  return {
    name: "stripe",
    createPayment: (p) =>
      guarded(
        "create payment",
        async () =>
          payment(
            await refundStripe.paymentIntents.create(
              {
                amount: sdkMinor(p.amount),
                currency: p.currency.toLowerCase(),
                capture_method: p.capture,
                metadata: { order_id: p.orderId },
              },
              { idempotencyKey: `checkout_${p.orderId}` },
            ),
          ),
        statusOf,
      ),
    retrievePayment: (ref) =>
      guarded("retrieve payment", async () => payment(await stripe.paymentIntents.retrieve(ref)), statusOf),
    capture: (ref, p) =>
      guarded(
        "capture",
        async () =>
          payment(await stripe.paymentIntents.capture(ref, {}, { idempotencyKey: p.idempotencyKey })),
        statusOf,
      ),
    createRefund: (paymentRef, p) =>
      guarded(
        "create refund",
        async () => {
          try {
            return refund(
              await refundStripe.refunds.create(
                { payment_intent: paymentRef, amount: sdkMinor(p.amount), metadata: p.metadata },
                { idempotencyKey: p.idempotencyKey },
              ),
            );
          } catch (e) {
            // Stripe idempotency.rate-limit-precedes. The shop still retains any prior unknown request.
            if ((e as { type?: unknown })?.type === "StripeRateLimitError" && statusOf(e) === 429)
              throw new ProviderError("rejected", 429, "refund rate limited before execution");
            throw e;
          }
        },
        statusOf,
      ),
    retrieveRefund: (ref) =>
      guarded("retrieve refund", async () => refund(await stripe.refunds.retrieve(ref)), statusOf),
    parseWebhook(raw, headers) {
      let ev: Stripe.Event;
      try {
        ev = stripe.webhooks.constructEvent(raw, String(headers["stripe-signature"] ?? ""), secret);
      } catch {
        throw new SignatureError("invalid signature");
      }
      const obj = ev.data.object as { id?: unknown; object?: unknown; payment_intent?: unknown };
      const id = typeof obj.id === "string" ? obj.id : "";
      const pi = typeof obj.payment_intent === "string" ? obj.payment_intent : undefined;
      if (obj.object === "payment_intent")
        return { eventId: ev.id, type: ev.type, object: "payment", ref: id };
      if (obj.object === "charge" && pi) return { eventId: ev.id, type: ev.type, object: "payment", ref: pi };
      if (obj.object === "refund")
        return {
          eventId: ev.id,
          type: ev.type,
          object: "refund",
          ref: id,
          ...(pi ? { paymentRef: pi } : {}),
        };
      return { eventId: ev.id, type: ev.type, object: "none", ref: id };
    },
  };
}

// -------------------------------------------------------------------------------------------------------- Razorpay
// Orders API: the shop stores the Razorpay order id; payment attempts hang off the order.
interface RzpPayment {
  id: string;
  status: string;
  amount: number;
  currency: string;
  order_id: string;
  captured?: boolean;
  notes?: Record<string, string> | unknown[];
}
interface RzpRefund {
  id: string;
  payment_id: string;
  amount: number;
  currency: string;
  status: string;
  notes?: Record<string, string> | unknown[];
}
const notesOf = (n: unknown): Record<string, string> =>
  n && typeof n === "object" && !Array.isArray(n) ? (n as Record<string, string>) : {};

function razorpayProvider(env: NodeJS.ProcessEnv): PaymentProvider {
  const rzp = new Razorpay({
    key_id: env.RAZORPAY_KEY_ID ?? "rzp_test_missing",
    key_secret: env.RAZORPAY_KEY_SECRET ?? "",
  });
  // razorpay-node's HTTP client (axios, with the key auth already configured).
  const rq = (
    rzp as unknown as {
      api: {
        rq: {
          defaults: { baseURL: string };
          post: (u: string, b: unknown, o: unknown) => Promise<{ data: unknown }>;
        };
      };
    }
  ).api.rq;
  // MoneyInvariant redirect: razorpay-node 2.9.x has no public base-URL option (version-pinned internal seam).
  if (env.MONEYINV_RAZORPAY_API_BASE) rq.defaults.baseURL = env.MONEYINV_RAZORPAY_API_BASE;
  const secret = env.RAZORPAY_WEBHOOK_SECRET ?? "";
  // razorpay-node rejects with {statusCode, error}; axios errors carry response.status; a lost connection has neither
  const statusOf = (e: unknown) => {
    const s =
      (e as { statusCode?: unknown })?.statusCode ??
      (e as { response?: { status?: unknown } })?.response?.status;
    return typeof s === "number" ? s : undefined;
  };
  const isCaptured = (p: RzpPayment) => p.captured === true || p.status === "captured";
  const status = (p: RzpPayment | undefined): PaymentStatus => {
    if (!p) return "pending";
    if (isCaptured(p)) return "succeeded"; // captured, possibly refunded since
    if (p.status === "authorized") return "requires_capture";
    if (p.status === "refunded") return "canceled"; // an uncaptured authorisation released (auto-refund)
    if (p.status === "failed") return "failed";
    return "pending";
  };
  const snapshot = (
    orderRef: string,
    p: RzpPayment | undefined,
    fallback?: { amount: bigint; currency: string; orderId?: string },
  ): PaymentSnapshot => ({
    ref: orderRef,
    status: status(p),
    amount: p ? providerMinor(p.amount) : (fallback?.amount ?? 0n),
    amountCaptured: p && isCaptured(p) ? providerMinor(p.amount) : 0n,
    currency: (p?.currency ?? fallback?.currency ?? "").toUpperCase(),
    orderId: notesOf(p?.notes).order_id ?? fallback?.orderId,
    clientSecret: null,
  });
  /** The order's payment that matters: captured first, then authorised, then the latest attempt. */
  const paymentOf = async (orderRef: string): Promise<RzpPayment | undefined> => {
    const list = (await rzp.orders.fetchPayments(orderRef)) as unknown as { items: RzpPayment[] };
    const items = list.items ?? [];
    if (items.some((p) => p.order_id !== orderRef))
      throw new ProviderError("unknown", undefined, "payment lookup returned another order");
    return items.find(isCaptured) ?? items.find((p) => p.status === "authorized") ?? items[items.length - 1];
  };
  const refundStatus = (s: string): RefundStatus => {
    if (s === "processed") return "succeeded";
    if (isRefundStatus(s)) return s;
    throw new ProviderError("unknown", undefined, `unknown refund status ${s}`);
  };
  const refundSnap = async (r: RzpRefund, orderRef?: string): Promise<RefundSnapshot> => {
    const payment = (await rzp.payments.fetch(r.payment_id)) as unknown as RzpPayment;
    if (payment.id !== r.payment_id || (orderRef !== undefined && payment.order_id !== orderRef))
      throw new ProviderError("unknown", undefined, "refund response names another payment/order");
    const ref = payment.order_id;
    return {
      ref: r.id,
      paymentRef: ref,
      amount: providerMinor(r.amount),
      currency: r.currency.toUpperCase(),
      status: refundStatus(r.status),
      requestId: notesOf(r.notes).refund_request_id,
    };
  };
  return {
    name: "razorpay",
    // Pinned refund.minimum-amount contract applies to INR; other currency limits are unspecified here.
    refundRequestError: (amount, currency) =>
      currency === "INR" && amount < 100n ? "minimum Razorpay INR refund is 100 minor units" : undefined,
    createPayment: (p) =>
      guarded(
        "create payment",
        async () => {
          const o = (await rzp.orders.create({
            amount: sdkMinor(p.amount),
            currency: p.currency,
            receipt: p.orderId,
            notes: { order_id: p.orderId },
            payment_capture: p.capture === "automatic",
          } as never)) as unknown as {
            id: string;
            amount: unknown;
            currency: string;
            receipt?: string | null;
            notes?: unknown;
          };
          if (
            providerMinor(o.amount) !== p.amount ||
            o.currency.toUpperCase() !== p.currency ||
            (o.receipt != null && o.receipt !== p.orderId) ||
            (notesOf(o.notes).order_id !== undefined && notesOf(o.notes).order_id !== p.orderId)
          )
            throw new ProviderError("unknown", undefined, "order response changed money or identity");
          return {
            ...snapshot(o.id, undefined, { amount: p.amount, currency: p.currency, orderId: p.orderId }),
            clientSecret: o.id,
          };
        },
        statusOf,
      ),
    retrievePayment: (ref) =>
      guarded(
        "retrieve payment",
        async () => {
          const pay = await paymentOf(ref);
          if (pay) return snapshot(ref, pay);
          // Before the first customer attempt there is still an order with immutable amount/currency.
          const o = (await rzp.orders.fetch(ref)) as unknown as {
            id: string;
            amount: unknown;
            currency: string;
            notes?: unknown;
            receipt?: unknown;
          };
          if (o.id !== ref)
            throw new ProviderError("unknown", undefined, "order lookup returned another object");
          const orderId =
            notesOf(o.notes).order_id ?? (typeof o.receipt === "string" ? o.receipt : undefined);
          return snapshot(ref, undefined, {
            amount: providerMinor(o.amount),
            currency: o.currency,
            ...(orderId ? { orderId } : {}),
          });
        },
        statusOf,
      ),
    capture: (ref, p) =>
      guarded(
        "capture",
        async () => {
          const pay = await paymentOf(ref);
          if (!pay) throw new ProviderError("rejected", undefined, "no payment to capture");
          if (isCaptured(pay)) return snapshot(ref, pay);
          const captured = (await rzp.payments.capture(
            pay.id,
            sdkMinor(p.amount),
            p.currency,
          )) as unknown as RzpPayment;
          if (captured.id !== pay.id || captured.order_id !== ref)
            throw new ProviderError("unknown", undefined, "capture response names another payment/order");
          return snapshot(ref, captured);
        },
        statusOf,
      ),
    createRefund: (paymentRef, p) =>
      guarded(
        "create refund",
        async () => {
          const pay = await paymentOf(paymentRef);
          if (!pay || !isCaptured(pay))
            throw new ProviderError("rejected", undefined, "no captured payment to refund");
          // The SDK cannot send this header, so use its HTTP client for one visible POST.
          // An unknown result may have committed; no retry is safe without retention proof.
          const res = await rq.post(
            `/v1/payments/${encodeURIComponent(pay.id)}/refund`,
            { amount: sdkMinor(p.amount), notes: p.metadata },
            { headers: { "X-Refund-Idempotency": p.idempotencyKey } },
          );
          const r = res.data as RzpRefund;
          if (r.payment_id !== pay.id)
            throw new ProviderError("unknown", undefined, "refund response names another payment");
          try {
            return await refundSnap(r, paymentRef);
          } catch {
            throw new ProviderError(
              "unknown",
              undefined,
              "refund POST returned but its payment lookup failed",
            );
          }
        },
        statusOf,
      ),
    retrieveRefund: (ref) =>
      guarded(
        "retrieve refund",
        async () => {
          const r = (await rzp.refunds.fetch(ref)) as unknown as RzpRefund;
          if (r.id !== ref)
            throw new ProviderError("unknown", undefined, "refund lookup returned another object");
          return refundSnap(r);
        },
        statusOf,
      ),
    parseWebhook(raw, headers) {
      const sig = String(headers["x-razorpay-signature"] ?? "");
      let ok = false;
      try {
        ok = sig !== "" && Razorpay.validateWebhookSignature(raw, sig, secret);
      } catch {
        ok = false;
      }
      if (!ok) throw new SignatureError("invalid signature");
      const ev = JSON.parse(raw) as {
        event?: string;
        payload?: {
          payment?: { entity?: RzpPayment };
          refund?: { entity?: RzpRefund };
          order?: { entity?: { id?: string } };
        };
      };
      const type = String(ev.event ?? "");
      // Razorpay re-sends a duplicate with the same x-razorpay-event-id; without the header, dedupe on the signed body
      const header = headers["x-razorpay-event-id"];
      const eventId =
        typeof header === "string" && header
          ? header
          : `body_${createHash("sha256").update(raw).digest("hex")}`;
      const pay = ev.payload?.payment?.entity;
      const ref = ev.payload?.refund?.entity;
      const orderRef = pay?.order_id ?? ev.payload?.order?.entity?.id;
      if (type.startsWith("refund.") && ref?.id)
        return {
          eventId,
          type,
          object: "refund",
          ref: ref.id,
          ...(orderRef ? { paymentRef: orderRef } : {}),
        };
      if ((type.startsWith("payment.") || type.startsWith("order.")) && orderRef)
        return { eventId, type, object: "payment", ref: orderRef };
      return { eventId, type, object: "none", ref: "" };
    },
  };
}

export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): PaymentProvider {
  const name = env.PAYMENT_PROVIDER ?? "stripe";
  if (name === "stripe") return stripeProvider(env);
  if (name === "razorpay") return razorpayProvider(env);
  throw new Error(`unknown PAYMENT_PROVIDER ${name}`);
}
