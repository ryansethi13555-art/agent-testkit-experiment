// A stateful fake Razorpay HTTP API (orders, payments, refunds) with X-Refund-Idempotency and fault injection.
import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

type Obj = Record<string, any>;
export const RZP_WHSEC = "rzp_whsec_independent";
export class FakeRazorpay {
  orders = new Map<string, Obj>();
  payments = new Map<string, Obj>();
  refunds = new Map<string, Obj>();
  idem = new Map<string, Obj>();
  log: { method: string; path: string; body: Obj; idemKey?: string }[] = [];
  faults: { match: string; mode: "apply_then_drop" | "before_500"; times: number }[] = [];
  newRefundStatus = "processed";
  base = "";
  private n = 0;
  private server = http.createServer((q, s) => void this.handle(q, s));
  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  fault(match: string, mode: "apply_then_drop" | "before_500", times = 1) {
    this.faults.push({ match, mode, times });
  }
  posts(path: RegExp) {
    return this.log.filter((l) => l.method === "POST" && path.test(l.path)).length;
  }
  /** the customer pays the order in full */
  pay(orderId: string, status: "captured" | "authorized" = "captured"): Obj {
    const o = this.orders.get(orderId) as Obj;
    const p = { id: `pay_${++this.n}`, entity: "payment", order_id: orderId, status, captured: status === "captured", amount: o.amount, currency: o.currency, notes: o.notes };
    this.payments.set(p.id, p);
    return p;
  }
  liveRefunded(paymentId: string) {
    let s = 0;
    for (const r of this.refunds.values()) if (r.payment_id === paymentId && r.status !== "failed") s += r.amount;
    return s;
  }
  dashboardRefund(paymentId: string, amount: number, status = "processed"): Obj {
    const p = this.payments.get(paymentId) as Obj;
    const r = { id: `rfnd_${++this.n}`, entity: "refund", payment_id: paymentId, amount, currency: p.currency, status, notes: [] as unknown[] };
    this.refunds.set(r.id, r);
    return r;
  }
  snap(o: Obj): Obj {
    return JSON.parse(JSON.stringify(o));
  }
  private exec(method: string, path: string, body: Obj, idemKey?: string): { status: number; body: Obj } {
    const err = (status: number, description: string) => ({ status, body: { error: { code: "BAD_REQUEST_ERROR", description, source: "business", step: "x", reason: "input_validation_failed", metadata: {} } } });
    if (method === "POST" && path === "/v1/orders") {
      const o = { id: `order_${++this.n}`, entity: "order", amount: body.amount, currency: body.currency, receipt: body.receipt, notes: body.notes ?? [], status: "created" };
      this.orders.set(o.id, o);
      return { status: 200, body: o };
    }
    let m = /^\/v1\/orders\/(\w+)\/payments$/.exec(path);
    if (m && method === "GET") return { status: 200, body: { entity: "collection", count: 0, items: [...this.payments.values()].filter((p) => p.order_id === m?.[1]) } };
    m = /^\/v1\/orders\/(\w+)$/.exec(path);
    if (m && method === "GET") return this.orders.has(m[1] as string) ? { status: 200, body: this.orders.get(m[1] as string) as Obj } : err(404, "no order");
    m = /^\/v1\/payments\/(\w+)$/.exec(path);
    if (m && method === "GET") return this.payments.has(m[1] as string) ? { status: 200, body: this.payments.get(m[1] as string) as Obj } : err(404, "no payment");
    m = /^\/v1\/payments\/(\w+)\/capture$/.exec(path);
    if (m && method === "POST") {
      const p = this.payments.get(m[1] as string);
      if (!p || p.status !== "authorized") return err(400, "payment not in authorized state");
      Object.assign(p, { status: "captured", captured: true });
      return { status: 200, body: p };
    }
    m = /^\/v1\/payments\/(\w+)\/refund$/.exec(path);
    if (m && method === "POST") {
      const p = this.payments.get(m[1] as string);
      if (!p || p.status !== "captured") return err(400, "payment not captured");
      if (idemKey && this.idem.has(idemKey)) return { status: 200, body: this.idem.get(idemKey) as Obj };
      if (body.amount < 100 && p.currency === "INR") return err(400, "The amount must be atleast INR 1.00");
      if (body.amount > p.amount - this.liveRefunded(p.id)) return err(400, "The refund amount provided is greater than amount captured.");
      const r = { id: `rfnd_${++this.n}`, entity: "refund", payment_id: p.id, amount: body.amount, currency: p.currency, status: this.newRefundStatus, notes: body.notes ?? [] };
      this.refunds.set(r.id, r);
      if (idemKey) this.idem.set(idemKey, r);
      return { status: 200, body: r };
    }
    m = /^\/v1\/refunds\/(\w+)$/.exec(path);
    if (m && method === "GET") return this.refunds.has(m[1] as string) ? { status: 200, body: this.refunds.get(m[1] as string) as Obj } : err(404, "no refund");
    return err(404, `no route ${method} ${path}`);
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let raw = "";
    for await (const c of req) raw += c;
    const method = req.method ?? "GET";
    const path = (req.url ?? "").split("?")[0] as string;
    let body: Obj = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch {}
    const idemKey = req.headers["x-refund-idempotency"] as string | undefined;
    this.log.push({ method, path, body, ...(idemKey ? { idemKey } : {}) });
    const f = this.faults.find((x) => x.times > 0 && new RegExp(x.match).test(`${method} ${path}`));
    if (f) f.times--;
    if (f?.mode === "before_500") {
      res.writeHead(500, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: { code: "SERVER_ERROR", description: "boom" } }));
    }
    const out = this.exec(method, path, body, idemKey);
    if (f?.mode === "apply_then_drop") return void req.socket.destroy();
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
  }
}
export const rzpSign = (raw: string, secret = RZP_WHSEC) => createHmac("sha256", secret).update(raw).digest("hex");
