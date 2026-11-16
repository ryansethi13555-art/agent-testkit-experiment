// LeakyBazaar's payment provider port: the marketplace logic (server.ts) is provider-neutral; each adapter wraps one
// official SDK. Selected by PAYMENT_PROVIDER (stripe | razorpay). Credentials come from env only (no secrets here).
import { createHash } from "node:crypto";
import type http from "node:http";
import Razorpay from "razorpay";
import Stripe from "stripe";
import { parseMinor, type RefundStatus, sdkMinor, stripeRefundStatus } from "./money.ts";

export type PaymentStatus = "succeeded" | "requires_capture" | "pending" | "failed" | "canceled";
export interface Payment {
  /** The reference the app stores for the order (Stripe PaymentIntent id, Razorpay order id). */
  readonly ref: string;
  readonly status: PaymentStatus;
  readonly amount: bigint;
  readonly amountReceived: bigint;
  readonly currency: string;
  readonly orderId: string | undefined;
  readonly clientSecret: string | null;
}
export interface Refund {
  /** Local reservation identity echoed from API metadata/notes, when present. */
  readonly requestId?: string | undefined;
  readonly ref: string;
  /** Payment reference in the same form as Payment.ref (to find the order). */
  readonly paymentRef: string | undefined;
  readonly amount: bigint;
  readonly currency: string;
  readonly status: RefundStatus;
}
export type WebhookEvent = { readonly eventId: string } & (
  | {
      readonly kind: "payment_succeeded";
      readonly objectId: string;
      readonly type: string;
      readonly payment: Payment;
    }
  | {
      readonly kind: "payment_observed";
      readonly objectId: string;
      readonly type: string;
      readonly payment: Payment;
    }
  | {
      readonly kind: "refund_changed";
      readonly objectId: string;
      readonly type: string;
      readonly refund: Refund;
    }
  | { readonly kind: "ignored"; readonly objectId: string; readonly type: string }
);

export class SignatureError extends Error {}

function checkRefundMetadata(
  observed: Record<string, string> | null | undefined,
  expected: Record<string, string>,
): void {
  for (const field of ["order_id", "line_id", "refund_id"])
    if (observed?.[field] !== undefined && observed[field] !== expected[field])
      throw new Error(`provider refund ${field} differs from request`);
}

export interface PaymentProvider {
  readonly name: string;
  createPayment(p: {
    orderId: string;
    amount: bigint;
    currency: string;
    capture: "automatic" | "manual";
  }): Promise<Payment>;
  retrievePayment(ref: string): Promise<Payment>;
  /** Current refund object; webhook delivery order is not provider state order. */
  retrieveRefund(ref: string): Promise<Refund>;
  capture(ref: string, p: { amount: bigint; currency: string; idempotencyKey: string }): Promise<Payment>;
  /** Release an uncaptured authorisation. */
  cancel(ref: string): Promise<void>;
  /** Resolve the exact provider object used by a refund before its first attempt. */
  refundTarget(ref: string): Promise<string>;
  /** Pure request validation before a reservation or any money-moving provider I/O. */
  refundRequestError?(amount: bigint, currency: string): string | undefined;
  refund(
    ref: string,
    p: { amount: bigint; idempotencyKey: string; metadata: Record<string, string>; targetRef?: string },
  ): Promise<Refund>;
  /** Verify the signature over the raw body and normalise the event. Throws SignatureError. */
  parseWebhook(raw: string, headers: http.IncomingHttpHeaders): Promise<WebhookEvent>;
  isProviderError(e: unknown): boolean;
  /** Only a provider response that proves this refund POST created no refund. */
  definitiveRefundRejection(e: unknown): string | undefined;
}

