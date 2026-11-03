import http from "node:http";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";

export interface FakePaymentIntent {
  id: string;
  object: "payment_intent";
  amount: number;
  amount_received: number;
  currency: string;
  status: "requires_payment_method" | "requires_capture" | "succeeded" | "canceled";
  capture_method: "automatic" | "manual";
  client_secret: string;
  metadata: Record<string, string>;
  last_payment_error?: { message: string };
}

export interface FakeRefund {
  id: string;
  object: "refund";
  amount: number;
  currency: string;
  status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
  payment_intent: string;
  metadata: Record<string, string>;
}

export class MockStripeServer {
  server: http.Server;
  port = 0;
  pis = new Map<string, FakePaymentIntent>();
  refunds = new Map<string, FakeRefund>();
  idempotencyCache = new Map<string, { status: number; body: unknown }>();
  idempotencyInFlight = new Set<string>();
  piSeq = 0;
  refundSeq = 0;
  eventSeq = 0;

  // Fault injection hooks
  dropNext = false;
  dropCount = 0;
  dropCaptureCount = 0;
  failNextWith: { status: number; body: unknown } | null = null;
  failBeforeApplying: { status: number; body: unknown } | null = null;
  webhookSecret = "whsec_test_stripe_secret_12345";
  signer = new Stripe("sk_test_mock");

