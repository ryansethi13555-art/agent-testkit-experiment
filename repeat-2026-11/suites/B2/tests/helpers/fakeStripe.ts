// A stateful fake Stripe HTTP API with documented behaviours: idempotency keys (replay of the first result),
// cumulative refund bound, refund lifecycle, and fault injection (apply-then-lose-response, 5xx, 429, drops).
import http from "node:http";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";

export type FaultMode =
  | "apply_then_500" // effect applied, client sees 500
  | "apply_then_drop" // effect applied, connection closed without a response
  | "before_500" // 500 and nothing applied
  | "before_429" // rate limited before execution
  | "before_drop"; // connection closed, nothing applied
export interface Fault {
  match: string; // "POST /v1/refunds"
  mode: FaultMode;
  times: number;
}
type Obj = Record<string, any>;

export class FakeStripe {
  pis = new Map<string, Obj>();
  refunds = new Map<string, Obj>();
  idem = new Map<string, { fp: string; status: number; body: Obj }>();
  log: { method: string; path: string; params: Record<string, string>; key?: string }[] = [];
  faults: Fault[] = [];
  /** status a newly created refund starts with */
  newRefundStatus: "succeeded" | "pending" = "succeeded";
  /** if set, called (and awaited) after a matching request was read, before it executes (rendezvous hook) */
  gate?: (method: string, path: string) => Promise<void>;
  private n = 0;
  private server = http.createServer((q, s) => void this.handle(q, s));
  base = "";

  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.base;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  posts(path: string): number {
    return this.log.filter((l) => l.method === "POST" && l.path === path).length;
  }
  fault(match: string, mode: FaultMode, times = 1) {
    this.faults.push({ match, mode, times });
  }

  // ---- test controls (the "customer" and the "dashboard")
  pay(id: string) {
    const p = this.pis.get(id) as Obj;
    Object.assign(p, { status: "succeeded", amount_received: p.amount });
  }
  authorize(id: string) {
    (this.pis.get(id) as Obj).status = "requires_capture";
  }
  /** capture from the Dashboard, optionally partial (remainder released) */
  dashboardCapture(id: string, amount?: number) {
    const p = this.pis.get(id) as Obj;
    Object.assign(p, { status: "succeeded", amount_received: amount ?? p.amount });
  }
  dashboardRefund(pi: string, amount: number, status = "succeeded"): Obj {
    return this.makeRefund(pi, amount, {}, status);
  }
  setRefundStatus(id: string, status: string) {
    (this.refunds.get(id) as Obj).status = status;
  }
  snap(o: Obj): Obj {
    return JSON.parse(JSON.stringify(o));
  }
  liveRefunded(pi: string): number {
    let s = 0;
    for (const r of this.refunds.values())
      if (r.payment_intent === pi && ["pending", "requires_action", "succeeded"].includes(r.status))
        s += r.amount;
    return s;
  }

  private makeRefund(pi: string, amount: number, metadata: Obj, status: string): Obj {
    const r = {
      id: `re_${++this.n}`,
      object: "refund",
      amount,
      currency: this.pis.get(pi)?.currency ?? "inr",
      status,
      payment_intent: pi,
      metadata,
    };
    this.refunds.set(r.id, r);
    return r;
  }

