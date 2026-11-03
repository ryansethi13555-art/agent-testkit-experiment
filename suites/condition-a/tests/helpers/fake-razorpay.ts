import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRazorpayOptions {
  webhookSecret?: string;
}

export interface FakeRzpOrder {
  id: string;
  entity: "order";
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt?: string | null;
  status: "created" | "attempted" | "paid";
  attempts: number;
  notes: Record<string, string>;
}

export interface FakeRzpPayment {
  id: string;
  entity: "payment";
  amount: number;
  currency: string;
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
  order_id: string;
  captured: boolean;
  notes: Record<string, string>;
}

export interface FakeRzpRefund {
  id: string;
  entity: "refund";
  amount: number;
  currency: string;
  payment_id: string;
  notes: Record<string, string>;
  status: "processed" | "failed" | "pending";
}

export class FakeRazorpayServer {
  readonly server: http.Server;
  readonly webhookSecret: string;
  port = 0;
  baseUrl = "";

  orders = new Map<string, FakeRzpOrder>();
  payments = new Map<string, FakeRzpPayment>();
  refunds = new Map<string, FakeRzpRefund>();
  idempotencyKeys = new Map<string, unknown>();

  calls: { method: string; path: string; headers: http.IncomingHttpHeaders; body: string }[] = [];

  onRequestHook?: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => boolean | Promise<boolean>;

  private orderCounter = 0;
  private payCounter = 0;
  private refundCounter = 0;
  private eventCounter = 0;

