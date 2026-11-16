// Shared harness for the money-correctness suite.
//
// * Twin: a contract-faithful provider simulator (the engine's SimServer around the sim World, with the cited
//   Stripe / Razorpay dialects). The apps talk to it over HTTP through their own SDK adapters; the harness drives
//   "the outside world" (customer pays, dashboard refunds, refund settlement) directly on the World and delivers
//   signed webhooks itself, so every ordering / duplication / loss is under the test's control.
// * InlineApp: inline-marketplace as a real child process (restartable, killable).
// * WorkerApp: worker-marketplace in-process (restartable), jobs drained deterministically.
// * audit(): the money laws, checked against the app's stored state and the provider's TRUE state (World), never
//   against HTTP responses.
import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { SimServer } from "@moneyinvariant/engine";
import { razorpayDialect } from "@moneyinvariant/dialect-razorpay";
import { stripeDialect } from "@moneyinvariant/dialect-stripe";
import { type ProviderDialect, type SimSecrets, World, type WorldEvent } from "@moneyinvariant/sim";
import pg from "pg";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const ADMIN = process.env.MI_PG_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";

export type ProviderName = "stripe" | "razorpay";
export type AppKind = "inline" | "worker";

// ------------------------------------------------------------------------------------------------ databases
let dbCounter = 0;
export async function createDb(): Promise<{ name: string; url: string; drop: () => Promise<void> }> {
  const name = `mit_${process.pid}_${Date.now().toString(36)}_${++dbCounter}`;
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(ADMIN);
  u.pathname = `/${name}`;
  return {
    name,
    url: u.toString(),
    drop: async () => {
      const a = new pg.Client({ connectionString: ADMIN });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
      await a.end();
    },
  };
}

