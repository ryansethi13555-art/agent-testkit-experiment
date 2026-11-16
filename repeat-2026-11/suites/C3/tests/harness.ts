// Shared harness for the money-correctness suite.
//
// Each test boots a REAL application process (inline-marketplace or worker-marketplace) against a throwaway
// Postgres database and a contract-faithful provider twin (MoneyInvariant's simulator server + canonical World).
// The twin plays the payment provider: it holds the ground truth (payments, captures, refunds, postings), applies
// idempotent replay, and can inject faults (lost responses, 5xx, 429, crash). The test plays the buyer and the
// provider's webhook sender. After every scenario the books are audited against the twin's truth (assertBooks).
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { razorpayDialect } from "@moneyinvariant/dialect-razorpay";
import { stripeDialect } from "@moneyinvariant/dialect-stripe";
import { type GateRule, SimServer } from "@moneyinvariant/engine";
import {
  type ProviderDialect,
  type SimSecrets,
  World,
  type WorldCommand,
  type WorldEvent,
  type WorldOptions,
} from "@moneyinvariant/sim";
import pg from "pg";

export type AppName = "inline" | "worker";
export type ProviderName = "stripe" | "razorpay";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR: Record<AppName, string> = {
  inline: path.join(ROOT, "inline-marketplace"),
  worker: path.join(ROOT, "worker-marketplace"),
};
export const ADMIN = process.env.MI_PG_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export { sleep };

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

export interface Resp {
  status: number;
  body: Record<string, any>;
}

export interface StackOptions {
  app: AppName;
  provider: ProviderName;
  refunds?: "immediate" | "async";
}

export class Stack {
  readonly app: AppName;
  readonly provider: ProviderName;
  readonly dialect: ProviderDialect;
  readonly world: World;
  readonly sim: SimServer;
  readonly secrets: SimSecrets;
  readonly dbName: string;
  db!: pg.Client;
  simUrl = "";
  base = "";
  child: ChildProcess | undefined;
  log = "";
  /** Index into world.events up to which webhooks were already delivered by deliverNew(). */
  delivered = 0;
  /** Every webhook the test sent: used to check duplicates and replays. */
  sent: { eventId: string; status: number }[] = [];

  private constructor(o: StackOptions) {
    this.app = o.app;
    this.provider = o.provider;
    this.dialect = o.provider === "stripe" ? stripeDialect : razorpayDialect;
    const worldOpts: WorldOptions = { refundSettlement: o.refunds ?? "immediate" };
    this.world = new World(worldOpts);
    this.secrets =
      o.provider === "stripe"
        ? { apiKey: "sk_test_ct_suite", webhookSecret: "whsec_ct_suite" }
        : { apiKey: "rzp_secret_ct_suite", apiKeyId: "rzp_test_ct_id", webhookSecret: "rzp_whsec_ct_suite" };
    this.sim = new SimServer(
      this.dialect,
      this.world,
      this.secrets,
      () => Math.floor(Date.now() / 1000),
      () => Date.now(),
    );
    this.dbName = `ct_${o.app}_${o.provider}_${randomBytes(4).toString("hex")}`;
  }