  private exec(method: string, path: string, p: URLSearchParams): { status: number; body: Obj } {
    const err = (status: number, type: string, code: string, message: string) => ({
      status,
      body: { error: { type, code, message } },
    });
    const meta: Obj = {};
    for (const [k, v] of p) {
      const m = /^metadata\[(.+)\]$/.exec(k);
      if (m) meta[m[1] as string] = v;
    }
    if (method === "POST" && path === "/v1/payment_intents") {
      const id = `pi_${++this.n}`;
      const pi = {
        id,
        object: "payment_intent",
        amount: Number(p.get("amount")),
        amount_received: 0,
        currency: p.get("currency"),
        capture_method: p.get("capture_method") ?? "automatic",
        status: "requires_payment_method",
        client_secret: `${id}_secret`,
        last_payment_error: null,
        metadata: meta,
      };
      this.pis.set(id, pi);
      return { status: 200, body: pi };
    }
    let m = /^\/v1\/payment_intents\/(\w+)$/.exec(path);
    if (m && method === "GET") {
      const pi = this.pis.get(m[1] as string);
      return pi ? { status: 200, body: pi } : err(404, "invalid_request_error", "resource_missing", "no pi");
    }
    m = /^\/v1\/payment_intents\/(\w+)\/capture$/.exec(path);
    if (m && method === "POST") {
      const pi = this.pis.get(m[1] as string);
      if (!pi) return err(404, "invalid_request_error", "resource_missing", "no pi");
      if (pi.status !== "requires_capture")
        return err(400, "invalid_request_error", "payment_intent_unexpected_state", "not capturable");
      const amt = p.get("amount_to_capture") ? Number(p.get("amount_to_capture")) : pi.amount;
      Object.assign(pi, { status: "succeeded", amount_received: amt });
      return { status: 200, body: pi };
    }
    if (method === "POST" && path === "/v1/refunds") {
      const pi = this.pis.get(p.get("payment_intent") ?? "");
      const amount = Number(p.get("amount"));
      if (!pi || pi.status !== "succeeded")
        return err(400, "invalid_request_error", "charge_not_refundable", "payment not captured");
      if (!Number.isSafeInteger(amount) || amount <= 0)
        return err(400, "invalid_request_error", "parameter_invalid_integer", "bad amount");
      if (amount > pi.amount_received - this.liveRefunded(pi.id))
        return err(400, "invalid_request_error", "amount_too_large", "refund exceeds charge");
      return { status: 200, body: this.makeRefund(pi.id, amount, meta, this.newRefundStatus) };
    }
    m = /^\/v1\/refunds\/(\w+)$/.exec(path);
    if (m && method === "GET") {
      const r = this.refunds.get(m[1] as string);
      return r ? { status: 200, body: r } : err(404, "invalid_request_error", "resource_missing", "no refund");
    }
    return err(404, "invalid_request_error", "resource_missing", `no route ${method} ${path}`);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let raw = "";
    for await (const c of req) raw += c;
    const method = req.method ?? "GET";
    const path = (req.url ?? "").split("?")[0] as string;
    const params = new URLSearchParams(raw);
    const key = req.headers["idempotency-key"] as string | undefined;
    this.log.push({ method, path, params: Object.fromEntries(params), ...(key ? { key } : {}) });
    const send = (status: number, body: Obj, extra: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...extra });
      res.end(JSON.stringify(body));
    };
    if (this.gate) await this.gate(method, path);
    const fault = this.faults.find((f) => f.times > 0 && f.match === `${method} ${path}`);
    if (fault) fault.times--;
    if (fault?.mode === "before_drop") return void req.socket.destroy();
    if (fault?.mode === "before_500")
      return send(500, { error: { type: "api_error", message: "boom (nothing applied)" } });
    if (fault?.mode === "before_429")
      return send(429, { error: { type: "rate_limit_error", code: "rate_limit", message: "slow down" } });
    let out: { status: number; body: Obj };
    if (method === "POST" && key) {
      const fp = `${path}?${[...params].sort().join("&")}`;
      const seen = this.idem.get(key);
      if (seen) {
        out =
          seen.fp === fp
            ? { status: seen.status, body: seen.body }
            : {
                status: 400,
                body: { error: { type: "idempotency_error", message: "key reused with different params" } },
              };
      } else {
        out = this.exec(method, path, params);
        this.idem.set(key, { fp, status: out.status, body: JSON.parse(JSON.stringify(out.body)) });
      }
    } else out = this.exec(method, path, params);
    if (fault?.mode === "apply_then_500")
      return send(500, { error: { type: "api_error", message: "boom (applied)" } });
    if (fault?.mode === "apply_then_drop") return void req.socket.destroy();
    send(out.status, out.body);
  }
}

// ---- webhook helpers
export const WHSEC = "whsec_independent_suite";
export function stripeEvent(id: string, type: string, object: Obj): Obj {
  return { id, object: "event", type, data: { object } };
}
export function signStripe(event: Obj, secret = WHSEC, timestamp?: number) {
  const payload = JSON.stringify(event);
  return {
    payload,
    header: Stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
      ...(timestamp !== undefined ? { timestamp } : {}),
    }),
  };
}
