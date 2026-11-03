import http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";

export interface FakeRazorpayOrder {
  id: string;
  entity: "order";
  amount: number;
  amount_paid: number;
  currency: string;
  receipt?: string;
  status: "created" | "attempted" | "paid";
  notes?: Record<string, string>;
  payments: string[];
}

export interface FakeRazorpayPayment {
  id: string;
  entity: "payment";
  order_id: string;
  amount: number;
  currency: string;
  status: "authorized" | "captured" | "failed" | "refunded";
  notes?: Record<string, string>;
}

export interface FakeRazorpayRefund {
  id: string;
  entity: "refund";
  payment_id: string;
  amount: number;
  currency: string;
  status: "pending" | "processed" | "failed";
  notes?: Record<string, string>;
}

export class MockRazorpayServer {
  server: http.Server;
  port = 0;
  orders = new Map<string, FakeRazorpayOrder>();
  payments = new Map<string, FakeRazorpayPayment>();
  refunds = new Map<string, FakeRazorpayRefund>();
  refundIdemCache = new Map<string, FakeRazorpayRefund>();
  orderSeq = 0;
  paymentSeq = 0;
  refundSeq = 0;
  eventSeq = 0;

  webhookSecret = "whsec_test_rzp_secret_67890";
  dropNext = false;
  failNextWith: { status: number; body: unknown } | null = null;
  failBeforeApplying: { status: number; body: unknown } | null = null;
  concurrentOperation = false;

