// A stateful fake of the Stripe REST API (HTTP level, so the real stripe-node SDK and the apps' adapters run unchanged).
// Models: idempotency keys (replay returns the FIRST response, mismatching params are an error), manual + partial
// capture, refund capacity, pending/succeeded/failed refunds, lost responses after the effect was applied, 5xx/429.
import http from "node:http";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";

export const WHSEC = "whsec_money_test";
const signer = new Stripe("sk_test_signer");

type Obj = Record<string, any>;
export type FaultMode = "drop-after-apply" | "500-after-apply" | "500-before" | "429-before" | "drop-before";
export interface Fault {
  method: string;
  path: RegExp;
  mode: FaultMode;
  times: number;
  /** only the nth matching call (1 based) and later; default 1 */
  skip?: number;
}
export interface Logged {
  method: string;
  path: string;
  body: Record<string, string>;
  idem: string | undefined;
}

export class FakeStripe {
  pis = new Map<string, Obj>();
  refunds = new Map<string, Obj>();
  idem = new Map<string, { sig: string; status: number; body: Obj }>();
  log: Logged[] = [];
  faults: Fault[] = [];
  n = 0;
  /** status a newly created refund gets */
  refundInitialStatus: "succeeded" | "pending" = "succeeded";
  /** gate: if set, refund POST handler awaits it AFTER applying (lets a test deliver a webhook mid-flight) */
  refundHold: Promise<void> | undefined;
  onRefundApplied: (() => void) | undefined;
  server: http.Server;
  base = "";

  constructor() {
    this.server = http.createServer((req, res) => void this.#handle(req, res));
  }
  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  reset(): void {
    this.pis.clear();
    this.refunds.clear();
    this.idem.clear();
    this.log = [];
    this.faults = [];
    this.refundInitialStatus = "succeeded";
    this.refundHold = undefined;
    this.onRefundApplied = undefined;
  }
  posts(re: RegExp): Logged[] {
    return this.log.filter((l) => l.method === "POST" && re.test(l.path));
  }
  addFault(f: Fault): void {
    this.faults.push({ skip: 0, ...f });
  }
  /** Provider-side fact: the customer paid / authorised. */
  pay(id: string, opts: { captured?: bigint } = {}): Obj {
    const pi = this.pis.get(id)!;
    if (pi.capture_method === "manual") {
      pi.status = "requires_capture";
      pi.amount_capturable = pi.amount;
    } else {
      pi.status = "succeeded";
      pi.amount_received = opts.captured !== undefined ? Number(opts.captured) : pi.amount;
    }
    return pi;
  }
  setRefundStatus(id: string, status: string): Obj {
    const r = this.refunds.get(id)!;
    r.status = status;
    return r;
  }
  /** A refund made in the Stripe dashboard (no app metadata). */
  dashboardRefund(piId: string, amount: number, status = "succeeded"): Obj {
    const pi = this.pis.get(piId)!;
    const r: Obj = {
      id: `re_dash${++this.n}`,
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
  liveRefunded(piId: string): number {
    return [...this.refunds.values()]
      .filter((r) => r.payment_intent === piId && ["pending", "requires_action", "succeeded"].includes(r.status))
      .reduce((s, r) => s + r.amount, 0);
  }
  /** Current signed webhook delivery for an object snapshot. */
  signedEvent(type: string, object: Obj, id?: string): { payload: string; header: string; id: string } {
    const evId = id ?? `evt_${++this.n}`;
    const payload = JSON.stringify({ id: evId, object: "event", type, data: { object } });
    return { payload, header: Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC }), id: evId };
  }
  static sign(payload: string): string {
    return signer.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
  }

  #match(method: string, path: string): Fault | undefined {
    for (const f of this.faults) {
      if (f.times > 0 && f.method === method && f.path.test(path)) {
        if ((f.skip ?? 0) > 0) {
          f.skip = (f.skip ?? 0) - 1;
          continue;
        }
        f.times--;
        return f;
      }
    }
    return undefined;
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let raw = "";
    for await (const c of req) raw += c;
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const form: Record<string, string> = Object.fromEntries(new URLSearchParams(raw));
    const idemKey = req.headers["idempotency-key"] as string | undefined;
    this.log.push({ method, path, body: form, idem: idemKey });
    const send = (status: number, body: Obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const err = (status: number, type: string, code: string, message = code) =>
      send(status, { error: { type, code, message } });
    const fault = this.#match(method, path);
    if (fault?.mode === "drop-before") return void req.socket.destroy();
    if (fault?.mode === "500-before") return err(500, "api_error", "api_error", "boom");
    if (fault?.mode === "429-before") return err(429, "rate_limit_error", "rate_limit", "slow down");

    let result: { status: number; body: Obj };
    try {
      result = this.#route(method, path, form, idemKey);
    } catch (e) {
      const x = e as { status?: number; type?: string; code?: string };
      if (x.status) return err(x.status, x.type ?? "invalid_request_error", x.code ?? "bad", String(x.code));
      throw e;
    }
    if (path === "/v1/refunds" && method === "POST" && result.status === 200) {
      this.onRefundApplied?.();
      if (this.refundHold) await this.refundHold;
    }
    if (fault?.mode === "drop-after-apply") return void req.socket.destroy();
    if (fault?.mode === "500-after-apply") return err(500, "api_error", "api_error", "boom after apply");
    send(result.status, result.body);
  }

  #idem(key: string | undefined, form: Record<string, string>, fn: () => { status: number; body: Obj }) {
    if (!key) return fn();
    const sig = JSON.stringify(Object.entries(form).sort());
    const seen = this.idem.get(key);
    if (seen) {
      if (seen.sig !== sig) throw { status: 400, type: "idempotency_error", code: "idempotency_key_in_use" };
      return { status: seen.status, body: structuredClone(seen.body) };
    }
    const out = fn();
    if (out.status < 500) this.idem.set(key, { sig, status: out.status, body: structuredClone(out.body) });
    return out;
  }