  constructor(opts: FakeRazorpayOptions = {}) {
    this.webhookSecret = opts.webhookSecret ?? "rzp_whsec_test_secret";

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

      let jsonBody: Record<string, unknown> = {};
      try {
        if (body) jsonBody = JSON.parse(body) as Record<string, unknown>;
      } catch {}

      const sendJson = (data: unknown, statusCode = 200) => {
        res.writeHead(statusCode, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };

      // 1. Create Order
      if (path === "/v1/orders" && method === "POST") {
        const id = `order_fake_${++this.orderCounter}_${Date.now()}`;
        const amount = Number(jsonBody.amount);
        const currency = String(jsonBody.currency ?? "INR").toUpperCase();
        const receipt = (jsonBody.receipt as string) ?? null;
        const notes = (jsonBody.notes as Record<string, string>) ?? {};

        const order: FakeRzpOrder = {
          id,
          entity: "order",
          amount,
          amount_paid: 0,
          amount_due: amount,
          currency,
          receipt,
          status: "created",
          attempts: 0,
          notes,
        };

        this.orders.set(id, order);
        return sendJson(order);
      }

      // 2. Fetch Order
      const orderFetchMatch = /^\/v1\/orders\/([a-zA-Z0-9_]+)$/.exec(path);
      if (orderFetchMatch && method === "GET") {
        const id = orderFetchMatch[1];
        const order = this.orders.get(id);
        if (!order) return sendJson({ error: { code: "BAD_REQUEST_ERROR", description: "order not found" } }, 404);
        return sendJson(order);
      }

      // 3. Fetch Payments of Order
      const orderPaymentsMatch = /^\/v1\/orders\/([a-zA-Z0-9_]+)\/payments$/.exec(path);
      if (orderPaymentsMatch && method === "GET") {
        const orderId = orderPaymentsMatch[1];
        const items = [...this.payments.values()].filter((p) => p.order_id === orderId);
        return sendJson({ entity: "collection", count: items.length, items });
      }

      // 4. Capture Payment
      const payCaptureMatch = /^\/v1\/payments\/([a-zA-Z0-9_]+)\/capture$/.exec(path);
      if (payCaptureMatch && method === "POST") {
        const payId = payCaptureMatch[1];
        const pay = this.payments.get(payId);
        if (!pay) return sendJson({ error: { code: "BAD_REQUEST_ERROR", description: "payment not found" } }, 404);
        pay.status = "captured";
        pay.captured = true;
        return sendJson(pay);
      }

      // 5. Fetch Payment
      const payFetchMatch = /^\/v1\/payments\/([a-zA-Z0-9_]+)$/.exec(path);
      if (payFetchMatch && method === "GET") {
        const payId = payFetchMatch[1];
        const pay = this.payments.get(payId);
        if (!pay) return sendJson({ error: { code: "BAD_REQUEST_ERROR", description: "payment not found" } }, 404);
        return sendJson(pay);
      }

      // 6. Create Refund
      const refundCreateMatch = /^\/v1\/payments\/([a-zA-Z0-9_]+)\/refund$/.exec(path);
      if (refundCreateMatch && method === "POST") {
        const payId = refundCreateMatch[1];
        const idempotencyKey = req.headers["x-refund-idempotency"] as string | undefined;

        if (idempotencyKey && this.idempotencyKeys.has(idempotencyKey)) {
          return sendJson(this.idempotencyKeys.get(idempotencyKey));
        }

        const pay = this.payments.get(payId);
        const amount = Number(jsonBody.amount);
        const notes = (jsonBody.notes as Record<string, string>) ?? {};

        const id = `rfnd_fake_${++this.refundCounter}_${Date.now()}`;
        const refund: FakeRzpRefund = {
          id,
          entity: "refund",
          amount,
          currency: pay?.currency ?? "INR",
          payment_id: payId,
          notes,
          status: "processed",
        };

        this.refunds.set(id, refund);
        if (idempotencyKey) this.idempotencyKeys.set(idempotencyKey, refund);
        return sendJson(refund);
      }

      // 7. Fetch Refund
      const refundFetchMatch = /^\/v1\/refunds\/([a-zA-Z0-9_]+)$/.exec(path);
      if (refundFetchMatch && method === "GET") {
        const refundId = refundFetchMatch[1];
        const refund = this.refunds.get(refundId);
        if (!refund) return sendJson({ error: { code: "BAD_REQUEST_ERROR", description: "refund not found" } }, 404);
        return sendJson(refund);
      }

      sendJson({ error: { code: "BAD_REQUEST_ERROR", description: `unknown endpoint ${method} ${path}` } }, 404);
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
    this.orders.clear();
    this.payments.clear();
    this.refunds.clear();
    this.idempotencyKeys.clear();
    this.calls = [];
    this.onRequestHook = undefined;
  }

  simulateCustomerPayment(orderId: string, status: "captured" | "authorized" = "captured"): FakeRzpPayment {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`order ${orderId} not found`);

    const payId = `pay_fake_${++this.payCounter}_${Date.now()}`;
    const pay: FakeRzpPayment = {
      id: payId,
      entity: "payment",
      amount: order.amount,
      currency: order.currency,
      status,
      order_id: orderId,
      captured: status === "captured",
      notes: { ...order.notes },
    };

    this.payments.set(payId, pay);
    if (status === "captured") {
      order.amount_paid = order.amount;
      order.amount_due = 0;
      order.status = "paid";
    }
    return pay;
  }

  signWebhook(rawBody: string): string {
    return createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
  }

  createPaymentCapturedWebhook(pay: FakeRzpPayment, eventId?: string): { id: string; payload: string; headers: Record<string, string> } {
    const id = eventId ?? `evt_pay_cap_${++this.eventCounter}`;
    const body = {
      event: "payment.captured",
      payload: {
        payment: { entity: pay },
      },
    };
    const payload = JSON.stringify(body);
    return {
      id,
      payload,
      headers: {
        "x-razorpay-signature": this.signWebhook(payload),
        "x-razorpay-event-id": id,
      },
    };
  }

  createRefundProcessedWebhook(pay: FakeRzpPayment, refund: FakeRzpRefund, eventId?: string): { id: string; payload: string; headers: Record<string, string> } {
    const id = eventId ?? `evt_ref_proc_${++this.eventCounter}`;
    const body = {
      event: "refund.processed",
      payload: {
        payment: { entity: pay },
        refund: { entity: refund },
      },
    };
    const payload = JSON.stringify(body);
    return {
      id,
      payload,
      headers: {
        "x-razorpay-signature": this.signWebhook(payload),
        "x-razorpay-event-id": id,
      },
    };
  }
}
