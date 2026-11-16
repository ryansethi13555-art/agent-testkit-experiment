// A fake Razorpay HTTP API (orders, payments, refunds) with refund idempotency header and fault injection.
import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export const RZP_SECRET = "rzp_whsec_test";
type Any = any; // eslint-disable-line
export interface RzpFault { match: RegExp; when: "before" | "after"; status: number; once?: boolean }

export class RzpWorld {
  orders = new Map<string, Any>();
  payments = new Map<string, Any>();
  refunds = new Map<string, Any>();
  idem = new Map<string, string>();
  refundPosts: { paymentId: string; amount: number; key: string | undefined; notes: Any }[] = [];
  requests: string[] = [];
  faults: RzpFault[] = [];
  n = 0;
  server!: http.Server;
  base = "";
  reset() {
    for (const m of [this.orders, this.payments, this.refunds, this.idem]) m.clear();
    this.refundPosts = []; this.requests = []; this.faults = []; this.n = 0;
  }
  async listen() {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async close() { await new Promise<void>((r) => this.server.close(() => r())); }
  count(re: RegExp) { return this.requests.filter((r) => re.test(r)).length; }
  /** Customer attempts a payment on an order. outcome: captured (auto), authorized, or failed. */
  pay(orderId: string, outcome: "captured" | "authorized" | "failed" = "captured", notes: Any = {}) {
    const o = this.orders.get(orderId);
    const id = `pay_${++this.n}`;
    const status = outcome === "captured" && !o.payment_capture ? "authorized" : outcome;
    const p = { id, entity: "payment", order_id: orderId, amount: o.amount, currency: o.currency, status, captured: status === "captured", notes };
    this.payments.set(id, p);
    return p;
  }
  heldOn(paymentId: string) {
    let s = 0;
    for (const r of this.refunds.values()) if (r.payment_id === paymentId && r.status !== "failed") s += r.amount;
    return s;
  }
  dashboardRefund(paymentId: string, amount: number, status = "processed") {
    const id = `rfnd_${++this.n}`;
    const r = { id, entity: "refund", payment_id: paymentId, amount, currency: "INR", status, notes: [] };
    this.refunds.set(id, r);
    return r;
  }
  private err(res: http.ServerResponse, status: number, description: string, reason = "input_validation_failed") {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "BAD_REQUEST_ERROR", description, reason, source: "business", step: "payment_initiation" } }));
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let raw = "";
    for await (const c of req) raw += c;
    const path = (req.url ?? "").split("?")[0] as string;
    const sig = `${req.method} ${path}`;
    this.requests.push(sig);
    const body = raw ? JSON.parse(raw) : {};
    const ok = (o: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const fi = this.faults.findIndex((f) => f.match.test(sig));
    const fault = fi >= 0 ? this.faults.splice(fi, 1)[0] : undefined;
    if (fault?.when === "before") { res.writeHead(fault.status, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { code: "SERVER_ERROR", description: "boom" } })); }
    const send = (o: unknown) => {
      if (fault?.when === "after") { res.writeHead(fault.status, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { code: "SERVER_ERROR", description: "boom" } })); }
      ok(o);
    };
    let m: RegExpExecArray | null;
    if (req.method === "POST" && path === "/v1/orders") {
      const id = `order_${++this.n}`;
      const o = { id, entity: "order", amount: body.amount, currency: body.currency, receipt: body.receipt ?? null, notes: body.notes ?? [], payment_capture: body.payment_capture !== false, status: "created" };
      this.orders.set(id, o);
      return send(o);
    }
    if (req.method === "GET" && (m = /^\/v1\/orders\/([^/]+)\/payments$/.exec(path))) {
      const items = [...this.payments.values()].filter((p) => p.order_id === m![1]);
      return send({ entity: "collection", count: items.length, items });
    }
    if (req.method === "GET" && (m = /^\/v1\/orders\/([^/]+)$/.exec(path))) return this.orders.has(m[1] as string) ? send(this.orders.get(m[1] as string)) : this.err(res, 404, "not found");
    if (req.method === "GET" && (m = /^\/v1\/payments\/([^/]+)$/.exec(path))) return this.payments.has(m[1] as string) ? send(this.payments.get(m[1] as string)) : this.err(res, 404, "not found");
    if (req.method === "GET" && (m = /^\/v1\/refunds\/([^/]+)$/.exec(path))) return this.refunds.has(m[1] as string) ? send(this.refunds.get(m[1] as string)) : this.err(res, 404, "not found");
    if (req.method === "POST" && (m = /^\/v1\/payments\/([^/]+)\/capture$/.exec(path))) {
      const p = this.payments.get(m[1] as string);
      if (!p || p.status !== "authorized") return this.err(res, 400, "payment not authorized");
      if (body.amount !== p.amount) return this.err(res, 400, "capture amount must equal the payment amount");
      Object.assign(p, { status: "captured", captured: true });
      return send(p);
    }
    if (req.method === "POST" && (m = /^\/v1\/payments\/([^/]+)\/refund$/.exec(path))) {
      const key = req.headers["x-refund-idempotency"] as string | undefined;
      this.refundPosts.push({ paymentId: m[1] as string, amount: body.amount, key, notes: body.notes });
      const p = this.payments.get(m[1] as string);
      if (key && this.idem.has(key)) return send(this.refunds.get(this.idem.get(key) as string));
      if (!p || !p.captured) return this.err(res, 400, "payment not captured");
      if (body.amount < 100) return this.err(res, 400, "The amount must be atleast INR 1.00");
      if (body.amount > p.amount - this.heldOn(p.id)) return this.err(res, 400, "The refund amount provided is greater than amount captured.");
      const id = `rfnd_${++this.n}`;
      const r = { id, entity: "refund", payment_id: p.id, amount: body.amount, currency: p.currency, status: "processed", notes: body.notes ?? [] };
      this.refunds.set(id, r);
      if (key) this.idem.set(key, id);
      return send(r);
    }
    res.writeHead(404); res.end("{}");
  }
}

export const rzpSign = (payload: string, secret = RZP_SECRET) => createHmac("sha256", secret).update(payload).digest("hex");
export function rzpEvent(event: string, ents: { payment?: Any; refund?: Any; order?: Any }) {
  const payload: Any = {};
  for (const [k, v] of Object.entries(ents)) if (v) payload[k] = { entity: v };
  return JSON.stringify({ entity: "event", event, payload, created_at: Math.floor(Date.now() / 1000) });
}