  constructor() {
    this.server = http.createServer(async (req, res) => {
      try {
        await this.handle(req, res);
      } catch (e) {
        console.error("MockStripeServer error:", e);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: (e as Error).message } }));
      }
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.port = (this.server.address() as AddressInfo).port;
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  reset(): void {
    this.pis.clear();
    this.refunds.clear();
    this.idempotencyCache.clear();
    this.idempotencyInFlight.clear();
    this.dropNext = false;
    this.dropCount = 0;
    this.dropCaptureCount = 0;
    this.failNextWith = null;
    this.failBeforeApplying = null;
  }

  private async readBody(req: http.IncomingMessage): Promise<string> {
    let s = "";
    for await (const chunk of req) s += chunk;
    return s;
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
    res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const rawBody = await this.readBody(req);
    const contentType = req.headers["content-type"] ?? "";
    const p = new URLSearchParams(rawBody);

    const idempotencyKey = req.headers["idempotency-key"] as string | undefined;

    if (this.failBeforeApplying) {
      const err = this.failBeforeApplying;
      this.failBeforeApplying = null;
      return this.sendJson(res, err.status, err.body);
    }

    if (idempotencyKey) {
      if (this.idempotencyInFlight.has(idempotencyKey)) {
        return this.sendJson(res, 409, {
          error: { type: "idempotency_error", message: "Keys in flight" },
        });
      }
      const cached = this.idempotencyCache.get(idempotencyKey);
      if (cached) {
        if (req.url?.includes("/capture") && this.dropCaptureCount > 0) {
          this.dropCaptureCount--;
          req.socket.destroy();
          return;
        }
        if (this.dropCount > 0) {
          this.dropCount--;
          req.socket.destroy();
          return;
        }
        if (this.dropNext) {
          this.dropNext = false;
          req.socket.destroy();
          return;
        }
        return this.sendJson(res, cached.status, cached.body, { "Idempotent-Replayed": "true" });
      }
      this.idempotencyInFlight.add(idempotencyKey);
    }

    const finalize = (status: number, body: unknown) => {
      if (idempotencyKey) {
        this.idempotencyInFlight.delete(idempotencyKey);
        this.idempotencyCache.set(idempotencyKey, { status, body });
      }
      if (this.dropCount > 0) {
        this.dropCount--;
        req.socket.destroy();
        return;
      }
      if (this.dropNext) {
        this.dropNext = false;
        req.socket.destroy();
        return;
      }
      if (this.failNextWith) {
        const fail = this.failNextWith;
        this.failNextWith = null;
        return this.sendJson(res, fail.status, fail.body);
      }
      this.sendJson(res, status, body);
    };

    const url = req.url ?? "";
    const method = req.method ?? "GET";

    // POST /v1/payment_intents
    if (url === "/v1/payment_intents" && method === "POST") {
      const id = `pi_${++this.piSeq}`;
      const amount = Number(p.get("amount") ?? 0);
      const currency = (p.get("currency") ?? "inr").toLowerCase();
      const captureMethod = (p.get("capture_method") ?? "automatic") as "automatic" | "manual";
      const metadata: Record<string, string> = {};
      for (const [k, v] of p.entries()) {
        const m = /^metadata\[(.*)\]$/.exec(k);
        if (m && m[1]) metadata[m[1]] = v;
      }
      const pi: FakePaymentIntent = {
        id,
        object: "payment_intent",
        amount,
        amount_received: 0,
        currency,
        status: captureMethod === "manual" ? "requires_capture" : "requires_payment_method",
        capture_method: captureMethod,
        client_secret: `${id}_secret`,
        metadata,
      };
      this.pis.set(id, pi);
      return finalize(200, pi);
    }

    // POST /v1/payment_intents/:id/capture
    const captureMatch = /^\/v1\/payment_intents\/([^/]+)\/capture$/.exec(url);
    if (captureMatch && captureMatch[1] && method === "POST") {
      const pi = this.pis.get(captureMatch[1]);
      if (!pi) {
        return finalize(404, { error: { message: "No such payment_intent" } });
      }
      pi.status = "succeeded";
      pi.amount_received = pi.amount;
      if (this.dropCaptureCount > 0) {
        this.dropCaptureCount--;
        if (idempotencyKey) {
          this.idempotencyInFlight.delete(idempotencyKey);
          this.idempotencyCache.set(idempotencyKey, { status: 200, body: pi });
        }
        req.socket.destroy();
        return;
      }
      return finalize(200, pi);
    }

    // POST /v1/payment_intents/:id/cancel
    const cancelMatch = /^\/v1\/payment_intents\/([^/]+)\/cancel$/.exec(url);
    if (cancelMatch && cancelMatch[1] && method === "POST") {
      const pi = this.pis.get(cancelMatch[1]);
      if (!pi) {
        return finalize(404, { error: { message: "No such payment_intent" } });
      }
      pi.status = "canceled";
      return finalize(200, pi);
    }

    // GET /v1/payment_intents/:id
    const getPiMatch = /^\/v1\/payment_intents\/([^/]+)$/.exec(url);
    if (getPiMatch && getPiMatch[1] && method === "GET") {
      const pi = this.pis.get(getPiMatch[1]);
      if (!pi) {
        return finalize(404, { error: { message: "No such payment_intent" } });
      }
      return finalize(200, pi);
    }

    // POST /v1/refunds
    if (url === "/v1/refunds" && method === "POST") {
      const paymentIntentId = p.get("payment_intent") ?? "";
      const amount = Number(p.get("amount") ?? 0);
      const pi = this.pis.get(paymentIntentId);
      if (!pi) {
        return finalize(404, { error: { message: "No such payment_intent" } });
      }

      // Calculate total existing non-failed refunds
      const existingRefunded = [...this.refunds.values()]
        .filter((r) => r.payment_intent === paymentIntentId && !["failed", "canceled"].includes(r.status))
        .reduce((sum, r) => sum + r.amount, 0);

      if (existingRefunded + amount > pi.amount) {
        return finalize(400, {
          error: {
            type: "invalid_request_error",
            code: "amount_too_large",
            message: "Refund amount exceeds refundable payment amount",
          },
        });
      }

      const metadata: Record<string, string> = {};
      for (const [k, v] of p.entries()) {
        const m = /^metadata\[(.*)\]$/.exec(k);
        if (m && m[1]) metadata[m[1]] = v;
      }

      const id = `re_${++this.refundSeq}`;
      const refund: FakeRefund = {
        id,
        object: "refund",
        amount,
        currency: pi.currency,
        status: "succeeded",
        payment_intent: paymentIntentId,
        metadata,
      };
      this.refunds.set(id, refund);
      return finalize(200, refund);
    }

    // GET /v1/refunds/:id
    const getRefundMatch = /^\/v1\/refunds\/([^/]+)$/.exec(url);
    if (getRefundMatch && getRefundMatch[1] && method === "GET") {
      const ref = this.refunds.get(getRefundMatch[1]);
      if (!ref) {
        return finalize(404, { error: { message: "No such refund" } });
      }
      return finalize(200, ref);
    }

    // 404 for unknown endpoints
    finalize(404, { error: { message: `Cannot ${method} ${url}` } });
  }

  buildWebhookEvent(type: string, dataObject: unknown, eventId?: string): { payload: string; headers: Record<string, string> } {
    const id = eventId ?? `evt_${++this.eventSeq}`;
    const event = {
      id,
      object: "event",
      type,
      data: { object: dataObject },
    };
    const payload = JSON.stringify(event);
    const header = this.signer.webhooks.generateTestHeaderString({
      payload,
      secret: this.webhookSecret,
    });
    return {
      payload,
      headers: {
        "content-type": "application/json",
        "stripe-signature": header,
      },
    };
  }
}
