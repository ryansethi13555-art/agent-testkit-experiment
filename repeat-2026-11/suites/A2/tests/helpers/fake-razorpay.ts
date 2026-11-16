// In-memory Razorpay HTTP fake (Orders API; payments hang off the order) with fault injection.
import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export const RZP_WHSEC = "rzp_whsec_independent";

export interface RzpOrder {
  id: string;
  entity: "order";
  amount: number;
  currency: string;
  receipt: string | null;
  notes: Record<string, string>;
  status: string;
  payment_capture: boolean;
}
export interface RzpPay {
  id: string;
  entity: "payment";
  status: string;
  amount: number;
  currency: string;
  order_id: string;
  notes: Record<string, string>;
  captured: boolean;
  amount_refunded: number;
}
export interface RzpRef {
  id: string;
  entity: "refund";
  payment_id: string;
  amount: number;
  currency: string;
  status: string;
  notes: Record<string, string>;
}
export interface RzpFault {
  match: RegExp;
  kind: "apply_then_500" | "apply_then_drop" | "drop" | "500";
  times: number;
}

export class FakeRazorpay {
  orders = new Map<string, RzpOrder>();
  payments = new Map<string, RzpPay>();
  refunds = new Map<string, RzpRef>();
  idem = new Map<string, unknown>();
  faults: RzpFault[] = [];
  log: { method: string; path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  newRefundStatus = "processed";
  /** whether payments copy the order's notes (real Razorpay copies none unless the checkout passes them) */
  paymentsCarryNotes = true;
  n = 0;
  port = 0;
  server = http.createServer((req, res) => void this.#handle(req, res));

  async listen(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.port = (this.server.address() as AddressInfo).port;
  }
  async close(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  reset(): void {
    this.orders.clear();
    this.payments.clear();
    this.refunds.clear();
    this.idem.clear();
    this.faults = [];
    this.log = [];
    this.newRefundStatus = "processed";
    this.paymentsCarryNotes = true;
  }
  count(method: string, re: RegExp): number {
    return this.log.filter((l) => l.method === method && re.test(l.path)).length;
  }
  inject(match: RegExp, kind: RzpFault["kind"], times = 1): void {
    this.faults.push({ match, kind, times });
  }

  /** The buyer pays an order. Returns the payment. */
  customerPays(orderId: string, status: "captured" | "authorized" | "failed" = "captured"): RzpPay {
    const o = this.orders.get(orderId);
    if (!o) throw new Error("no order");
    const captured = status === "captured" || (status === "authorized" && o.payment_capture);
    const p: RzpPay = {
      id: `pay_fake${++this.n}`,
      entity: "payment",
      status: captured ? "captured" : status,
      amount: o.amount,
      currency: o.currency,
      order_id: orderId,
      notes: this.paymentsCarryNotes ? { ...o.notes } : {},
      captured,
      amount_refunded: 0,
    };
    this.payments.set(p.id, p);
    return p;
  }
  dashboardRefund(paymentId: string, amount: number, status = "processed"): RzpRef {
    const p = this.payments.get(paymentId);
    if (!p) throw new Error("no payment");
    const r: RzpRef = { id: `rfnd_dash${++this.n}`, entity: "refund", payment_id: paymentId, amount, currency: p.currency, status, notes: {} };
    this.refunds.set(r.id, r);
    return r;
  }

  static sign(raw: string, secret = RZP_WHSEC): string {
    return createHmac("sha256", secret).update(raw).digest("hex");
  }
  static paymentEvent(event: string, payment: RzpPay): string {
    return JSON.stringify({ entity: "event", event, payload: { payment: { entity: payment } } });
  }
  static refundEvent(event: string, refund: RzpRef, payment?: RzpPay): string {
    return JSON.stringify({ entity: "event", event, payload: { refund: { entity: refund }, ...(payment ? { payment: { entity: payment } } : {}) } });
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let raw = "";
    for await (const c of req) raw += c;
    const method = req.method ?? "GET";
    const path = ((req.url ?? "").split("?")[0] ?? "").replace(/^\/v1/, "");
    let body: Record<string, unknown> = {};
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      /* form or empty */
    }
    this.log.push({ method, path, headers: req.headers, body });
    const json = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const fi = this.faults.findIndex((f) => f.times > 0 && f.match.test(`${method} ${path}`));
    const fault = fi >= 0 ? this.faults[fi] : undefined;
    if (fault) fault.times--;
    if (fault?.kind === "drop") return void req.socket.destroy();
    if (fault?.kind === "500") return json(500, { error: { code: "SERVER_ERROR", description: "boom" } });

    const idemHeader = req.headers["x-refund-idempotency"] as string | undefined;
    let out: { status: number; body: unknown };
    const replay = idemHeader ? (this.idem.get(`${path} ${idemHeader}`) as typeof out | undefined) : undefined;
    if (replay) out = replay;
    else {
      out = this.#route(method, path, body);
      if (idemHeader && out.status < 500) this.idem.set(`${path} ${idemHeader}`, out);
    }
    if (fault?.kind === "apply_then_500") return json(500, { error: { code: "SERVER_ERROR", description: "boom after effect" } });
    if (fault?.kind === "apply_then_drop") return void req.socket.destroy();
    json(out.status, out.body);
  }

  #route(method: string, path: string, body: Record<string, unknown>): { status: number; body: unknown } {
    const bad = (status: number, description: string, reason = "input_validation_failed") => ({
      status,
      body: { error: { code: "BAD_REQUEST_ERROR", description, reason } },
    });
    if (method === "POST" && path === "/orders") {
      const o: RzpOrder = {
        id: `order_fake${++this.n}`,
        entity: "order",
        amount: Number(body.amount),
        currency: String(body.currency),
        receipt: (body.receipt as string | undefined) ?? null,
        notes: (body.notes as Record<string, string> | undefined) ?? {},
        status: "created",
        payment_capture: body.payment_capture !== false,
      };
      this.orders.set(o.id, o);
      return { status: 200, body: o };
    }
    let m = /^\/orders\/(\w+)$/.exec(path);
    if (method === "GET" && m) {
      const o = this.orders.get(m[1] ?? "");
      return o ? { status: 200, body: o } : bad(404, "not found");
    }
    m = /^\/orders\/(\w+)\/payments$/.exec(path);
    if (method === "GET" && m) {
      const items = [...this.payments.values()].filter((p) => p.order_id === m?.[1]);
      return { status: 200, body: { entity: "collection", count: items.length, items } };
    }
    m = /^\/payments\/(\w+)$/.exec(path);
    if (method === "GET" && m) {
      const p = this.payments.get(m[1] ?? "");
      return p ? { status: 200, body: p } : bad(404, "not found");
    }
    m = /^\/payments\/(\w+)\/capture$/.exec(path);
    if (method === "POST" && m) {
      const p = this.payments.get(m[1] ?? "");
      if (!p) return bad(404, "not found");
      if (p.status !== "authorized") return bad(400, "This payment has already been captured");
      Object.assign(p, { status: "captured", captured: true });
      return { status: 200, body: p };
    }
    m = /^\/payments\/(\w+)\/refund$/.exec(path);
    if (method === "POST" && m) {
      const p = this.payments.get(m[1] ?? "");
      if (!p || !p.captured) return bad(400, "The payment has not been captured");
      const amount = Number(body.amount);
      const used = [...this.refunds.values()].filter((r) => r.payment_id === p.id && r.status !== "failed").reduce((s, r) => s + r.amount, 0);
      if (amount < 100 && p.currency === "INR") return bad(400, "The amount must be atleast INR 1.00");
      if (amount > p.amount - used) return bad(400, "The refund amount provided is greater than amount captured.");
      const r: RzpRef = {
        id: `rfnd_fake${++this.n}`,
        entity: "refund",
        payment_id: p.id,
        amount,
        currency: p.currency,
        status: this.newRefundStatus,
        notes: (body.notes as Record<string, string> | undefined) ?? {},
      };
      this.refunds.set(r.id, r);
      if (r.status === "processed") p.amount_refunded += amount;
      return { status: 200, body: r };
    }
    m = /^\/refunds\/(\w+)$/.exec(path);
    if (method === "GET" && m) {
      const r = this.refunds.get(m[1] ?? "");
      return r ? { status: 200, body: r } : bad(404, "not found");
    }
    return bad(404, `no route ${method} ${path}`);
  }
}