// ------------------------------------------------------------------------------------------------ the provider twin
export class Twin {
  readonly name: ProviderName;
  readonly dialect: ProviderDialect;
  readonly world: World;
  readonly server: SimServer;
  readonly secrets: SimSecrets;
  base = "";
  /** How many world events have already been handed to deliverNew(). */
  cursor = 0;
  private constructor(name: ProviderName, world: World, server: SimServer, secrets: SimSecrets) {
    this.name = name;
    this.dialect = name === "stripe" ? stripeDialect : razorpayDialect;
    this.world = world;
    this.server = server;
    this.secrets = secrets;
  }
  static async start(name: ProviderName, opts: { asyncRefunds?: boolean } = {}): Promise<Twin> {
    const dialect = name === "stripe" ? stripeDialect : razorpayDialect;
    const world = new World({
      refundSettlement: opts.asyncRefunds ? "async" : "immediate",
      emitCreated: true,
      clock: () => Math.floor(Date.now() / 1000),
    });
    const secrets: SimSecrets = {
      apiKey: "sk_mi_test_secret",
      apiKeyId: "rzp_test_mikey",
      webhookSecret: "whsec_mi_test_secret",
    };
    const server = new SimServer(
      dialect,
      world,
      secrets,
      () => Math.floor(Date.now() / 1000),
      () => Date.now(),
    );
    server.fidelity = 2;
    const t = new Twin(name, world, server, secrets);
    t.base = await server.start();
    return t;
  }
  async stop(): Promise<void> {
    await this.server.stop();
  }
  env(): Record<string, string> {
    return this.name === "stripe"
      ? {
          PAYMENT_PROVIDER: "stripe",
          MONEYINV_STRIPE_API_BASE: this.base,
          STRIPE_SECRET_KEY: this.secrets.apiKey,
          STRIPE_WEBHOOK_SECRET: this.secrets.webhookSecret,
        }
      : {
          PAYMENT_PROVIDER: "razorpay",
          MONEYINV_RAZORPAY_API_BASE: this.base,
          RAZORPAY_KEY_ID: this.secrets.apiKeyId ?? "",
          RAZORPAY_KEY_SECRET: this.secrets.apiKey,
          RAZORPAY_WEBHOOK_SECRET: this.secrets.webhookSecret,
        };
  }
  /** Canonical world id of an app-side payment reference (PaymentIntent id / Razorpay order id). */
  canon(appRef: string): string {
    return this.dialect.fromWireId(appRef);
  }
  wire(canonical: string): string {
    return this.dialect.toWireId(canonical);
  }
  payment(appRef: string) {
    const p = this.world.payments.get(this.canon(appRef));
    if (!p) throw new Error(`twin has no payment for ${appRef}`);
    return p;
  }
  /** Customer attempts the payment at the provider (no webhook is delivered by this call). */
  customerPays(appRef: string, outcome: "success" | "decline" | "timeout" | "processing" = "success"): void {
    const r = this.world.apply({ kind: "customerPays", paymentId: this.canon(appRef), outcome });
    if (!r.ok) throw new Error(`customerPays failed: ${r.error.message}`);
  }
  /** Out-of-band (dashboard) refund. */
  dashboardRefund(appRef: string, amount?: bigint): string {
    const r = this.world.apply({
      kind: "createRefund",
      paymentId: this.canon(appRef),
      origin: "dashboard",
      ...(amount === undefined ? {} : { amount }),
    });
    if (!r.ok) throw new Error(`dashboard refund failed: ${r.error.message}`);
    return this.wire((r.value as { id: string }).id);
  }
  settleRefund(refundWireId: string, outcome: "succeeded" | "failed" | "canceled"): void {
    const r = this.world.apply({ kind: "settleRefund", refundId: this.canon(refundWireId), outcome });
    if (!r.ok) throw new Error(`settleRefund failed: ${r.error.message}`);
  }
  refundWireIds(): string[] {
    return [...this.world.refunds.keys()].map((k) => this.wire(k));
  }
  liveRefundTotal(): bigint {
    let s = 0n;
    for (const r of this.world.refunds.values()) if (holds(r.status)) s += r.amount;
    return s;
  }
  /** Wire bodies (one per fan-out sibling) for one world event. */
  encodings(ev: WorldEvent, signature: "valid" | "wrong_secret" | "missing_header" | "body_tampered" = "valid") {
    const n = this.dialect.siblings?.(ev, 2, new Set()).length ?? 1;
    const out = [];
    for (let i = 0; i < Math.max(n, 1); i++) {
      const e = this.dialect.encodeEvent(ev, this.secrets, Math.floor(Date.now() / 1000), {
        sibling: i,
        signature,
        fidelity: 2,
      });
      if (e) out.push(e);
    }
    return out;
  }
  async post(appBase: string, enc: { headers: Readonly<Record<string, string>>; body: string }) {
    const r = await fetch(`${appBase}/webhooks/${this.name}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...enc.headers },
      body: enc.body,
      signal: AbortSignal.timeout(30_000),
    });
    return { status: r.status, text: await r.text() };
  }
  /** Deliver every sibling of one world event; returns the HTTP statuses. */
  async deliver(appBase: string, ev: WorldEvent, signature: "valid" | "wrong_secret" | "missing_header" | "body_tampered" = "valid") {
    const out: number[] = [];
    for (const enc of this.encodings(ev, signature)) out.push((await this.post(appBase, enc)).status);
    return out;
  }
  /** Deliver all not-yet-delivered world events in creation order (optionally filtered). */
  async deliverNew(appBase: string, filter: (e: WorldEvent) => boolean = () => true) {
    const evs = this.world.events.slice(this.cursor);
    this.cursor = this.world.events.length;
    const out: { type: string; statuses: number[] }[] = [];
    for (const e of evs) if (filter(e)) out.push({ type: e.type, statuses: await this.deliver(appBase, e) });
    return out;
  }
  /** Re-deliver every world event ever produced (simulates provider replay / retries). */
  async replayAll(appBase: string) {
    const out: number[] = [];
    for (const e of this.world.events) out.push(...(await this.deliver(appBase, e)));
    return out;
  }
  get calls() {
    return this.server.calls;
  }
}

export const holds = (s: string): boolean => s === "pending" || s === "requires_action" || s === "succeeded";

// ------------------------------------------------------------------------------------------------ apps
export interface HttpResult {
  status: number;
  body: Record<string, any>;
}
export interface App {
  readonly kind: AppKind;
  readonly provider: ProviderName;
  base: string;
  dbUrl: string;
  req(method: string, path: string, body?: unknown): Promise<HttpResult>;
  /** Let background machinery (worker jobs / refund recovery scans) run to quiescence. */
  drain(): Promise<void>;
  /** Kill without any graceful shutdown, then boot a new instance on the same database. */
  crashAndRestart(): Promise<void>;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });
}

async function request(base: string, method: string, path: string, body?: unknown): Promise<HttpResult> {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  let parsed: Record<string, any> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: r.status, body: parsed };
}

export async function waitFor(cond: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

class InlineApp implements App {
  readonly kind = "inline" as const;
  readonly provider: ProviderName;
  base = "";
  dbUrl: string;
  private child: ChildProcess | undefined;
  private readonly env: Record<string, string>;
  private log = "";
  constructor(provider: ProviderName, dbUrl: string, env: Record<string, string>) {
    this.provider = provider;
    this.dbUrl = dbUrl;
    this.env = env;
  }
  async boot(): Promise<void> {
    const port = await freePort();
    this.log = "";
    this.child = spawn(process.execPath, ["src/server.ts"], {
      cwd: `${ROOT}inline-marketplace`,
      env: { ...process.env, ...this.env, DATABASE_URL: this.dbUrl, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stdout?.on("data", (d) => {
      this.log += String(d);
    });
    this.child.stderr?.on("data", (d) => {
      this.log += String(d);
    });
    this.base = `http://127.0.0.1:${port}`;
    try {
      await waitFor(
        async () => {
          if (this.child?.exitCode !== null) throw new Error(`inline app exited: ${this.log}`);
          return fetch(`${this.base}/healthz`)
            .then((r) => r.ok)
            .catch(() => false);
        },
        "inline app health",
        30_000,
      );
    } catch (e) {
      throw new Error(`${(e as Error).message}\n${this.log}`);
    }
  }
  req(method: string, path: string, body?: unknown) {
    return request(this.base, method, path, body);
  }
  async drain(): Promise<void> {
    // refund recovery scans run every 500 ms inside the app; give them a few turns.
    await new Promise((r) => setTimeout(r, 1100));
  }
  async crashAndRestart(): Promise<void> {
    await this.kill();
    await this.boot();
  }
  private async kill(): Promise<void> {
    const c = this.child;
    if (!c || c.exitCode !== null) return;
    const done = new Promise<void>((r) => c.once("exit", () => r()));
    c.kill("SIGKILL");
    await done;
  }
  async stop(): Promise<void> {
    await this.kill();
  }
}

class WorkerApp implements App {
  readonly kind = "worker" as const;
  readonly provider: ProviderName;
  base = "";
  dbUrl: string;
  private readonly env: Record<string, string>;
  private db: any;
  private app: any;
  constructor(provider: ProviderName, dbUrl: string, env: Record<string, string>) {
    this.provider = provider;
    this.dbUrl = dbUrl;
    this.env = env;
  }
  async boot(recover: boolean): Promise<void> {
    const dbmod = await import("../../worker-marketplace/src/db.ts");
    const provmod = await import("../../worker-marketplace/src/provider.ts");
    const srv = await import("../../worker-marketplace/src/server.ts");
    this.db = dbmod.createPool(this.dbUrl);
    await dbmod.migrate(this.db);
    const provider = provmod.providerFromEnv({ ...this.env } as NodeJS.ProcessEnv);
    this.app = srv.createApp(this.db, provider);
    if (recover) {
      await this.app.worker.recover();
      await this.app.shop.recoverRefundRequests();
    }
    await new Promise<void>((r) => this.app.server.listen(0, "127.0.0.1", () => r()));
    this.base = `http://127.0.0.1:${(this.app.server.address() as net.AddressInfo).port}`;
  }
  req(method: string, path: string, body?: unknown) {
    return request(this.base, method, path, body);
  }
  /** Run queued jobs to quiescence (collapsing retry back-off so the test does not sleep). */
  async drain(): Promise<void> {
    for (let round = 0; round < 40; round++) {
      await this.db.query("UPDATE jobs SET run_after = now() WHERE state = 'queued'");
      let ran = 0;
      while (await this.app.worker.runOnce()) ran++;
      const left = await this.db.query("SELECT count(*)::int c FROM jobs WHERE state = 'queued'");
      if (!ran && left.rows[0].c === 0) return;
      if (ran === 0) return;
    }
  }
  async crashAndRestart(): Promise<void> {
    // Abrupt: no worker.stop(); sockets and pool are torn down without finishing anything.
    await new Promise<void>((r) => {
      this.app.server.closeAllConnections?.();
      this.app.server.close(() => r());
    });
    await this.db.end().catch(() => {});
    await this.boot(true);
  }
  async stop(): Promise<void> {
    await new Promise<void>((r) => {
      this.app.server.closeAllConnections?.();
      this.app.server.close(() => r());
    });
    await this.db.end().catch(() => {});
  }
}

// ------------------------------------------------------------------------------------------------ the test context
export interface Ctx {
  kind: AppKind;
  provider: ProviderName;
  twin: Twin;
  app: App;
  /** Direct read-only SQL access to the app database. */
  q(sql: string, params?: unknown[]): Promise<any[]>;
  createOrder(lines: (number | bigint)[], o?: { currency?: string; capture?: "automatic" | "manual"; sellers?: string[] }): Promise<{ id: string; lines: string[]; total: bigint }>;
  checkout(orderId: string): Promise<HttpResult>;
  /** The provider payment reference the app stored for the order. */
  paymentRef(orderId: string): Promise<string>;
  refund(orderId: string, lineId: string, amount: number | bigint): Promise<HttpResult>;
  /** checkout + customer pays + deliver every webhook. Returns the app-side payment ref. */
  paidOrder(lines: (number | bigint)[], o?: { currency?: string; sellers?: string[] }): Promise<{ id: string; lines: string[]; total: bigint; ref: string }>;
  hook(): string;
  close(): Promise<void>;
}

export async function setup(kind: AppKind, provider: ProviderName, opts: { asyncRefunds?: boolean } = {}): Promise<Ctx> {
  const twin = await Twin.start(provider, opts);
  const db = await createDb();
  const env = twin.env();
  let app: App;
  if (kind === "inline") {
    const a = new InlineApp(provider, db.url, env);
    await a.boot();
    app = a;
  } else {
    const a = new WorkerApp(provider, db.url, env);
    await a.boot(false);
    app = a;
  }
  const reader = new pg.Pool({ connectionString: db.url, max: 3 });
  const q = async (sql: string, params: unknown[] = []) => (await reader.query(sql, params)).rows;
  const ctx: Ctx = {
    kind,
    provider,
    twin,
    app,
    q,
    hook: () => app.base,
    async createOrder(lines, o = {}) {
      const sellers = o.sellers ?? lines.map((_l, i) => (i % 2 === 0 ? "seller_a" : "seller_b"));
      const r = await app.req("POST", "/orders", {
        buyer: "buyer_1",
        currency: o.currency ?? "INR",
        capture: o.capture ?? "automatic",
        lines: lines.map((a, i) => ({ seller_id: sellers[i], amount: Number(a) })),
      });
      if (r.status !== 201) throw new Error(`create order failed: ${r.status} ${JSON.stringify(r.body)}`);
      return { id: r.body.id, lines: r.body.lines, total: BigInt(r.body.total) };
    },
    checkout: (id) => app.req("POST", `/orders/${id}/checkout`, {}),
    async paymentRef(id) {
      const col = kind === "inline" ? "payment_intent_id" : "payment_ref";
      const rows = await q(`SELECT ${col} AS ref FROM orders WHERE id=$1`, [id]);
      return rows[0]?.ref as string;
    },
    refund: (orderId, lineId, amount) =>
      app.req("POST", `/orders/${orderId}/refunds`, { line_id: lineId, amount: Number(amount) }),
    async paidOrder(lines, o = {}) {
      const order = await ctx.createOrder(lines, o);
      const co = await ctx.checkout(order.id);
      if (co.status !== 200) throw new Error(`checkout failed: ${co.status} ${JSON.stringify(co.body)}`);
      const ref = await ctx.paymentRef(order.id);
      twin.customerPays(ref);
      await twin.deliverNew(app.base);
      await app.drain();
      return { ...order, ref };
    },
    async close() {
      await app.stop().catch(() => {});
      await twin.stop().catch(() => {});
      await reader.end().catch(() => {});
      await db.drop();
    },
  };
  return ctx;
}

// ------------------------------------------------------------------------------------------------ the money laws
const feeOf = (amount: bigint): bigint => {
  // 10% commission, rounded half to even, integer arithmetic only (independent re-statement of the README rule)
  const n = amount * 1000n;
  const q = n / 10000n;
  const r = n % 10000n;
  if (r * 2n > 10000n || (r * 2n === 10000n && q % 2n === 1n)) return q + 1n;
  return q;
};
export { feeOf };

export interface AuditOptions {
  /** Provider refunds the app may legitimately not know yet (e.g. an unresolved lost-response request). */
  tolerateUnknownRefunds?: boolean;
  /** Allow unresolved refund reservations (ambiguous outcomes awaiting provider evidence). */
  allowOpenRequests?: boolean;
  /** Skip the refund status equality check (events deliberately withheld). */
  skipRefundStatus?: boolean;
}

/** All money laws. Returns a list of human readable problems; an empty list means the books are right. */
export async function audit(ctx: Ctx, opts: AuditOptions = {}): Promise<string[]> {
  const { twin, kind } = ctx;
  const P: string[] = [];
  const payCol = kind === "inline" ? "payment_intent_id" : "payment_ref";
  const orders = (await ctx.q(`SELECT id, currency, total::text total, status, ${payCol} AS ref FROM orders`)).map((r) => ({ ...r, total: BigInt(r.total) }));
  const lines = (await ctx.q("SELECT id, order_id, seller_id, amount::text amount FROM order_lines")).map((r) => ({ ...r, amount: BigInt(r.amount) }));
  const refunds = (await ctx.q("SELECT id, order_id, line_id, provider_ref, amount::text amount, status, origin FROM refunds")).map((r) => ({ ...r, amount: BigInt(r.amount) }));
  const ledger = (await ctx.q("SELECT txn_id, account, currency, amount::text amount, cause_ref, kind, effect_ref FROM ledger_entries")).map((r) => ({ ...r, amount: BigInt(r.amount) }));
  const openReqs =
    kind === "inline"
      ? await ctx.q("SELECT id FROM refund_requests WHERE NOT resolved")
      : await ctx.q("SELECT id FROM refund_requests WHERE state IN ('requested','unknown')");
  const sum = (xs: { amount: bigint }[]) => xs.reduce((s, x) => s + x.amount, 0n);

  // L1 double entry: every transaction and the whole book balance per currency
  const byTxn = new Map<string, bigint>();
  const byCur = new Map<string, bigint>();
  for (const e of ledger) {
    byTxn.set(`${e.txn_id}|${e.currency}`, (byTxn.get(`${e.txn_id}|${e.currency}`) ?? 0n) + e.amount);
    byCur.set(e.currency, (byCur.get(e.currency) ?? 0n) + e.amount);
  }
  for (const [k, v] of byTxn) if (v !== 0n) P.push(`ledger txn ${k} unbalanced by ${v}`);
  for (const [k, v] of byCur) if (v !== 0n) P.push(`ledger currency ${k} unbalanced by ${v}`);

  // L2 order paid iff captured at the provider; clearing mirrors the provider
  const orderByRef = new Map(orders.filter((o) => o.ref).map((o) => [o.ref as string, o]));
  const refundWire = new Map<string, { id: string; paymentWire: string; amount: bigint; status: string; currency: string }>();
  for (const r of twin.world.refunds.values())
    refundWire.set(twin.wire(r.id), {
      id: r.id,
      paymentWire: twin.wire(r.paymentId),
      amount: r.amount,
      status: r.status,
      currency: r.currency,
    });
  const capturedOf = new Map<string, bigint>();
  for (const p of twin.world.payments.values()) {
    const wire = twin.wire(p.id);
    capturedOf.set(wire, p.amountCaptured);
    const o = orderByRef.get(wire);
    if (p.amountCaptured > 0n) {
      if (!o) {
        P.push(`provider captured ${p.amountCaptured} on ${wire} but the app has no order for it`);
        continue;
      }
      if (!["paid", "partially_refunded", "refunded"].includes(o.status))
        P.push(`order ${o.id} is '${o.status}' but ${p.amountCaptured} ${p.currency} is captured at the provider`);
      if (p.amountCaptured !== o.total) P.push(`order ${o.id} total ${o.total} != captured ${p.amountCaptured}`);
      const live = [...refundWire.values()].filter((r) => r.paymentWire === wire && holds(r.status)).reduce((s, r) => s + r.amount, 0n);
      const expect = live === 0n ? "paid" : live >= p.amountCaptured ? "refunded" : "partially_refunded";
      if (o.status !== expect) P.push(`order ${o.id} status '${o.status}', expected '${expect}' from provider truth (live refunds ${live})`);
    } else if (o && ["paid", "partially_refunded", "refunded"].includes(o.status)) {
      P.push(`order ${o.id} is '${o.status}' but nothing is captured at the provider`);
    }
  }
  for (const o of orders)
    if (["paid", "partially_refunded", "refunded"].includes(o.status) && !(o.ref && capturedOf.get(o.ref)))
      P.push(`order ${o.id} is '${o.status}' without any captured provider payment`);

  // L3 sale postings equal captured money, split per line with half-even commission
  const clearing = ledger.filter((e) => e.account === "provider:clearing");
  for (const [wire, cap] of capturedOf) {
    const o = orderByRef.get(wire);
    const sale = clearing.filter((e) => e.cause_ref === wire && e.kind === "sale");
    if (sum(sale) !== cap) P.push(`sale clearing for ${wire} is ${sum(sale)}, provider captured ${cap}`);
    const refundWires = [...refundWire.entries()].filter(([, r]) => r.paymentWire === wire).map(([w]) => w);
    const live = [...refundWire.entries()].filter(([w, r]) => refundWires.includes(w) && holds(r.status)).reduce((s, [, r]) => s + r.amount, 0n);
    const net = sum(clearing.filter((e) => e.cause_ref === wire || refundWires.includes(e.cause_ref)));
    const expectNet = cap - (opts.tolerateUnknownRefunds ? sum(clearing.filter((e) => refundWires.includes(e.cause_ref)).map((e) => ({ amount: -e.amount }))) : live);
    if (net !== expectNet) P.push(`provider:clearing for ${wire} nets ${net}, expected ${expectNet} (captured ${cap}, live refunds ${live})`);
    if (o) for (const e of ledger.filter((x) => x.cause_ref === wire || refundWires.includes(x.cause_ref)))
      if (e.currency !== o.currency) P.push(`ledger entry ${e.txn_id}/${e.account} in ${e.currency}, order ${o.id} is ${o.currency}`);
  }
  const expSeller = new Map<string, bigint>();
  let expCommission = 0n;
  for (const o of orders) {
    const cap = o.ref ? capturedOf.get(o.ref) ?? 0n : 0n;
    if (cap === 0n) continue;
    for (const l of lines.filter((x) => x.order_id === o.id)) {
      const fee = feeOf(l.amount);
      expCommission += fee;
      expSeller.set(`seller:${l.seller_id}`, (expSeller.get(`seller:${l.seller_id}`) ?? 0n) - (l.amount - fee));
    }
  }
  // live refunds booked against lines debit that seller; line-less ones go to platform:unallocated_refunds
  let expUnalloc = 0n;
  for (const r of refunds) {
    if (!holds(r.status)) continue;
    if (r.line_id) {
      const l = lines.find((x) => x.id === r.line_id);
      if (!l) {
        P.push(`refund ${r.provider_ref} points at unknown line ${r.line_id}`);
        continue;
      }
      expSeller.set(`seller:${l.seller_id}`, (expSeller.get(`seller:${l.seller_id}`) ?? 0n) + r.amount);
    } else expUnalloc += r.amount;
  }
  const actual = new Map<string, bigint>();
  for (const e of ledger) actual.set(e.account, (actual.get(e.account) ?? 0n) + e.amount);
  for (const [acc, v] of expSeller) if ((actual.get(acc) ?? 0n) !== v) P.push(`${acc} nets ${actual.get(acc) ?? 0n}, expected ${v}`);
  for (const [acc, v] of actual) if (acc.startsWith("seller:") && !expSeller.has(acc) && v !== 0n) P.push(`${acc} nets ${v}, expected 0`);
  const commission = [...actual].filter(([a]) => a.startsWith("platform:revenue") || a === "platform:commission").reduce((s, [, v]) => s + v, 0n);
  if (commission !== -expCommission) P.push(`platform commission nets ${commission}, expected ${-expCommission}`);
  if ((actual.get("platform:unallocated_refunds") ?? 0n) !== expUnalloc) P.push(`platform:unallocated_refunds nets ${actual.get("platform:unallocated_refunds") ?? 0n}, expected ${expUnalloc}`);
  for (const a of actual.keys())
    if (!(a === "provider:clearing" || a.startsWith("seller:") || a.startsWith("platform:revenue") || ["platform:commission", "platform:unallocated_refunds"].includes(a)))
      P.push(`unexpected ledger account ${a}`);

  // L4 refunds: provider and app agree on existence, amount and (once settled) outcome
  const appRefund = new Map(refunds.map((r) => [r.provider_ref, r]));
  for (const [wire, w] of refundWire) {
    const a = appRefund.get(wire);
    if (!a) {
      if (!opts.tolerateUnknownRefunds) P.push(`provider refund ${wire} (${w.amount}, ${w.status}) unknown to the app`);
      continue;
    }
    if (a.amount !== w.amount) P.push(`refund ${wire} amount app ${a.amount} != provider ${w.amount}`);
    if (!opts.skipRefundStatus && a.status !== w.status) P.push(`refund ${wire} status app '${a.status}' != provider '${w.status}'`);
  }
  for (const r of refunds) if (!refundWire.has(r.provider_ref)) P.push(`app refund ${r.provider_ref} does not exist at the provider`);
  if (refunds.length !== new Set(refunds.map((r) => r.provider_ref)).size) P.push("duplicate app refund rows for one provider refund");

  // L5 each refund is recognised once and reversed at most once; failed/canceled refunds leave no residue
  for (const [wire, w] of refundWire) {
    const es = ledger.filter((e) => e.cause_ref === wire);
    const rec = es.filter((e) => e.kind === "refund");
    const rev = es.filter((e) => e.kind === "refund_reversal");
    if (rec.length > 2) P.push(`refund ${wire} recognised ${rec.length} times`);
    if (rev.length > 2) P.push(`refund ${wire} reversed ${rev.length} times`);
    const net = sum(es.filter((e) => e.account === "provider:clearing"));
    const known = appRefund.has(wire);
    if (known && !opts.skipRefundStatus) {
      const expectNet = holds(w.status) ? -w.amount : 0n;
      if (net !== expectNet) P.push(`refund ${wire} (${w.status}) nets ${net} on clearing, expected ${expectNet}`);
      const other = sum(es.filter((e) => e.account !== "provider:clearing"));
      if (other !== (holds(w.status) ? w.amount : 0n)) P.push(`refund ${wire} (${w.status}) counter-entries net ${other}`);
    }
  }

  // L6 refund bounds
  const liveByLine = new Map<string, bigint>();
  const liveByOrder = new Map<string, bigint>();
  for (const r of refunds) {
    if (!holds(r.status)) continue;
    if (r.line_id) liveByLine.set(r.line_id, (liveByLine.get(r.line_id) ?? 0n) + r.amount);
    liveByOrder.set(r.order_id, (liveByOrder.get(r.order_id) ?? 0n) + r.amount);
  }
  for (const l of lines) if ((liveByLine.get(l.id) ?? 0n) > l.amount) P.push(`line ${l.id} refunded ${liveByLine.get(l.id)} > line amount ${l.amount}`);
  for (const o of orders) if ((liveByOrder.get(o.id) ?? 0n) > o.total) P.push(`order ${o.id} refunded ${liveByOrder.get(o.id)} > total ${o.total}`);
  for (const p of twin.world.payments.values()) {
    const live = [...twin.world.refunds.values()].filter((r) => r.paymentId === p.id && holds(r.status)).reduce((s, r) => s + r.amount, 0n);
    if (live > p.amountCaptured) P.push(`PROVIDER holds ${live} of refunds on a payment that captured ${p.amountCaptured} (money lost)`);
  }

  // L7 attribution: a refund allocated to a line must be a refund of that line's own order's payment
  for (const r of refunds) {
    if (!r.line_id) continue;
    const l = lines.find((x) => x.id === r.line_id);
    const w = refundWire.get(r.provider_ref);
    if (l && l.order_id !== r.order_id) P.push(`refund ${r.provider_ref} on order ${r.order_id} allocated to a line of order ${l.order_id}`);
    if (l && w && orderByRef.get(w.paymentWire)?.id !== l.order_id) P.push(`refund ${r.provider_ref} moved money on another order's payment than its line's order`);
  }

  // L8 attribution by origin: only API refunds belong to a line; a dashboard refund must never inherit one
  for (const [wire, w] of refundWire) {
    const a = appRefund.get(wire);
    const wr = twin.world.refunds.get(w.id);
    if (!a || !wr) continue;
    if (wr.origin === "dashboard" && a.line_id) P.push(`dashboard refund ${wire} was attributed to line ${a.line_id}`);
    if (wr.origin === "api" && !a.line_id) P.push(`API refund ${wire} was not attributed to any line`);
  }

  if (!opts.allowOpenRequests && openReqs.length) P.push(`${openReqs.length} refund request(s) still unresolved`);
  return P;
}
