import http from "node:http";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";

export interface FakeStripeOptions {
  webhookSecret?: string;
}

export interface FakeStripePaymentIntent {
  id: string;
  object: "payment_intent";
  amount: number;
  amount_received: number;
  currency: string;
  capture_method: "automatic" | "manual";
  status: "requires_payment_method" | "requires_capture" | "succeeded" | "canceled";
  client_secret: string;
  metadata: Record<string, string>;
  last_payment_error?: { message: string } | null;
}

export interface FakeStripeRefund {
  id: string;
  object: "refund";
  amount: number;
  currency: string;
  status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
  payment_intent: string;
  metadata: Record<string, string>;
}

export class FakeStripeServer {
  readonly server: http.Server;
  readonly webhookSecret: string;
  port = 0;
  baseUrl = "";
  signer: Stripe;

  payments = new Map<string, FakeStripePaymentIntent>();
  refunds = new Map<string, FakeStripeRefund>();
  idempotencyKeys = new Map<string, unknown>();

  calls: { method: string; path: string; headers: http.IncomingHttpHeaders; body: string }[] = [];

  // Fault injection hooks
  onRequestHook?: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => boolean | Promise<boolean>;

  private piCounter = 0;
  private refundCounter = 0;
  private eventCounter = 0;

  constructor(opts: FakeStripeOptions = {}) {
    this.webhookSecret = opts.webhookSecret ?? "whsec_test_secret";
    this.signer = new Stripe("sk_test_fake");

    this.server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;

      const path = req.url ?? "";
      const method = req.method ?? "GET";
      this.calls.push({ method, path, headers: req.headers, body });

      if (this.onRequestHook) {
        const handled = await this.onRequestHook(req, res, body);
        if (handled) return;
      }

      const params = new URLSearchParams(body);
      const idempotencyKey = req.headers["idempotency-key"] as string | undefined;

      const sendJson = (data: unknown, statusCode = 200) => {
        res.writeHead(statusCode, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };

      // 1. Create PaymentIntent
      if (path === "/v1/payment_intents" && method === "POST") {
        if (idempotencyKey && this.idempotencyKeys.has(idempotencyKey)) {
          return sendJson(this.idempotencyKeys.get(idempotencyKey));
        }

        const id = `pi_fake_${++this.piCounter}_${Date.now()}`;
        const metadata: Record<string, string> = {};
        for (const [k, v] of params.entries()) {
          const match = /^metadata\[(.*)\]$/.exec(k);
          if (match) metadata[match[1]] = v;
        }

        const amount = Number(params.get("amount"));
        const currency = (params.get("currency") ?? "inr").toLowerCase();
        const captureMethod = (params.get("capture_method") ?? "automatic") as "automatic" | "manual";

        const pi: FakeStripePaymentIntent = {
          id,
          object: "payment_intent",
          amount,
          amount_received: 0,
          currency,
          capture_method: captureMethod,
          status: "requires_payment_method",
          client_secret: `${id}_secret`,
          metadata,
        };

        this.payments.set(id, pi);
        if (idempotencyKey) this.idempotencyKeys.set(idempotencyKey, pi);
        return sendJson(pi);
      }

      // 2. Retrieve PaymentIntent
      const piRetrieveMatch = /^\/v1\/payment_intents\/([a-zA-Z0-9_]+)$/.exec(path);
      if (piRetrieveMatch && method === "GET") {
        const id = piRetrieveMatch[1];
        const pi = this.payments.get(id);
        if (!pi) return sendJson({ error: { type: "invalid_request_error", message: "no such payment intent" } }, 404);
        return sendJson(pi);
      }

      // 3. Capture PaymentIntent
      const piCaptureMatch = /^\/v1\/payment_intents\/([a-zA-Z0-9_]+)\/capture$/.exec(path);
      if (piCaptureMatch && method === "POST") {
        const id = piCaptureMatch[1];
        const pi = this.payments.get(id);
        if (!pi) return sendJson({ error: { type: "invalid_request_error", message: "no such payment intent" } }, 404);
        pi.status = "succeeded";
        pi.amount_received = pi.amount;
        return sendJson(pi);
      }

      // 4. Cancel PaymentIntent
      const piCancelMatch = /^\/v1\/payment_intents\/([a-zA-Z0-9_]+)\/cancel$/.exec(path);
      if (piCancelMatch && method === "POST") {
        const id = piCancelMatch[1];
        const pi = this.payments.get(id);
        if (!pi) return sendJson({ error: { type: "invalid_request_error", message: "no such payment intent" } }, 404);
        pi.status = "canceled";
        return sendJson(pi);
      }

      // 5. Create Refund
      if (path === "/v1/refunds" && method === "POST") {
        if (idempotencyKey && this.idempotencyKeys.has(idempotencyKey)) {
          return sendJson(this.idempotencyKeys.get(idempotencyKey));
        }

        const piId = params.get("payment_intent") ?? "";
        const amount = Number(params.get("amount"));
        const pi = this.payments.get(piId);

        const metadata: Record<string, string> = {};
        for (const [k, v] of params.entries()) {
          const match = /^metadata\[(.*)\]$/.exec(k);
          if (match) metadata[match[1]] = v;
        }

        const id = `re_fake_${++this.refundCounter}_${Date.now()}`;
        const refund: FakeStripeRefund = {
          id,
          object: "refund",
          amount,
          currency: pi?.currency ?? "inr",
          status: "succeeded",
          payment_intent: piId,
          metadata,
        };

        this.refunds.set(id, refund);
        if (idempotencyKey) this.idempotencyKeys.set(idempotencyKey, refund);
        return sendJson(refund);
      }

      // 6. Retrieve Refund
      const refundRetrieveMatch = /^\/v1\/refunds\/([a-zA-Z0-9_]+)$/.exec(path);
      if (refundRetrieveMatch && method === "GET") {
        const id = refundRetrieveMatch[1];
        const refund = this.refunds.get(id);
        if (!refund) return sendJson({ error: { type: "invalid_request_error", message: "no such refund" } }, 404);
        return sendJson(refund);
      }

      // Fallback 404
      sendJson({ error: { type: "invalid_request_error", message: `unknown route ${method} ${path}` } }, 404);
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  reset(): void {
    this.payments.clear();
    this.refunds.clear();
    this.idempotencyKeys.clear();
    this.calls = [];
    this.onRequestHook = undefined;
  }

  markPaid(piId: string): FakeStripePaymentIntent {
    const pi = this.payments.get(piId);
    if (!pi) throw new Error(`no payment intent ${piId}`);
    pi.status = "succeeded";
    pi.amount_received = pi.amount;
    return pi;
  }

  markAuthorized(piId: string): FakeStripePaymentIntent {
    const pi = this.payments.get(piId);
    if (!pi) throw new Error(`no payment intent ${piId}`);
    pi.status = "requires_capture";
    return pi;
  }

  constructWebhookHeader(payload: string): string {
    return this.signer.webhooks.generateTestHeaderString({
      payload,
      secret: this.webhookSecret,
    });
  }

  createPaymentIntentSucceededEvent(piId: string, eventId?: string): { id: string; type: string; payload: string; headers: Record<string, string> } {
    const pi = this.markPaid(piId);
    const id = eventId ?? `evt_pi_succ_${++this.eventCounter}`;
    const event = {
      id,
      object: "event",
      type: "payment_intent.succeeded",
      data: { object: pi },
    };
    const payload = JSON.stringify(event);
    return {
      id,
      type: event.type,
      payload,
      headers: {
        "stripe-signature": this.constructWebhookHeader(payload),
      },
    };
  }

  createRefundEvent(refundId: string, type: "refund.created" | "refund.updated" | "refund.failed" = "refund.updated", eventId?: string): { id: string; type: string; payload: string; headers: Record<string, string> } {
    const refund = this.refunds.get(refundId);
    if (!refund) throw new Error(`no refund ${refundId}`);
    const id = eventId ?? `evt_ref_${++this.eventCounter}`;
    const event = {
      id,
      object: "event",
      type,
      data: { object: refund },
    };
    const payload = JSON.stringify(event);
    return {
      id,
      type,
      payload,
      headers: {
        "stripe-signature": this.constructWebhookHeader(payload),
      },
    };
  }
}
