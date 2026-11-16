// Shared harness: runs one real app (inline or worker marketplace) against one in-process contract-faithful
// provider twin (Stripe or Razorpay) and a real Postgres database, and checks money laws against the app's stored
// state and the twin's true state (never against HTTP responses alone).
import type { AddressInfo } from "node:net";
import { expect } from "vitest";
import pg from "pg";
import { compileInvariant } from "@moneyinvariant/core/invariants";
import { assertFinancialCorrectness, createProviderTwin, type ProviderTwin } from "@moneyinvariant/engine";
import { stripeDialect } from "@moneyinvariant/dialect-stripe";
import { razorpayDialect } from "@moneyinvariant/dialect-razorpay";
import type { WorldEvent, WorldRefund, WorldPayment } from "@moneyinvariant/sim";

export type AppKind = "inline" | "worker";
export type ProviderName = "stripe" | "razorpay";
export const ADMIN = process.env.MI_PG_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
export const LIVE = new Set(["pending", "succeeded", "requires_action"]);

export interface Res {
  status: number;
  body: Record<string, any>;
}
export interface Harness {
  appKind: AppKind;
  provider: ProviderName;
  twin: ProviderTwin;
  base: string;
  db: pg.Pool;
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Res>;
  newOrder(lines: number[], opts?: { capture?: "manual" | "automatic"; sellers?: string[] }): Promise<{ id: string; lines: string[]; total: bigint }>;
  checkout(orderId: string): Promise<Res>;
  paymentOf(orderId: string): WorldPayment;
  wire(id: string): string;
  deliverPending(opts?: { skip?: (ev: WorldEvent, sibling: number) => boolean }): Promise<number[]>;
  deliver(ev: WorldEvent, o?: { sibling?: number; fresh?: boolean; signature?: any }): Promise<number>;
  drain(): Promise<void>;
  pay(orderId: string): Promise<WorldPayment>;
  paidOrder(lines: number[], opts?: { capture?: "manual" | "automatic" }): Promise<{ id: string; lines: string[]; total: bigint; pay: WorldPayment }>;
  refund(orderId: string, line: string, amount: number | bigint): Promise<Res>;
  appRefunds(orderId: string): Promise<any[]>;
  orderRow(orderId: string): Promise<any>;
  ledgerFor(causes: string[]): Promise<any[]>;
  assertBooksAgree(orderId: string): Promise<void>;
  assertGlobalLedger(): Promise<void>;
  stop(): Promise<void>;
  eventsFor(paymentId: string): WorldEvent[];
  forget(ev: WorldEvent): void;
  oracle(): Promise<import("@moneyinvariant/engine").VerificationResult>;
}

