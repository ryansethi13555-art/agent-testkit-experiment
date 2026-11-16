// A small but faithful in-memory Stripe HTTP fake. It speaks the wire format the official SDK uses
// (form-encoded bodies, Idempotency-Key header, error envelopes) and supports fault injection
// that mimics what the brief describes: an effect applied and then the response lost / 5xx.
import http from "node:http";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";

export interface FakePI {
  id: string;
  object: "payment_intent";
  amount: number;
  amount_received: number;
  currency: string;
  capture_method: string;
  status: string;
  client_secret: string;
  metadata: Record<string, string>;
  last_payment_error?: unknown;
}
export interface FakeRefund {
  id: string;
  object: "refund";
  amount: number;
  currency: string;
  status: string;
  payment_intent: string;
  metadata: Record<string, string>;
}
export type FaultKind =
  | "apply_then_500" // effect committed, client sees a 500
  | "apply_then_drop" // effect committed, connection destroyed
  | "drop" // connection destroyed before the effect
  | "500" // 500 before the effect
  | "429"; // rate limited before the effect
export interface Fault {
  /** matched against `${METHOD} ${path}` */
  match: RegExp;
  kind: FaultKind;
  times: number;
}
export interface LoggedRequest {
  method: string;
  path: string;
  idemKey: string | undefined;
  form: URLSearchParams;
}

export const WHSEC = "whsec_independent_test";
const signer = new Stripe("sk_test_signer");

export class FakeStripe {
  pis = new Map<string, FakePI>();
  refunds = new Map<string, FakeRefund>();
  idem = new Map<string, { status: number; body: unknown }>();
  faults: Fault[] = [];
  log: LoggedRequest[] = [];
  /** status new refunds are created with */
  newRefundStatus = "succeeded";
  server: http.Server;
  n = 0;
  port = 0;

  constructor() {
    this.server = http.createServer((req, res) => void this.#handle(req, res));
  }
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
    this.pis.clear();
    this.refunds.clear();
    this.idem.clear();
    this.faults = [];
    this.log = [];
    this.newRefundStatus = "succeeded";
  }
  count(method: string, pathRe: RegExp): number {
    return this.log.filter((l) => l.method === method && pathRe.test(l.path)).length;
  }
  inject(match: RegExp, kind: FaultKind, times = 1): void {
    this.faults.push({ match, kind, times });
  }