// ---------------------------------------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------------------------------------
function stripeProvider(env: NodeJS.ProcessEnv): PaymentProvider {
  // MoneyInvariant redirect (ADR 0003): one guarded line, active only in test runs.
  const miBase = env.MONEYINV_STRIPE_API_BASE ? new URL(env.MONEYINV_STRIPE_API_BASE) : null;
  const key = env.STRIPE_SECRET_KEY ?? "sk_test_missing";
  const endpoint = miBase
    ? {
        host: miBase.hostname,
        port: miBase.port,
        protocol: (miBase.protocol === "http:" ? "http" : "https") as "http" | "https",
      }
    : {};
  const stripe = new Stripe(key, { ...endpoint, maxNetworkRetries: 2 });
  // stripe-node's Node transport retries closed sockets once even at maxNetworkRetries: 0.
  // Its public Fetch transport surfaces that uncertainty to the durable refund worker.
  const refundStripe = new Stripe(key, {
    ...endpoint,
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(),
  });
  const secret = env.STRIPE_WEBHOOK_SECRET ?? "";
  const payment = (pi: Stripe.PaymentIntent): Payment => ({
    ref: pi.id,
    status:
      pi.status === "succeeded"
        ? "succeeded"
        : pi.status === "requires_capture"
          ? "requires_capture"
          : pi.status === "canceled"
            ? "canceled"
            : pi.last_payment_error
              ? "failed"
              : "pending",
    amount: parseMinor(pi.amount),
    amountReceived: parseMinor(pi.amount_received),
    currency: pi.currency.toUpperCase(),
    orderId: pi.metadata?.order_id,
    clientSecret: pi.client_secret,
  });
  const refund = (r: Stripe.Refund): Refund => ({
    ref: r.id,
    requestId: r.metadata?.refund_id,
    paymentRef: typeof r.payment_intent === "string" ? r.payment_intent : r.payment_intent?.id,
    amount: parseMinor(r.amount),
    currency: r.currency.toUpperCase(),
    status: stripeRefundStatus(r.status),
  });
  return {
    name: "stripe",
    async createPayment(p) {
      const pi = await refundStripe.paymentIntents.create(
        {
          amount: sdkMinor(p.amount),
          currency: p.currency.toLowerCase(),
          capture_method: p.capture,
          metadata: { order_id: p.orderId },
        },
        { idempotencyKey: `checkout_${p.orderId}` },
      );
      return payment(pi);
    },
    retrievePayment: async (ref) => payment(await stripe.paymentIntents.retrieve(ref)),
    retrieveRefund: async (ref) => refund(await stripe.refunds.retrieve(ref)),
    capture: async (ref, p) =>
      payment(await stripe.paymentIntents.capture(ref, {}, { idempotencyKey: p.idempotencyKey })),
    async cancel(ref) {
      await stripe.paymentIntents.cancel(ref);
    },
    refundTarget: async (ref) => ref,
    async refund(ref, p) {
      if (p.targetRef !== undefined && p.targetRef !== ref)
        throw new Error("refund target differs from requested payment");
      const created = await refundStripe.refunds.create(
        { payment_intent: ref, amount: sdkMinor(p.amount), metadata: p.metadata },
        // The durable worker records ambiguity between POSTs; SDK retries would hide an
        // uncertain first attempt if a later internal retry received a definitive rejection.
        { idempotencyKey: p.idempotencyKey, maxNetworkRetries: 0 },
      );
      checkRefundMetadata(created.metadata, p.metadata);
      return refund(created);
    },
    async parseWebhook(raw, headers) {
      let ev: Stripe.Event;
      try {
        ev = stripe.webhooks.constructEvent(raw, String(headers["stripe-signature"] ?? ""), secret);
      } catch {
        throw new SignatureError("invalid signature");
      }
      const obj = ev.data.object as unknown as {
        id: string;
        amount: number;
        currency: string;
        receipt: string;
      };
      if (!ev.id) throw new SignatureError("missing event identity");
      // Transport duplicates dedupe by event identity; object locks protect repeated economic effects.
      if (ev.type === "payment_intent.succeeded")
        return {
          eventId: ev.id,
          kind: "payment_succeeded",
          objectId: obj.id,
          type: ev.type,
          payment: payment(ev.data.object as Stripe.PaymentIntent),
        };
      if (ev.type === "payment_intent.created" || ev.type === "payment_intent.amount_capturable_updated")
        return {
          eventId: ev.id,
          kind: "payment_observed",
          objectId: obj.id,
          type: ev.type,
          payment: payment(ev.data.object as Stripe.PaymentIntent),
        };
      if (ev.type === "refund.created" || ev.type === "refund.updated" || ev.type === "refund.failed")
        return {
          eventId: ev.id,
          kind: "refund_changed",
          objectId: obj.id,
          type: ev.type,
          refund: refund(ev.data.object as Stripe.Refund),
        };
      return { eventId: ev.id, kind: "ignored", objectId: obj.id, type: ev.type };
    },
    isProviderError: (e) =>
      typeof (e as { type?: unknown })?.type === "string" &&
      String((e as { type: string }).type).startsWith("Stripe"),
    definitiveRefundRejection: (e) => {
      const error = e as { type?: unknown; statusCode?: unknown; code?: unknown };
      // Stripe idempotency.rate-limit-precedes: this request did not reach endpoint execution.
      if (error?.type === "StripeRateLimitError" && error.statusCode === 429) return "rate_limited";
      return error?.type === "StripeInvalidRequestError" &&
        error.statusCode === 400 &&
        error.code === "amount_too_large"
        ? "amount_too_large"
        : undefined;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Razorpay (Orders API: the app stores the order id; payments hang off the order)
// ---------------------------------------------------------------------------------------------------------
interface RzpPayment {
  id: string;
  status: string;
  amount: number;
  currency: string;
  order_id: string;
  notes?: Record<string, string>;
}
interface RzpRefund {
  notes?: Record<string, string>;
  id: string;
  payment_id: string;
  amount: number;
  currency: string;
  status: string;
}

function razorpayProvider(env: NodeJS.ProcessEnv): PaymentProvider {
  const rzp = new Razorpay({
    key_id: env.RAZORPAY_KEY_ID ?? "rzp_test_missing",
    key_secret: env.RAZORPAY_KEY_SECRET ?? "",
  });
  // MoneyInvariant redirect (ADR 0003): razorpay-node has no public base-URL option; version-pinned internal seam.
  const rq = (
    rzp as unknown as {
      api: {
        rq: {
          defaults: { baseURL: string };
          post: (path: string, body: unknown, options: unknown) => Promise<{ data: unknown }>;
        };
      };
    }
  ).api.rq;
  if (env.MONEYINV_RAZORPAY_API_BASE) rq.defaults.baseURL = env.MONEYINV_RAZORPAY_API_BASE;
  const secret = env.RAZORPAY_WEBHOOK_SECRET ?? "";
  const statusOf = (s: string | undefined): PaymentStatus =>
    s === "captured" || s === "refunded"
      ? "succeeded"
      : s === "authorized"
        ? "requires_capture"
        : s === "failed"
          ? "failed"
          : "pending";
  const fromPayment = (orderRef: string, p: RzpPayment | undefined): Payment => {
    if (p && p.order_id !== orderRef)
      throw new Error("provider payment order identity differs from requested order");
    return {
      ref: orderRef,
      status: statusOf(p?.status),
      amount: p ? parseMinor(p.amount) : 0n,
      amountReceived: p && (p.status === "captured" || p.status === "refunded") ? parseMinor(p.amount) : 0n,
      currency: p?.currency.toUpperCase() ?? "",
      orderId: p?.notes?.order_id,
      clientSecret: null,
    };
  };
  /** The order's payment that matters: captured first, then authorised, then the latest attempt. */
  const paymentOf = async (orderRef: string): Promise<RzpPayment | undefined> => {
    const list = (await rzp.orders.fetchPayments(orderRef)) as unknown as { items: RzpPayment[] };
    return (
      list.items.find((p) => p.status === "captured" || p.status === "refunded") ??
      list.items.find((p) => p.status === "authorized") ??
      list.items[0]
    );
  };
  const refundStatus = (s: string): Refund["status"] =>
    s === "processed" ? "succeeded" : s === "failed" ? "failed" : "pending";
  return {
    name: "razorpay",
    // Pinned contract refund.minimum-amount applies to INR; do not invent other currency limits.
    refundRequestError: (amount, currency) =>
      currency === "INR" && amount < 100n ? "minimum Razorpay INR refund is 100 minor units" : undefined,
    async createPayment(p) {
      const o = (await rzp.orders.create({
        amount: sdkMinor(p.amount),
        currency: p.currency,
        receipt: p.orderId,
        notes: { order_id: p.orderId },
        payment_capture: p.capture === "automatic",
      } as never)) as unknown as {
        id: string;
        amount: number;
        currency: string;
        receipt?: string | null;
        notes?: Record<string, string> | null;
      };
      if (o.receipt && o.notes?.order_id && o.receipt !== o.notes.order_id)
        throw new Error("provider order receipt and notes disagree");
      return {
        ref: o.id,
        status: "pending",
        amount: parseMinor(o.amount),
        amountReceived: 0n,
        currency: o.currency.toUpperCase(),
        orderId: o.receipt || o.notes?.order_id,
        clientSecret: o.id,
      };
    },
    retrievePayment: async (ref) => fromPayment(ref, await paymentOf(ref)),
    async retrieveRefund(ref) {
      const r = (await rzp.refunds.fetch(ref)) as unknown as RzpRefund;
      if (r.id !== ref) throw new Error("retrieved refund identity differs from requested refund");
      const p = (await rzp.payments.fetch(r.payment_id)) as unknown as RzpPayment;
      if (p.id !== r.payment_id) throw new Error("retrieved refund payment identity differs from payment");
      return {
        ref: r.id,
        requestId: r.notes?.refund_id,
        paymentRef: p.order_id,
        amount: parseMinor(r.amount),
        currency: r.currency.toUpperCase(),
        status: refundStatus(r.status),
      };
    },
    async capture(ref, p) {
      const pay = await paymentOf(ref);
      if (!pay) throw new Error("no payment to capture");
      const captured = (await rzp.payments.capture(
        pay.id,
        sdkMinor(p.amount),
        p.currency,
      )) as unknown as RzpPayment;
      return fromPayment(ref, captured);
    },
    async cancel() {
      // Razorpay has no API to void an authorisation: uncaptured payments are refunded automatically
      // (contracts/razorpay payment.uncaptured-auto-refund).
    },
    async refundTarget(ref) {
      const pay = await paymentOf(ref);
      if (!pay || (pay.status !== "captured" && pay.status !== "refunded"))
        throw new Error("no captured payment to refund");
      if (pay.order_id !== ref)
        throw new Error("provider payment order identity differs from requested order");
      return pay.id;
    },
    async refund(ref, p) {
      const targetRef = p.targetRef ?? (await this.refundTarget(ref));
      // razorpay-node 2.9.8 does not expose this header. Its configured HTTP client retains SDK auth
      // and the MoneyInvariant loopback redirect; the documented key makes an unknown result retryable.
      const r = (
        await rq.post(
          `/v1/payments/${encodeURIComponent(targetRef)}/refund`,
          { amount: sdkMinor(p.amount), notes: p.metadata },
          { headers: { "X-Refund-Idempotency": p.idempotencyKey } },
        )
      ).data as RzpRefund;
      if (r.payment_id !== targetRef)
        throw new Error("provider refund payment identity differs from requested payment");
      checkRefundMetadata(r.notes, p.metadata);
      return {
        ref: r.id,
        requestId: r.notes?.refund_id,
        paymentRef: ref,
        amount: parseMinor(r.amount),
        currency: r.currency.toUpperCase(),
        status: refundStatus(r.status),
      };
    },
    async parseWebhook(raw, headers) {
      const sig = String(headers["x-razorpay-signature"] ?? "");
      if (!sig || !Razorpay.validateWebhookSignature(raw, sig, secret))
        throw new SignatureError("invalid signature");
      const ev = JSON.parse(raw) as {
        event: string;
        payload: { payment?: { entity: RzpPayment }; refund?: { entity: RzpRefund } };
      };
      const eventId = String(
        headers["x-razorpay-event-id"] ?? createHash("sha256").update(raw).digest("hex"),
      );
      const pay = ev.payload.payment?.entity;
      const ref = ev.payload.refund?.entity;
      if (ev.event === "payment.captured" && pay)
        return {
          eventId,
          kind: "payment_succeeded",
          objectId: pay.id,
          type: ev.event,
          payment: fromPayment(pay.order_id, pay),
        };
      if (ev.event === "payment.authorized" && pay)
        return {
          eventId,
          kind: "payment_observed",
          objectId: pay.id,
          type: ev.event,
          payment: fromPayment(pay.order_id, pay),
        };
      if (ev.event.startsWith("refund.") && ref) {
        const payment = pay ?? ((await rzp.payments.fetch(ref.payment_id)) as unknown as RzpPayment);
        if (payment.id !== ref.payment_id)
          throw new Error("webhook refund payment identity differs from payment entity");
        const orderRef = payment.order_id;
        return {
          eventId,
          kind: "refund_changed",
          objectId: ref.id,
          type: ev.event,
          refund: {
            ref: ref.id,
            requestId: ref.notes?.refund_id,
            paymentRef: orderRef,
            amount: parseMinor(ref.amount),
            currency: ref.currency.toUpperCase(),
            status: refundStatus(ref.status),
          },
        };
      }
      return { eventId, kind: "ignored", objectId: pay?.id ?? ref?.id ?? "unknown", type: ev.event };
    },
    // SDK methods expose {statusCode,error}; the pinned HTTP seam exposes an Axios status/response.
    isProviderError: (e) =>
      (e as { statusCode?: unknown; status?: unknown })?.statusCode !== undefined ||
      (e as { status?: unknown })?.status !== undefined ||
      e instanceof TypeError,
    definitiveRefundRejection: (e) => {
      const error = e as {
        status?: unknown;
        response?: {
          status?: unknown;
          data?: { error?: { code?: unknown; description?: unknown; reason?: unknown } };
        };
      };
      // The pinned SDK exposes the Razorpay error envelope. BAD_REQUEST_ERROR alone also covers
      // idempotency and concurrent-operation conflicts, so require an exact no-commit validation error.
      const detail = error?.response?.data?.error;
      if (
        error?.status !== 400 ||
        error.response?.status !== 400 ||
        detail?.code !== "BAD_REQUEST_ERROR" ||
        detail.reason !== "input_validation_failed"
      )
        return undefined;
      if (detail.description === "The refund amount provided is greater than amount captured.")
        return "amount_too_large";
      if (detail.description === "The amount must be atleast INR 1.00") return "amount_invalid";
      // Pinned api.concurrent-payment-operation-rejected: this request did not execute. The
      // durable request still forbids release if a previous POST might have committed.
      if (detail.description === "Request failed because another payment operation is in progress.")
        return "concurrent_operation";
      return undefined;
    },
  };
}

export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): PaymentProvider {
  const name = env.PAYMENT_PROVIDER ?? "stripe";
  if (name === "stripe") return stripeProvider(env);
  if (name === "razorpay") return razorpayProvider(env);
  throw new Error(`unknown PAYMENT_PROVIDER ${name}`);
}