  constructor() {
    this.server = http.createServer(async (req, res) => {
      try {
        await this.handle(req, res);
      } catch (e) {
        console.error("MockRazorpayServer error:", e);
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
    this.orders.clear();
    this.payments.clear();
    this.refunds.clear();
    this.refundIdemCache.clear();
    this.dropNext = false;
    this.failNextWith = null;
    this.failBeforeApplying = null;
    this.concurrentOperation = false;
  }

  private async readBody(req: http.IncomingMessage): Promise<string> {
    let s = "";
    for await (const chunk of req) s += chunk;
    return s;
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const rawBody = await this.readBody(req);
    let parsedBody: Record<string, unknown> = {};
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        const params = new URLSearchParams(rawBody);
        for (const [k, v] of params.entries()) parsedBody[k] = v;
      }
    }

    if (this.failBeforeApplying) {
      const err = this.failBeforeApplying;
      this.failBeforeApplying = null;
      return this.sendJson(res, err.status, err.body);
    }

    if (this.concurrentOperation) {
      return this.sendJson(res, 400, {
        error: {
          code: "BAD_REQUEST_ERROR",
          description: "Request failed because another payment operation is in progress.",
          reason: "input_validation_failed",
        },
      });
    }

    const finalize = (status: number, body: unknown) => {
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

    // POST /v1/orders
    if (url === "/v1/orders" && method === "POST") {
      const id = `order_${++this.orderSeq}`;
      const amount = Number(parsedBody.amount ?? 0);
      const currency = String(parsedBody.currency ?? "INR").toUpperCase();
      const receipt = parsedBody.receipt ? String(parsedBody.receipt) : undefined;
      const notes = (parsedBody.notes ?? {}) as Record<string, string>;
      const autoCapture = parsedBody.payment_capture === true || parsedBody.payment_capture === 1;

      const order: FakeRazorpayOrder = {
        id,
        entity: "order",
        amount,
        amount_paid: 0,
        currency,
        receipt,
        status: "created",
        notes,
        payments: [],
      };
      this.orders.set(id, order);

      // Create an initial payment for this order
      const payId = `pay_${++this.paymentSeq}`;
      const payment: FakeRazorpayPayment = {
        id: payId,
        entity: "payment",
        order_id: id,
        amount,
        currency,
        status: autoCapture ? "captured" : "authorized",
        notes,
      };
      if (autoCapture) order.amount_paid = amount;
      this.payments.set(payId, payment);
      order.payments.push(payId);

      return finalize(200, order);
    }

    // GET /v1/orders/:id/payments
    const orderPaymentsMatch = /^\/v1\/orders\/([^/]+)\/payments$/.exec(url);
    if (orderPaymentsMatch && orderPaymentsMatch[1] && method === "GET") {
      const order = this.orders.get(orderPaymentsMatch[1]);
      if (!order) return finalize(404, { error: { description: "Order not found" } });
      const items = order.payments.map((pid) => this.payments.get(pid)).filter(Boolean);
      return finalize(200, { entity: "collection", count: items.length, items });
    }

    // GET /v1/payments/:id
    const getPaymentMatch = /^\/v1\/payments\/([^/]+)$/.exec(url);
    if (getPaymentMatch && getPaymentMatch[1] && method === "GET") {
      const p = this.payments.get(getPaymentMatch[1]);
      if (!p) return finalize(404, { error: { description: "Payment not found" } });
      return finalize(200, p);
    }

    // POST /v1/payments/:id/capture
    const captureMatch = /^\/v1\/payments\/([^/]+)\/capture$/.exec(url);
    if (captureMatch && captureMatch[1] && method === "POST") {
      const p = this.payments.get(captureMatch[1]);
      if (!p) return finalize(404, { error: { description: "Payment not found" } });
      p.status = "captured";
      const order = this.orders.get(p.order_id);
      if (order) {
        order.status = "paid";
        order.amount_paid = p.amount;
      }
      return finalize(200, p);
    }

    // POST /v1/payments/:id/refund
    const refundMatch = /^\/v1\/payments\/([^/]+)\/refund$/.exec(url);
    if (refundMatch && refundMatch[1] && method === "POST") {
      const paymentId = decodeURIComponent(refundMatch[1]);
      const p = this.payments.get(paymentId);
      if (!p) return finalize(404, { error: { description: "Payment not found" } });

      const idemKey = req.headers["x-refund-idempotency"] as string | undefined;
      if (idemKey && this.refundIdemCache.has(idemKey)) {
        return finalize(200, this.refundIdemCache.get(idemKey));
      }

      const amount = Number(parsedBody.amount ?? 0);
      if (p.currency === "INR" && amount < 100) {
        return finalize(400, {
          error: {
            code: "BAD_REQUEST_ERROR",
            description: "The amount must be atleast INR 1.00",
            reason: "input_validation_failed",
          },
        });
      }

      // Check existing refunds
      const existingRefunded = [...this.refunds.values()]
        .filter((r) => r.payment_id === paymentId && r.status !== "failed")
        .reduce((sum, r) => sum + r.amount, 0);

      if (existingRefunded + amount > p.amount) {
        return finalize(400, {
          error: {
            code: "BAD_REQUEST_ERROR",
            description: "The refund amount provided is greater than amount captured.",
            reason: "input_validation_failed",
          },
        });
      }

      const rfndId = `rfnd_${++this.refundSeq}`;
      const refund: FakeRazorpayRefund = {
        id: rfndId,
        entity: "refund",
        payment_id: paymentId,
        amount,
        currency: p.currency,
        status: "processed",
        notes: (parsedBody.notes ?? {}) as Record<string, string>,
      };
      this.refunds.set(rfndId, refund);
      if (idemKey) this.refundIdemCache.set(idemKey, refund);
      return finalize(200, refund);
    }

    // GET /v1/refunds/:id
    const getRefundMatch = /^\/v1\/refunds\/([^/]+)$/.exec(url);
    if (getRefundMatch && getRefundMatch[1] && method === "GET") {
      const r = this.refunds.get(getRefundMatch[1]);
      if (!r) return finalize(404, { error: { description: "Refund not found" } });
      return finalize(200, r);
    }

    finalize(404, { error: { message: `Cannot ${method} ${url}` } });
  }

  buildWebhookEvent(event: string, entities: { payment?: unknown; refund?: unknown; order?: unknown }, eventId?: string): { payload: string; headers: Record<string, string> } {
    const payload: Record<string, { entity: unknown }> = {};
    const contains: string[] = [];
    if (entities.payment) {
      payload.payment = { entity: entities.payment };
      contains.push("payment");
    }
    if (entities.refund) {
      payload.refund = { entity: entities.refund };
      contains.push("refund");
    }
    if (entities.order) {
      payload.order = { entity: entities.order };
      contains.push("order");
    }
    const raw = JSON.stringify({
      entity: "event",
      account_id: "acc_mock_rzp",
      event,
      contains,
      payload,
    });
    const sig = crypto.createHmac("sha256", this.webhookSecret).update(raw).digest("hex");
    const id = eventId ?? `evt_${++this.eventSeq}`;
    return {
      payload: raw,
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": sig,
        "x-razorpay-event-id": id,
      },
    };
  }
}