  #route(method: string, path: string, form: Record<string, string>, key: string | undefined) {
    if (method === "POST" && path === "/v1/payment_intents")
      return this.#idem(key, form, () => {
        const id = `pi_${++this.n}`;
        const pi: Obj = {
          id,
          object: "payment_intent",
          amount: Number(form.amount),
          amount_received: 0,
          amount_capturable: 0,
          currency: form.currency,
          capture_method: form.capture_method ?? "automatic",
          status: "requires_payment_method",
          client_secret: `${id}_secret`,
          metadata: { order_id: form["metadata[order_id]"] },
          last_payment_error: null,
        };
        this.pis.set(id, pi);
        return { status: 200, body: pi };
      });
    let m = /^\/v1\/payment_intents\/(\w+)$/.exec(path);
    if (m && method === "GET") {
      const pi = this.pis.get(m[1]!);
      if (!pi) throw { status: 404, code: "resource_missing" };
      return { status: 200, body: structuredClone(pi) };
    }
    m = /^\/v1\/payment_intents\/(\w+)\/capture$/.exec(path);
    if (m && method === "POST")
      return this.#idem(key, form, () => {
        const pi = this.pis.get(m![1]!);
        if (!pi) throw { status: 404, code: "resource_missing" };
        if (pi.status !== "requires_capture") throw { status: 400, code: "payment_intent_unexpected_state" };
        const amt = form.amount_to_capture ? Number(form.amount_to_capture) : pi.amount_capturable;
        pi.status = "succeeded";
        pi.amount_received = amt; // partial capture releases the remainder
        pi.amount_capturable = 0;
        return { status: 200, body: structuredClone(pi) };
      });
    m = /^\/v1\/payment_intents\/(\w+)\/cancel$/.exec(path);
    if (m && method === "POST") {
      const pi = this.pis.get(m[1]!)!;
      pi.status = "canceled";
      return { status: 200, body: structuredClone(pi) };
    }
    if (method === "POST" && path === "/v1/refunds")
      return this.#idem(key, form, () => {
        const pi = this.pis.get(form.payment_intent ?? "");
        if (!pi) throw { status: 400, code: "resource_missing" };
        const amount = Number(form.amount);
        if (amount > pi.amount_received - this.liveRefunded(pi.id))
          throw { status: 400, type: "invalid_request_error", code: "amount_too_large" };
        const metadata: Record<string, string> = {};
        for (const [k, v] of Object.entries(form)) {
          const mm = /^metadata\[(.+)\]$/.exec(k);
          if (mm) metadata[mm[1]!] = v;
        }
        const r: Obj = {
          id: `re_${++this.n}`,
          object: "refund",
          amount,
          currency: pi.currency,
          status: this.refundInitialStatus,
          payment_intent: pi.id,
          metadata,
        };
        this.refunds.set(r.id, r);
        return { status: 200, body: structuredClone(r) };
      });
    m = /^\/v1\/refunds\/(\w+)$/.exec(path);
    if (m && method === "GET") {
      const r = this.refunds.get(m[1]!);
      if (!r) throw { status: 404, code: "resource_missing" };
      return { status: 200, body: structuredClone(r) };
    }
    throw { status: 404, code: "unknown_route" };
  }
}