  // ---- state helpers used by tests to play the buyer / dashboard / provider
  /** The buyer completes payment. Automatic: succeeds. Manual: authorised (requires_capture). */
  customerPays(piId: string): FakePI {
    const pi = this.#pi(piId);
    if (pi.capture_method === "manual") pi.status = "requires_capture";
    else Object.assign(pi, { status: "succeeded", amount_received: pi.amount });
    return pi;
  }
  /** A refund created outside the app (dashboard), not necessarily announced by a webhook. */
  dashboardRefund(piId: string, amount: number, status = "succeeded", id?: string): FakeRefund {
    const pi = this.#pi(piId);
    const r: FakeRefund = {
      id: id ?? `re_dash_${++this.n}`,
      object: "refund",
      amount,
      currency: pi.currency,
      status,
      payment_intent: piId,
      metadata: {},
    };
    this.refunds.set(r.id, r);
    return r;
  }
  #pi(id: string): FakePI {
    const pi = this.pis.get(id);
    if (!pi) throw new Error(`no fake PI ${id}`);
    return pi;
  }

  // ---- webhook construction (signed exactly like Stripe)
  event(type: string, object: unknown, id?: string): { id: string; object: "event"; type: string; data: { object: unknown } } {
    return { id: id ?? `evt_${++this.n}_${Math.random().toString(36).slice(2, 8)}`, object: "event", type, data: { object } };
  }
  static sign(event: unknown, opts: { secret?: string; timestamp?: number } = {}): { payload: string; header: string } {
    const payload = JSON.stringify(event);
    const header = signer.webhooks.generateTestHeaderString({
      payload,
      secret: opts.secret ?? WHSEC,
      ...(opts.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
    });
    return { payload, header };
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body = "";
    for await (const c of req) body += c;
    const form = new URLSearchParams(body);
    const method = req.method ?? "GET";
    const path = (req.url ?? "").split("?")[0] ?? "";
    const idemKey = req.headers["idempotency-key"] as string | undefined;
    this.log.push({ method, path, idemKey, form });
    const json = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "request-id": "req_fake" });
      res.end(JSON.stringify(obj));
    };
    const err = (status: number, type: string, message: string, code?: string) =>
      json(status, { error: { type, message, ...(code ? { code } : {}) } });

    const faultIdx = this.faults.findIndex((f) => f.times > 0 && f.match.test(`${method} ${path}`));
    const fault = faultIdx >= 0 ? this.faults[faultIdx] : undefined;
    if (fault) fault.times--;
    if (fault?.kind === "drop") return void req.socket.destroy();
    if (fault?.kind === "500") return err(500, "api_error", "injected 500");
    if (fault?.kind === "429") return err(429, "rate_limit_error", "injected rate limit");

    // idempotent replay (Stripe returns the first result for the same key)
    const idemId = idemKey ? `${method} ${path} ${idemKey}` : undefined;
    const replay = idemId ? this.idem.get(idemId) : undefined;
    let status = 200;
    let out: unknown;
    if (replay) {
      status = replay.status;
      out = replay.body;
    } else {
      const r = this.#route(method, path, form);
      status = r.status;
      out = r.body;
      if (idemId && status < 500) this.idem.set(idemId, { status, body: out });
    }
    if (fault?.kind === "apply_then_500") return err(500, "api_error", "injected 500 after effect");
    if (fault?.kind === "apply_then_drop") return void req.socket.destroy();
    json(status, out);
  }

  #route(method: string, path: string, form: URLSearchParams): { status: number; body: unknown } {
    const bad = (status: number, type: string, message: string, code?: string) => ({
      status,
      body: { error: { type, message, ...(code ? { code } : {}) } },
    });
    const meta = (): Record<string, string> => {
      const m: Record<string, string> = {};
      for (const [k, v] of form) {
        const mm = /^metadata\[(.+)\]$/.exec(k);
        if (mm?.[1]) m[mm[1]] = v;
      }
      return m;
    };
    if (method === "POST" && path === "/v1/payment_intents") {
      const id = `pi_fake${++this.n}`;
      const pi: FakePI = {
        id,
        object: "payment_intent",
        amount: Number(form.get("amount")),
        amount_received: 0,
        currency: form.get("currency") ?? "",
        capture_method: form.get("capture_method") ?? "automatic",
        status: "requires_payment_method",
        client_secret: `${id}_secret`,
        metadata: meta(),
      };
      this.pis.set(id, pi);
      return { status: 200, body: pi };
    }
    let m = /^\/v1\/payment_intents\/(\w+)$/.exec(path);
    if (method === "GET" && m) {
      const pi = this.pis.get(m[1] ?? "");
      return pi ? { status: 200, body: pi } : bad(404, "invalid_request_error", "No such payment_intent", "resource_missing");
    }
    m = /^\/v1\/payment_intents\/(\w+)\/capture$/.exec(path);
    if (method === "POST" && m) {
      const pi = this.pis.get(m[1] ?? "");
      if (!pi) return bad(404, "invalid_request_error", "No such payment_intent", "resource_missing");
      if (pi.status !== "requires_capture")
        return bad(400, "invalid_request_error", `PaymentIntent status is ${pi.status}`, "payment_intent_unexpected_state");
      const amt = form.get("amount_to_capture");
      Object.assign(pi, { status: "succeeded", amount_received: amt ? Number(amt) : pi.amount });
      return { status: 200, body: pi };
    }
    m = /^\/v1\/refunds\/(\w+)$/.exec(path);
    if (method === "GET" && m) {
      const r = this.refunds.get(m[1] ?? "");
      return r ? { status: 200, body: r } : bad(404, "invalid_request_error", "No such refund", "resource_missing");
    }
    if (method === "POST" && path === "/v1/refunds") {
      const piId = form.get("payment_intent") ?? "";
      const pi = this.pis.get(piId);
      if (!pi) return bad(404, "invalid_request_error", "No such payment_intent", "resource_missing");
      const amount = Number(form.get("amount"));
      const used = [...this.refunds.values()]
        .filter((r) => r.payment_intent === piId && !["failed", "canceled"].includes(r.status))
        .reduce((s, r) => s + r.amount, 0);
      if (pi.status !== "succeeded" || amount > pi.amount_received - used)
        return bad(400, "invalid_request_error", "Refund amount is greater than unrefunded amount", "amount_too_large");
      const r: FakeRefund = {
        id: `re_fake${++this.n}`,
        object: "refund",
        amount,
        currency: pi.currency,
        status: this.newRefundStatus,
        payment_intent: piId,
        metadata: meta(),
      };
      this.refunds.set(r.id, r);
      return { status: 200, body: r };
    }
    return bad(404, "invalid_request_error", `Unrecognized request URL (${method} ${path})`);
  }
}
