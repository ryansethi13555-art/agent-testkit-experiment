// A stateful fake of the Razorpay REST API (orders, payments, refunds) for the real razorpay-node SDK and adapters.
import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export const RZP_SECRET = "rzp_whsec_money_test";
type Obj = Record<string, any>;
export interface RFault {
  method: string;
  path: RegExp;
  mode: "drop-after-apply" | "500-before" | "drop-before";
  times: number;
}
export class FakeRazorpay {
  orders = new Map<string, Obj>();
  payments = new Map<string, Obj>();
  refunds = new Map<string, Obj>();
  idem = new Map<string, Obj>();
  log: { method: string; path: string; body: any; idem?: string | undefined }[] = [];
  faults: RFault[] = [];
  n = 0;
  refundInitialStatus: "processed" | "pending" = "processed";
  server: http.Server;
  base = "";
  constructor() {
    this.server = http.createServer((req, res) => void this.#handle(req, res));
  }
  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop() {
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  reset() {
    this.orders.clear();
    this.payments.clear();
    this.refunds.clear();
    this.idem.clear();
    this.log = [];
    this.faults = [];
    this.refundInitialStatus = "processed";
  }
  posts(re: RegExp) {
    return this.log.filter((l) => l.method === "POST" && re.test(l.path));
  }
  /** The customer pays the order (captured). */
  capturePayment(orderId: string, amount?: number): Obj {
    const o = this.orders.get(orderId)!;
    const p: Obj = { id: `pay_${++this.n}`, entity: "payment", order_id: orderId, status: "captured", captured: true, amount: amount ?? o.amount, currency: o.currency, notes: { ...o.notes } };
    this.payments.set(p.id, p);
    return p;
  }
  liveRefunded(payId: string) {
    return [...this.refunds.values()].filter((r) => r.payment_id === payId && r.status !== "failed").reduce((s, r) => s + r.amount, 0);
  }
  static signed(event: string, payload: Obj, eventId?: string) {
    const raw = JSON.stringify({ event, payload });
    const sig = createHmac("sha256", RZP_SECRET).update(raw).digest("hex");
    return { raw, headers: { "x-razorpay-signature": sig, ...(eventId ? { "x-razorpay-event-id": eventId } : {}) } as Record<string, string> };
  }
  async #handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let raw = "";
    for await (const c of req) raw += c;
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const method = req.method ?? "GET";
    const body = raw ? JSON.parse(raw) : {};
    const idem = req.headers["x-refund-idempotency"] as string | undefined;
    this.log.push({ method, path, body, idem });
    const send = (s: number, b: Obj) => {
      res.writeHead(s, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    const bad = (s: number, desc: string) => send(s, { error: { code: "BAD_REQUEST_ERROR", description: desc, reason: "input_validation_failed" } });
    const f = this.faults.find((x) => x.times > 0 && x.method === method && x.path.test(path));
    if (f) f.times--;
    if (f?.mode === "drop-before") return void req.socket.destroy();
    if (f?.mode === "500-before") return send(500, { error: { code: "SERVER_ERROR", description: "boom" } });
    let m: RegExpExecArray | null;
    let out: [number, Obj];
    if (method === "POST" && path === "/v1/orders") {
      const id = `order_${++this.n}`;
      const o = { id, entity: "order", amount: body.amount, currency: body.currency, receipt: body.receipt, notes: body.notes ?? {}, status: "created" };
      this.orders.set(id, o);
      out = [200, o];
    } else if ((m = /^\/v1\/orders\/(\w+)\/payments$/.exec(path)) && method === "GET") {
      out = [200, { entity: "collection", items: [...this.payments.values()].filter((p) => p.order_id === m![1]) }];
    } else if ((m = /^\/v1\/orders\/(\w+)$/.exec(path)) && method === "GET") {
      out = this.orders.has(m[1]!) ? [200, this.orders.get(m[1]!)!] : [404, { error: { code: "BAD_REQUEST_ERROR", description: "nf" } }];
    } else if ((m = /^\/v1\/payments\/(\w+)$/.exec(path)) && method === "GET") {
      out = this.payments.has(m[1]!) ? [200, this.payments.get(m[1]!)!] : [404, { error: { code: "BAD_REQUEST_ERROR", description: "nf" } }];
    } else if ((m = /^\/v1\/payments\/(\w+)\/capture$/.exec(path)) && method === "POST") {
      const p = this.payments.get(m[1]!)!;
      p.status = "captured";
      p.captured = true;
      out = [200, p];
    } else if ((m = /^\/v1\/payments\/(\w+)\/refund$/.exec(path)) && method === "POST") {
      const p = this.payments.get(m[1]!);
      const prior = idem ? this.idem.get(idem) : undefined;
      if (prior) out = [200, prior];
      else if (!p || p.status !== "captured") out = [400, { error: { code: "BAD_REQUEST_ERROR", description: "not captured", reason: "input_validation_failed" } }];
      else if (body.amount < 100 && p.currency === "INR") return bad(400, "The amount must be atleast INR 1.00");
      else if (body.amount > p.amount - this.liveRefunded(p.id)) return bad(400, "The refund amount provided is greater than amount captured.");
      else {
        const r = { id: `rfnd_${++this.n}`, entity: "refund", payment_id: p.id, amount: body.amount, currency: p.currency, status: this.refundInitialStatus, notes: body.notes ?? {} };
        this.refunds.set(r.id, r);
        if (idem) this.idem.set(idem, structuredClone(r));
        out = [200, r];
      }
    } else if ((m = /^\/v1\/refunds\/(\w+)$/.exec(path)) && method === "GET") {
      out = this.refunds.has(m[1]!) ? [200, structuredClone(this.refunds.get(m[1]!)!)] : [404, { error: { code: "BAD_REQUEST_ERROR", description: "nf" } }];
    } else out = [404, { error: { code: "BAD_REQUEST_ERROR", description: "unknown route" } }];
    if (f?.mode === "drop-after-apply") return void req.socket.destroy();
    send(out[0], out[1]);
  }
}