  static async start(o: StackOptions): Promise<Stack> {
    const s = new Stack(o);
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${s.dbName}`);
    await admin.end();
    s.simUrl = await s.sim.start();
    await s.boot();
    s.db = new pg.Client({ connectionString: s.dbUrl });
    await s.db.connect();
    return s;
  }

  get dbUrl(): string {
    return ADMIN.replace(/\/[^/]*$/, `/${this.dbName}`);
  }

  /** Start (or restart after a crash) the application process. */
  async boot(): Promise<void> {
    const port = await freePort();
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PORT: String(port),
      DATABASE_URL: this.dbUrl,
      MONEYINV_RUN: "1",
      ...(this.provider === "stripe"
        ? {
            PAYMENT_PROVIDER: "stripe",
            MONEYINV_STRIPE_API_BASE: this.simUrl,
            STRIPE_SECRET_KEY: this.secrets.apiKey,
            STRIPE_WEBHOOK_SECRET: this.secrets.webhookSecret,
          }
        : {
            PAYMENT_PROVIDER: "razorpay",
            MONEYINV_RAZORPAY_API_BASE: this.simUrl,
            RAZORPAY_KEY_ID: this.secrets.apiKeyId ?? "",
            RAZORPAY_KEY_SECRET: this.secrets.apiKey,
            RAZORPAY_WEBHOOK_SECRET: this.secrets.webhookSecret,
          }),
    };
    const child = spawn(process.execPath, ["src/server.ts"], { cwd: APP_DIR[this.app], env });
    child.stdout?.on("data", (d) => {
      this.log += String(d);
    });
    child.stderr?.on("data", (d) => {
      this.log += String(d);
    });
    this.child = child;
    this.base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const r = await fetch(`${this.base}/healthz`);
        if (r.ok) return;
      } catch {
        /* not up yet */
      }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`app exited early:\n${this.log}`);
      if (Date.now() > deadline) throw new Error(`app did not become healthy:\n${this.log}`);
      await sleep(50);
    }
  }

  /** Kill -9 the application (a crash), without any graceful shutdown. */
  async crash(): Promise<void> {
    const c = this.child;
    if (!c || c.exitCode !== null || c.signalCode !== null) return;
    await new Promise<void>((r) => {
      c.once("exit", () => r());
      c.kill("SIGKILL");
    });
  }

  async restart(): Promise<void> {
    await this.crash();
    await this.boot();
  }

  async stop(): Promise<void> {
    await this.crash();
    await this.db.end().catch(() => {});
    await this.sim.stop();
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${this.dbName} WITH (FORCE)`);
    await admin.end();
  }

  // ------------------------------------------------------------------------------------------ HTTP to the app
  async post(p: string, body: unknown = {}): Promise<Resp> {
    const r = await fetch(this.base + p, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    let parsed: Record<string, any> = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { status: r.status, body: parsed };
  }

  async q<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.db.query(sql, params)).rows as T[];
  }
  async scalar(sql: string, params: unknown[] = []): Promise<string> {
    const rows = await this.q(sql, params);
    return String(Object.values(rows[0] ?? { v: "0" })[0]);
  }

  // ------------------------------------------------------------------------------------------ shop actions
  async createOrder(
    lines: { seller_id?: string; amount: number | string }[],
    opts: { currency?: string; capture?: "automatic" | "manual" } = {},
  ): Promise<{ id: string; lineIds: string[]; total: bigint }> {
    const r = await this.post("/orders", {
      buyer: "buyer_1",
      currency: opts.currency ?? "INR",
      capture: opts.capture ?? "automatic",
      lines: lines.map((l, i) => ({ seller_id: l.seller_id ?? (i % 2 === 0 ? "seller_a" : "seller_b"), amount: l.amount })),
    });
    if (r.status !== 201) throw new Error(`createOrder failed ${r.status} ${JSON.stringify(r.body)}`);
    return { id: r.body.id, lineIds: r.body.lines, total: BigInt(r.body.total) };
  }

  async checkout(orderId: string): Promise<Resp> {
    return this.post(`/orders/${orderId}/checkout`);
  }

  /** The provider payment reference the app stored for an order (null if none). */
  async paymentRef(orderId: string): Promise<string | null> {
    const col = this.app === "inline" ? "payment_intent_id" : "payment_ref";
    return (await this.q(`SELECT ${col} AS ref FROM orders WHERE id=$1`, [orderId]))[0]?.ref ?? null;
  }

  /** Canonical world payment for an order, found by the order id in its metadata. */
  worldPayments(orderId: string) {
    return [...this.world.payments.values()].filter((p) => p.metadata.order_id === orderId || p.metadata.receipt === orderId);
  }

  worldPaymentOf(orderId: string) {
    const all = this.worldPayments(orderId);
    if (all.length !== 1) throw new Error(`expected 1 world payment for ${orderId}, got ${all.length}`);
    return all[0] as NonNullable<(typeof all)[number]>;
  }

  /** Apply a world command (the buyer, the dashboard, time passing at the provider). */
  act(cmd: WorldCommand) {
    const r = this.world.apply(cmd);
    if (!r.ok) throw new Error(`world command ${cmd.kind} rejected: ${r.error.message}`);
    return r.value;
  }

  /** The buyer pays successfully at the provider; returns the events this caused (not delivered). */
  pay(orderId: string, outcome: "success" | "decline" | "timeout" | "processing" = "success"): WorldEvent[] {
    const p = this.worldPaymentOf(orderId);
    const before = this.world.events.length;
    this.act({ kind: "customerPays", paymentId: p.id, outcome });
    return this.world.events.slice(before);
  }

  // ------------------------------------------------------------------------------------------ webhooks
  /** Deliver one canonical event as the provider would (signed). `sibling` and `type` pick fan-out variants. */
  async deliver(
    ev: WorldEvent,
    o: { sibling?: number; type?: string; signature?: "valid" | "invalid" | "stale" } = {},
  ): Promise<Resp> {
    const enc = this.dialect.encodeEvent(ev, this.secrets, Math.floor(Date.now() / 1000), {
      sibling: o.sibling ?? 0,
      ...(o.type ? { type: o.type } : {}),
      ...(o.signature ? { signature: o.signature as never } : {}),
    });
    if (!enc) return { status: 0, body: { skipped: true } };
    const r = await fetch(`${this.base}/webhooks/${this.provider}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...enc.headers },
      body: enc.body,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    this.sent.push({ eventId: enc.eventId, status: r.status });
    let body: Record<string, any> = {};
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    return { status: r.status, body };
  }

  /** Deliver every wire sibling of an event (e.g. payment.captured and order.paid) sequentially. */
  async deliverAll(ev: WorldEvent): Promise<Resp[]> {
    const types = this.dialect.siblings?.(ev, 2, new Set()) ?? [];
    if (!types.length) return [await this.deliver(ev)];
    const out: Resp[] = [];
    for (const [i, type] of types.entries()) out.push(await this.deliver(ev, { sibling: i, type }));
    return out;
  }

  /** Deliver (once, in order) every world event not yet delivered. Returns the responses. */
  async deliverNew(): Promise<Resp[]> {
    const out: Resp[] = [];
    while (this.delivered < this.world.events.length) {
      const ev = this.world.events[this.delivered++] as WorldEvent;
      out.push(...(await this.deliverAll(ev)));
    }
    return out;
  }

  /** Mark all current events as delivered without sending them (e.g. a webhook the provider never got through). */
  skipDelivery(): void {
    this.delivered = this.world.events.length;
  }

  // ------------------------------------------------------------------------------------------ faults
  fault(rule: GateRule): void {
    this.sim.addRule(rule);
  }
  /** Fault the next `times` provider calls with this op (default once). */
  faultOp(op: string, fault: GateRule["fault"], times = 1, label = `fault-${op}`): void {
    this.sim.addRule({ label, match: (c) => c.op === op, ...(fault ? { fault } : {}), times });
  }
  calls(op: string) {
    return this.sim.calls.filter((c) => c.op === op);
  }

  // ------------------------------------------------------------------------------------------ settling
  /** Wait until the app has no background work left that could still change money. */
  async settle(o: { timeoutMs?: number; allowUnknownRefunds?: boolean } = {}): Promise<void> {
    const deadline = Date.now() + (o.timeoutMs ?? 25_000);
    for (;;) {
      let busy: number;
      if (this.app === "inline") {
        busy = Number(await this.scalar("SELECT count(*) FROM refund_requests WHERE NOT resolved"));
        if (o.allowUnknownRefunds) busy = 0;
      } else {
        busy = Number(await this.scalar("SELECT count(*) FROM jobs WHERE state IN ('queued','running')"));
        busy += Number(
          await this.scalar(
            `SELECT count(*) FROM refund_requests WHERE state IN ('requested'${o.allowUnknownRefunds ? "" : ",'unknown'"})`,
          ),
        );
      }
      if (busy === 0) {
        // one more tick: a job may be enqueued by the one that just finished
        await sleep(250);
        if (this.app === "worker") {
          const again = Number(await this.scalar("SELECT count(*) FROM jobs WHERE state IN ('queued','running')"));
          if (again > 0) continue;
        }
        return;
      }
      if (Date.now() > deadline) throw new Error(`stack did not settle (busy=${busy})\n${this.log.slice(-2000)}`);
      await sleep(100);
    }
  }
}

// ---------------------------------------------------------------------------------------------- the money laws
const HOLDS = ["pending", "requires_action", "succeeded"];
const PAID_LIKE = ["paid", "partially_refunded", "refunded"];

export interface BookOptions {
  /** Skip the exact agreement of refund sets (use while an unknown request is deliberately unresolved). */
  allowUnsettledRefunds?: boolean;
}

/**
 * Audit the app's stored state against the provider twin's ground truth. Returns the list of violated laws
 * (empty when the books are right). Laws are phrased on money, not on HTTP responses.
 */
export async function auditBooks(s: Stack, o: BookOptions = {}): Promise<string[]> {
  const bad: string[] = [];
  const d = s.dialect;
  const wire = (id: string) => d.toWireId(id);

  // L1 ledger.txn-balanced: every ledger transaction sums to zero per currency
  const unbalanced = await s.q(
    "SELECT txn_id, currency, sum(amount)::text s FROM ledger_entries GROUP BY txn_id, currency HAVING sum(amount) <> 0",
  );
  if (unbalanced.length) bad.push(`ledger.txn-balanced: ${JSON.stringify(unbalanced)}`);

  // L2 effect.once: each (cause, kind, effect slot, account, currency) is posted at most once
  const dup = await s.q(
    "SELECT cause_ref, kind, effect_ref, account, currency, count(*)::int n FROM ledger_entries GROUP BY 1,2,3,4,5 HAVING count(*) > 1",
  );
  if (dup.length) bad.push(`effect.once-per-provider-event: ${JSON.stringify(dup)}`);

  // L3 no float / sign confusion: sale clearing debits must be positive, refund clearing entries negative
  const badSign = await s.q(
    "SELECT * FROM ledger_entries WHERE account='provider:clearing' AND ((kind='sale' AND amount<=0) OR (kind='refund' AND amount>=0))",
  );
  if (badSign.length) bad.push(`ledger sign: ${JSON.stringify(badSign)}`);

  // L4 ledger.clearing-mirrors-provider: the clearing account equals the provider's held money, per currency
  const clearing = await s.q("SELECT currency, sum(amount)::text s FROM ledger_entries WHERE account='provider:clearing' GROUP BY currency");
  const expect = new Map<string, bigint>();
  for (const p of s.world.payments.values()) {
    expect.set(p.currency.toUpperCase(), (expect.get(p.currency.toUpperCase()) ?? 0n) + p.amountCaptured);
  }
  for (const r of s.world.refunds.values()) {
    if (HOLDS.includes(r.status))
      expect.set(r.currency.toUpperCase(), (expect.get(r.currency.toUpperCase()) ?? 0n) - r.amount);
  }
  const got = new Map(clearing.map((r) => [String(r.currency).toUpperCase(), BigInt(r.s)]));
  for (const cur of new Set([...expect.keys(), ...got.keys()])) {
    if ((expect.get(cur) ?? 0n) !== (got.get(cur) ?? 0n))
      bad.push(`ledger.clearing-mirrors-provider ${cur}: ledger ${got.get(cur) ?? 0n} vs provider ${expect.get(cur) ?? 0n}`);
  }

  // L5 order.paid-iff-captured, and intent.order-collection-bounded
  const orders = await s.q("SELECT * FROM orders");
  for (const o2 of orders) {
    const mine = [...s.world.payments.values()].filter(
      (p) => p.metadata.order_id === o2.id || p.metadata.receipt === o2.id,
    );
    const captured = mine.reduce((a, p) => a + p.amountCaptured, 0n);
    const isPaid = PAID_LIKE.includes(o2.status);
    if (captured > 0n && !isPaid) bad.push(`order.paid-iff-captured: ${o2.id} captured ${captured} but status ${o2.status}`);
    if (captured === 0n && isPaid) bad.push(`order.paid-iff-captured: ${o2.id} status ${o2.status} but nothing captured`);
    if (captured > BigInt(o2.total)) bad.push(`intent.order-collection-bounded: ${o2.id} provider keeps ${captured} > ${o2.total}`);
    if (mine.length > 1) bad.push(`more than one provider payment for order ${o2.id}: ${mine.length}`);
  }

  // L6 sale legs of every captured payment net to zero (clearing debit == sellers + commission)
  const saleSum = await s.q(
    "SELECT cause_ref, sum(amount)::text s FROM ledger_entries WHERE kind IN ('sale','commission','suspense') GROUP BY cause_ref HAVING sum(amount) <> 0",
  );
  if (saleSum.length) bad.push(`sale legs do not net to zero: ${JSON.stringify(saleSum)}`);

  // L7 refund.line-bounded and order bound on live (money-holding) refunds
  const lineRefunds = await s.q(
    "SELECT l.id, l.amount::text a, coalesce(sum(r.amount) FILTER (WHERE r.status IN ('pending','requires_action','succeeded')),0)::text r FROM order_lines l LEFT JOIN refunds r ON r.line_id = l.id GROUP BY l.id, l.amount",
  );
  for (const l of lineRefunds)
    if (BigInt(l.r) > BigInt(l.a)) bad.push(`refund.line-bounded: line ${l.id} refunded ${l.r} > ${l.a}`);
  const orderRefunds = await s.q(
    "SELECT o.id, o.total::text t, coalesce(sum(r.amount) FILTER (WHERE r.status IN ('pending','requires_action','succeeded')),0)::text r FROM orders o LEFT JOIN refunds r ON r.order_id = o.id GROUP BY o.id, o.total",
  );
  for (const r of orderRefunds)
    if (BigInt(r.r) > BigInt(r.t)) bad.push(`refund bound: order ${r.id} refunded ${r.r} > ${r.t}`);

  // L8 recon.refunds-agree and recon.refund-outcome-agrees (once settled)
  if (!o.allowUnsettledRefunds) {
    const appRefunds = await s.q("SELECT provider_ref, amount::text a, status, currency FROM refunds");
    const appMap = new Map(appRefunds.map((r) => [r.provider_ref as string, r]));
    for (const r of s.world.refunds.values()) {
      const a = appMap.get(wire(r.id));
      if (!a) {
        bad.push(`recon.refunds-agree: provider refund ${wire(r.id)} (${r.amount} ${r.status}) unknown to app`);
        continue;
      }
      if (BigInt(a.a) !== r.amount) bad.push(`recon.refunds-agree: ${wire(r.id)} app ${a.a} vs provider ${r.amount}`);
      if (a.status !== r.status) bad.push(`recon.refund-outcome-agrees: ${wire(r.id)} app ${a.status} vs provider ${r.status}`);
      if (String(a.currency).toUpperCase() !== r.currency.toUpperCase()) bad.push(`currency mismatch on ${wire(r.id)}`);
      appMap.delete(wire(r.id));
    }
    for (const [ref, r] of appMap) bad.push(`recon.refunds-agree: app refund ${ref} (${r.a}) unknown to provider`);
  }

  // L9 refunds recognised in the ledger exactly while the provider holds them
  const recognised = await s.q(
    "SELECT cause_ref, sum(-amount)::text s FROM ledger_entries WHERE account='provider:clearing' AND kind IN ('refund','refund_reversal') GROUP BY cause_ref",
  );
  const recMap = new Map(recognised.map((r) => [r.cause_ref as string, BigInt(r.s)]));
  for (const r of s.world.refunds.values()) {
    const want = HOLDS.includes(r.status) ? r.amount : 0n;
    const have = recMap.get(wire(r.id)) ?? 0n;
    if (!o.allowUnsettledRefunds && have !== want)
      bad.push(`ledger.failed-operation-no-residue: refund ${wire(r.id)} (${r.status}) ledger ${have} want ${want}`);
    recMap.delete(wire(r.id));
  }
  if (!o.allowUnsettledRefunds)
    for (const [ref, v] of recMap) if (v !== 0n) bad.push(`ledger shows refund ${ref} (${v}) the provider never made`);

  // L10 per party: after full failure of a refund, no residue on seller accounts (net per cause is zero)
  const residue = await s.q(
    "SELECT cause_ref, sum(amount)::text s FROM ledger_entries WHERE kind IN ('refund','refund_reversal') GROUP BY cause_ref HAVING sum(amount) <> 0",
  );
  if (residue.length) bad.push(`refund legs unbalanced: ${JSON.stringify(residue)}`);

  return bad;
}

/** Assert the money laws hold (throws with every violated law listed). */
export async function assertBooks(s: Stack, o: BookOptions = {}): Promise<void> {
  const bad = await auditBooks(s, o);
  if (bad.length) throw new Error(`MONEY LAWS VIOLATED:\n - ${bad.join("\n - ")}\napp log tail:\n${s.log.slice(-800)}`);
}

export const sumRows = async (s: Stack, sql: string, params: unknown[] = []) => BigInt(await s.scalar(sql, params));

export interface Combo {
  app: AppName;
  provider: ProviderName;
  name: string;
}
export const COMBOS: Combo[] = (["inline", "worker"] as const).flatMap((app) =>
  (["stripe", "razorpay"] as const).map((provider) => ({ app, provider, name: `${app}/${provider}` })),
);

/** Run `fn` with a fresh stack (own process, own database, own provider twin) and always clean up. */
export async function withStack<T>(
  c: { app: AppName; provider: ProviderName; refunds?: "immediate" | "async" },
  fn: (s: Stack) => Promise<T>,
): Promise<T> {
  const s = await Stack.start(c);
  try {
    return await fn(s);
  } finally {
    await s.stop();
  }
}

/** Create an order, check it out, have the buyer pay, and deliver the webhooks. Returns the order. */
export async function paidOrder(
  s: Stack,
  lines: { seller_id?: string; amount: number | string }[] = [{ amount: 600 }, { amount: 400 }],
  o: { currency?: string; deliver?: boolean } = {},
) {
  const order = await s.createOrder(lines, o.currency ? { currency: o.currency } : {});
  const co = await s.checkout(order.id);
  if (co.status !== 200) throw new Error(`checkout failed ${co.status} ${JSON.stringify(co.body)}`);
  s.pay(order.id);
  if (o.deliver !== false) {
    await s.deliverNew();
    await s.settle();
  }
  return order;
}