export async function startHarness(appKind: AppKind, provider: ProviderName): Promise<Harness> {
  const dbName = `t_${appKind}_${provider}_${process.pid}`;
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const url = ADMIN.replace(/\/[^/]*$/, `/${dbName}`);
  const dialect = provider === "stripe" ? stripeDialect : razorpayDialect;
  const secrets =
    provider === "stripe"
      ? { apiKey: "sk_test_twin", webhookSecret: "whsec_twin" }
      : { apiKey: "rzp_secret_twin", apiKeyId: "rzp_test_twin", webhookSecret: "rzp_whsec_twin" };
  const twin = await createProviderTwin({ dialect, secrets });
  process.env.DATABASE_URL = url;
  process.env.PAYMENT_PROVIDER = provider;
  if (provider === "stripe") {
    process.env.STRIPE_SECRET_KEY = secrets.apiKey;
    process.env.STRIPE_WEBHOOK_SECRET = secrets.webhookSecret;
    process.env.MONEYINV_STRIPE_API_BASE = twin.baseUrl;
  } else {
    process.env.RAZORPAY_KEY_ID = (secrets as any).apiKeyId;
    process.env.RAZORPAY_KEY_SECRET = secrets.apiKey;
    process.env.RAZORPAY_WEBHOOK_SECRET = secrets.webhookSecret;
    process.env.MONEYINV_RAZORPAY_API_BASE = twin.baseUrl;
  }
  let server: import("node:http").Server;
  let stopApp: () => Promise<void>;
  if (appKind === "inline") {
    const app = await import("../../inline-marketplace/src/server.ts");
    await app.migrate();
    server = app.server;
    stopApp = () => app.stop();
  } else {
    const { createPool, migrate } = await import("../../worker-marketplace/src/db.ts");
    const { createApp } = await import("../../worker-marketplace/src/server.ts");
    const { providerFromEnv } = await import("../../worker-marketplace/src/provider.ts");
    const pool = createPool(url);
    await migrate(pool);
    const app = createApp(pool, providerFromEnv());
    await app.start();
    server = app.server;
    stopApp = async () => {
      await app.stop();
      await pool.end();
    };
  }
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const db = new pg.Pool({ connectionString: url, max: 4 });
  db.on("error", () => {});
  pg.types.setTypeParser(20, (v: string) => BigInt(v));

  const webhookPath = `/webhooks/${provider}`;
  const delivered = new Set<string>();
  const sibs = (ev: WorldEvent): readonly string[] =>
    dialect.siblings ? dialect.siblings(ev, 2, new Set()) : dialect.encodeEvent(ev, secrets, 1) ? ["x"] : [];
  let logical = 0;
  const wire = (id: string) => dialect.toWireId(id);

  const h: Harness = {
    appKind,
    provider,
    twin,
    base,
    db,
    wire,
    async post(path, body = {}, headers = {}) {
      const r = await fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: Record<string, any> = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
      return { status: r.status, body: parsed };
    },
    async newOrder(amounts, opts = {}) {
      const sellers = opts.sellers ?? amounts.map((_a, i) => (i % 2 === 0 ? "seller_a" : "seller_b"));
      const r = await h.post("/orders", {
        buyer: "buyer_1",
        currency: "INR",
        capture: opts.capture ?? "automatic",
        lines: amounts.map((a, i) => ({ seller_id: sellers[i], amount: a })),
      });
      expect(r.status).toBe(201);
      return { id: String(r.body.id), lines: r.body.lines as string[], total: BigInt(r.body.total) };
    },
    checkout: (orderId) => h.post(`/orders/${orderId}/checkout`),
    paymentOf(orderId) {
      const hits = [...twin.world.payments.values()].filter((p) => Object.values(p.metadata).includes(orderId));
      if (hits.length !== 1) throw new Error(`expected exactly one provider payment for ${orderId}, saw ${hits.length}`);
      return hits[0]!;
    },
    async oracle() {
      const live = "('pending','succeeded','requires_action')";
      return assertFinancialCorrectness({
        dbUrl: url,
        twin,
        orderOfPayment: (id: string) => twin.world.payments.get(id)?.metadata.order_id,
        bindings: [
          { relation: "orders", sql: "SELECT id AS order_id, currency, total AS amount_due, status FROM orders" },
          { relation: "order_lines", sql: "SELECT id AS line_id, order_id AS order_ref, seller_id AS seller_ref, currency, amount FROM order_lines" },
          { relation: "refunds", sql: "SELECT id AS refund_id, order_id AS order_ref, line_id AS line_ref, provider_ref, currency, amount, status, origin FROM refunds" },
          { relation: "ledger_entries", sql: "SELECT id AS entry_id, txn_id, account, currency, amount, cause_ref, kind, effect_ref FROM ledger_entries" },
        ],
        invariants: ([
          { id: "ledger.txn-balanced", title: "every ledger transaction balances per currency", when: "always", conservation: { relation: "ledger_entries", amount: "amount", per: ["txn_id", "currency"] } },
          { id: "refund.line-bounded", title: "live refunds on a line never exceed the line", when: "always", bound: { lhs: { sum: "refunds.amount", per: "refunds.line_ref", where: `line_ref IS NOT NULL AND status IN ${live}`, currency: "currency" }, op: "<=", rhs: { column: "order_lines.amount", key: "order_lines.line_id" } } },
          { id: "recon.refunds-agree", title: "provider refunds and app refunds agree", when: "always", correspond: { left: { relation: "refunds", key: "provider_ref", amount: "amount", currency: "currency" }, right: { relation: "world.refunds", key: "refund_ref", amount: "amount", currency: "currency" }, require: "both_ways", compare: "amount" } },
          { id: "order.paid-iff-captured", title: "order paid iff the provider captured", when: "always", sql: "SELECT o.order_id FROM app_orders o JOIN world_payments w ON w.order_ref = o.order_id WHERE (w.amount_captured = 0 OR w.amount_captured >= o.amount_due) AND (o.status IN ('paid','partially_refunded','refunded')) <> (w.amount_captured >= o.amount_due)", magnitude: "SELECT 0" },
        ] as any[]).map((d) => compileInvariant(d)),
      });
    },
    forget(ev) {
      for (let s = 0; s < 4; s++) delivered.add(`${ev.id}#${s}`);
    },
    eventsFor(paymentId) {
      return twin.world.events.filter((e) => e.objectId === paymentId || e.payment?.id === paymentId || e.refund?.paymentId === paymentId);
    },
    async deliver(ev, o = {}) {
      const sibling = o.sibling ?? 0;
      const type = sibs(ev)[sibling];
      if (type === undefined) return -1; // provider sends no webhook for this event
      const toSend = o.fresh ? { ...ev, id: `${ev.id}_dup${++logical}` } : ev;
      const enc = dialect.encodeEvent(toSend, secrets, Math.floor(Date.now() / 1000) + ++logical * 0, {
        sibling,
        type,
        fidelity: 2,
        ...(o.signature ? { signature: o.signature } : {}),
        ...(ev.at !== undefined ? { createdSec: ev.at } : {}),
      });
      if (!enc) return -1;
      const res = await fetch(base + webhookPath, { method: "POST", headers: { "content-type": "application/json", ...enc.headers }, body: enc.body });
      await res.text();
      if (res.status >= 200 && res.status < 300 && !o.fresh && !o.signature) delivered.add(`${ev.id}#${sibling}`);
      return res.status;
    },
    async deliverPending(opts = {}) {
      const out: number[] = [];
      for (const ev of [...twin.world.events]) {
        for (let s = 0; s < sibs(ev).length; s++) {
          if (delivered.has(`${ev.id}#${s}`)) continue;
          if (opts.skip?.(ev, s)) continue;
          out.push(await h.deliver(ev, { sibling: s }));
        }
      }
      return out;
    },
    async drain(timeoutMs = 20000 as number) {
      if (appKind !== "worker") return;
      const t0 = Date.now();
      for (;;) {
        const n = (await db.query("SELECT count(*)::int c FROM jobs WHERE state IN ('queued','running')")).rows[0].c;
        if (n === 0) return;
        if (Date.now() - t0 > timeoutMs) throw new Error(`jobs did not drain: ${n} left`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    async pay(orderId) {
      const p = h.paymentOf(orderId);
      const r = twin.world.apply({ kind: "customerPays", paymentId: p.id, outcome: "success" });
      expect(r.ok).toBe(true);
      await h.deliverPending();
      await h.drain();
      return p;
    },
    async paidOrder(amounts, opts = {}) {
      const o = await h.newOrder(amounts, opts);
      const c = await h.checkout(o.id);
      expect(c.status).toBe(200);
      const pay = await h.pay(o.id);
      return { ...o, pay };
    },
    refund: (orderId, line, amount) => h.post(`/orders/${orderId}/refunds`, { line_id: line, amount: Number(amount) }),
    async appRefunds(orderId) {
      return (await db.query("SELECT * FROM refunds WHERE order_id=$1 ORDER BY created_at, id", [orderId])).rows;
    },
    async orderRow(orderId) {
      const r = (await db.query("SELECT * FROM orders WHERE id=$1", [orderId])).rows[0];
      return { ...r, payRef: r.payment_intent_id ?? r.payment_ref };
    },
    async ledgerFor(causes) {
      if (!causes.length) return [];
      return (await db.query("SELECT * FROM ledger_entries WHERE cause_ref = ANY($1) ORDER BY id", [causes])).rows;
    },
    async assertGlobalLedger() {
      const bad = await db.query("SELECT txn_id, currency, sum(amount)::text s FROM ledger_entries GROUP BY 1,2 HAVING sum(amount) <> 0");
      expect(bad.rows, "every ledger transaction balances per currency").toEqual([]);
      const dup = await db.query(
        "SELECT cause_ref, effect_ref, account, count(*)::int c FROM ledger_entries WHERE effect_ref IS NOT NULL GROUP BY 1,2,3 HAVING count(*) > 1",
      );
      expect(dup.rows, "no posting slot realised twice").toEqual([]);
    },
    async assertBooksAgree(orderId) {
      const o = await h.orderRow(orderId);
      const total = BigInt(o.total);
      const lines = (await db.query("SELECT * FROM order_lines WHERE order_id=$1", [orderId])).rows;
      const pays = [...twin.world.payments.values()].filter((p) => Object.values(p.metadata).includes(orderId));
      const refs = await h.appRefunds(orderId);
      if (pays.length === 0) {
        expect(["pending_payment", "capture_pending"]).toContain(o.status);
        return;
      }
      expect(pays.length, "one provider payment per order").toBe(1);
      const p = pays[0]!;
      const captured = p.amountCaptured;
      // order.paid-iff-captured
      const paidStatuses = ["paid", "partially_refunded", "refunded"];
      if (captured > 0n) {
        expect(paidStatuses, `order ${o.status} but provider captured ${captured}`).toContain(o.status);
        expect(captured).toBe(total);
        expect(o.payRef).toBe(wire(p.id));
      } else expect(paidStatuses, "unpaid at provider but paid in app").not.toContain(o.status);
      // recon.refunds-agree and recon.refund-outcome-agrees
      const worldRefs = [...twin.world.refunds.values()].filter((r) => r.paymentId === p.id);
      for (const wr of worldRefs) {
        const row = refs.find((x) => x.provider_ref === wire(wr.id));
        expect(row, `provider refund ${wr.id} unknown to app`).toBeTruthy();
        expect(BigInt(row.amount)).toBe(wr.amount);
        expect(row.status).toBe(wr.status);
      }
      for (const row of refs) expect(worldRefs.some((wr) => wire(wr.id) === row.provider_ref), `app refund ${row.provider_ref} not at provider`).toBe(true);
      // refund bounds
      const live = (rs: any[]) => rs.filter((r) => LIVE.has(r.status)).reduce((s, r) => s + BigInt(r.amount), 0n);
      expect(live(refs) <= captured).toBe(true);
      for (const l of lines) expect(live(refs.filter((r) => r.line_id === l.id)) <= BigInt(l.amount), `line ${l.id} over-refunded`).toBe(true);
      // order status label
      if (captured > 0n) {
        const liveAmt = live(refs);
        expect(o.status).toBe(liveAmt === 0n ? "paid" : liveAmt >= total ? "refunded" : "partially_refunded");
      }
      // ledger: clearing mirrors the provider; every cause's postings sum to zero
      const causes = [wire(p.id), ...worldRefs.map((r) => wire(r.id))];
      const entries = await h.ledgerFor(causes);
      const clearing = entries.filter((e) => e.account === "provider:clearing").reduce((s, e) => s + BigInt(e.amount), 0n);
      expect(clearing, "clearing account mirrors provider money").toBe(captured - live(worldRefs as any));
      expect(entries.reduce((s, e) => s + BigInt(e.amount), 0n)).toBe(0n);
      expect(entries.filter((e) => e.kind === "sale" && e.account === "provider:clearing").length).toBeLessThanOrEqual(1);
    },
    async stop() {
      await db.end();
      await stopApp();
      await twin.stop();
      const a = new pg.Client({ connectionString: ADMIN });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
      await a.end();
    },
  } as Harness;
  return h;
}
