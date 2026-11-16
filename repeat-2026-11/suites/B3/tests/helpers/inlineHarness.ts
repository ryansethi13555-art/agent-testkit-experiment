// Glue for the inline-marketplace suites: a PaymentProvider backed by the shared World, a throwaway database,
// and the money-law checker run against stored state and the world's true state.
import type { AddressInfo } from "node:net";
import pg from "pg";
import { expect } from "vitest";
import { FakeError, http, holdsMoney, refCommission, signedEvent, type World } from "./world.ts";

export const ADMIN = process.env.MI_PG_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
export const WHSEC = "whsec_b3_inline";

type G = { __B3_PROVIDER?: unknown; __B3_REAL?: unknown };
export const g = globalThis as unknown as G;

/** Build the app's PaymentProvider over a World. Webhook parsing uses the app's own real Stripe adapter. */
export function inlineProvider(world: World, real: { parseWebhook: (raw: string, h: Record<string, unknown>) => Promise<unknown> }) {
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof FakeError) {
        const err = new Error(e.message) as Error & { fake: FakeError; definitiveRefundReason?: string | undefined };
        err.fake = e;
        err.definitiveRefundReason = e.definitive;
        throw err;
      }
      throw e;
    }
  };
  const pay = (p: Awaited<ReturnType<World["retrievePayment"]>>) => ({
    ref: p.ref,
    status: p.status,
    amount: p.amount,
    amountReceived: p.captured,
    currency: p.currency,
    orderId: p.orderId,
    clientSecret: `${p.ref}_secret`,
  });
  const ref = (r: Awaited<ReturnType<World["retrieveRefund"]>>) => ({
    ref: r.ref,
    requestId: r.metadata.refund_id,
    paymentRef: r.paymentRef,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
  });
  const provider = {
    name: "stripe",
    refundRequestError: undefined as undefined | ((a: bigint, c: string) => string | undefined),
    createPayment: (p: Parameters<World["createPayment"]>[0]) => wrap(async () => pay(await world.createPayment(p))),
    retrievePayment: (r: string) => wrap(async () => pay(await world.retrievePayment(r))),
    retrieveRefund: (r: string) => wrap(async () => ref(await world.retrieveRefund(r))),
    capture: (r: string, p: { amount: bigint; idempotencyKey: string }) => wrap(async () => pay(await world.capture(r, p))),
    cancel: async () => {},
    refundTarget: async (r: string) => r,
    refund: (r: string, p: { amount: bigint; idempotencyKey: string; metadata: Record<string, string> }) =>
      wrap(async () => ref(await world.createRefund(r, p))),
    parseWebhook: (raw: string, headers: Record<string, unknown>) => real.parseWebhook(raw, headers),
    isProviderError: (e: unknown) => (e as { fake?: unknown })?.fake !== undefined,
    definitiveRefundRejection: (e: unknown) => (e as { definitiveRefundReason?: string })?.definitiveRefundReason,
  };
  return provider;
}

export async function createDb(name: string): Promise<string> {
  const db = name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${db}`);
  await c.end();
  return ADMIN.replace(/\/[^/]*$/, `/${db}`);
}
export async function dropDb(name: string): Promise<void> {
  const db = name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await c.end();
}

export interface Ctx {
  base: string;
  db: pg.Client;
  world: World;
  app: typeof import("../../inline-marketplace/src/server.ts");
  /** Redeliveries owed: events whose last answer was not 200. */
  pending: ReturnType<typeof signedEvent>[];
}

export function api(ctx: Pick<Ctx, "base">) {
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) => http(ctx.base, "POST", path, body, headers);
  return {
    post,
    order: async (lines: (number | string)[], opts: { currency?: string; capture?: string; buyer?: string } = {}) => {
      const r = await post("/orders", {
        buyer: "b",
        currency: opts.currency ?? "INR",
        capture: opts.capture ?? "automatic",
        lines: lines.map((a, i) => ({ seller_id: i % 2 === 0 ? "seller_a" : "seller_b", amount: a })),
      });
      expect(r.status).toBe(201);
      return { id: String(r.body.id), lines: r.body.lines as string[], total: BigInt(String(r.body.total)) };
    },
    checkout: async (id: string) => post(`/orders/${id}/checkout`, {}),
    refund: (orderId: string, lineId: string, amount: number | string) =>
      post(`/orders/${orderId}/refunds`, { line_id: lineId, amount }),
  };
}

export const big = (v: unknown) => BigInt(String(v));

/**
 * Money laws over stored state vs the world's true state. Call only when the system is settled
 * (all deliveries drained, recoveries run). `strictRecon` additionally requires every world refund recorded.
 */
export async function assertBooks(ctx: Ctx, opts: { strictRecon?: boolean } = {}): Promise<void> {
  const { db, world } = ctx;
  const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;
  // ledger.txn-balanced (per txn and currency)
  expect(await q("SELECT txn_id, currency FROM ledger_entries GROUP BY 1,2 HAVING sum(amount)<>0")).toEqual([]);
  // effect.once: no posting slot realised twice (cause, effect, account)
  expect(await q("SELECT cause_ref, effect_ref, account FROM ledger_entries GROUP BY 1,2,3 HAVING count(*)>1")).toEqual([]);
  const orders = await q("SELECT * FROM orders");
  let expectedClearing = 0n;
  for (const o of orders) {
    const total = big(o.total);
    const payments = [...world.payments.values()].filter((p) => p.orderId === o.id);
    // intent.order-collection-bounded: provider never keeps more than the order is due
    expect(payments.reduce((s, p) => s + p.captured, 0n) <= total).toBe(true);
    expect(payments.length <= 1).toBe(true);
    const captured = payments.reduce((s, p) => s + p.captured, 0n);
    const appRefunds = await q("SELECT * FROM refunds WHERE order_id=$1", [o.id]);
    const lines = await q("SELECT * FROM order_lines WHERE order_id=$1", [o.id]);
    // order.paid-iff-captured
    const paidStatuses = ["paid", "partially_refunded", "refunded"];
    if (captured === 0n) expect(paidStatuses).not.toContain(o.status);
    else expect(paidStatuses).toContain(o.status);
    // refund.line-bounded and order-bounded
    for (const l of lines) {
      const live = appRefunds.filter((r) => r.line_id === l.id && !["failed", "canceled"].includes(r.status)).reduce((s, r) => s + big(r.amount), 0n);
      expect(live <= big(l.amount)).toBe(true);
    }
    const liveAll = appRefunds.filter((r) => !["failed", "canceled"].includes(r.status)).reduce((s, r) => s + big(r.amount), 0n);
    expect(liveAll <= total).toBe(true);
    // sale postings: each seller gets amount - commission, platform gets commission, exactly once, only once captured
    const sales = await q("SELECT * FROM ledger_entries WHERE kind='sale' AND account='provider:clearing' AND cause_ref=$1", [o.payment_intent_id ?? "none"]);
    if (captured === total && paidStatuses.includes(o.status)) {
      expect(sales.length).toBe(1);
      expect(big(sales[0].amount)).toBe(total);
      for (const l of lines) {
        const fee = refCommission(big(l.amount));
        const seller = await q("SELECT amount FROM ledger_entries WHERE effect_ref=$1 AND kind='sale' AND account=$2", [`allocation:${l.id}`, `seller:${l.seller_id}`]);
        const platform = await q("SELECT amount FROM ledger_entries WHERE effect_ref=$1 AND kind='commission'", [`allocation:${l.id}`]);
        expect(seller.map((r) => big(r.amount))).toEqual([-(big(l.amount) - fee)]);
        expect(platform.map((r) => big(r.amount))).toEqual([-fee]);
      }
      expectedClearing += total;
    } else {
      expect(sales.length).toBe(0);
    }
    // recon.refunds-agree and recon.refund-outcome-agrees (against the world), for this order's payment
    const worldRefunds = payments.flatMap((p) => [...world.refunds.values()].filter((r) => r.paymentRef === p.ref));
    for (const wr of worldRefunds) {
      const mine = appRefunds.filter((r) => r.provider_ref === wr.ref);
      if (opts.strictRecon !== false || holdsMoney(wr.status)) {
        expect(mine.length).toBe(1);
        expect(big(mine[0].amount)).toBe(wr.amount);
        expect(mine[0].status).toBe(wr.status);
        if (mine[0].line_id) {
          const ln = lines.find((l) => l.id === mine[0].line_id);
          const accts = (await q("SELECT DISTINCT account FROM ledger_entries WHERE cause_ref=$1 AND account<>'provider:clearing'", [wr.ref])).map((r) => r.account);
          expect(accts.every((x) => x === `seller:${ln?.seller_id}`)).toBe(true);
        }
        // refund ledger: recognised once while held, nets to zero once failed/canceled
        const legs = await q("SELECT sum(amount) FILTER (WHERE account='provider:clearing') AS clr FROM ledger_entries WHERE cause_ref=$1 AND kind IN ('refund','refund_reversal')", [wr.ref]);
        expect(big(legs[0].clr ?? 0)).toBe(holdsMoney(wr.status) ? -wr.amount : 0n);
        if (holdsMoney(wr.status)) expectedClearing -= wr.amount;
      }
    }
    for (const ar of appRefunds) expect(world.refunds.has(ar.provider_ref)).toBe(true);
  }
  // ledger.clearing-mirrors-provider (aggregate)
  const clearing = big((await q("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE account='provider:clearing'"))[0].s);
  expect(clearing).toBe(expectedClearing);
}

export async function pgUp(): Promise<boolean> {
  const c = new pg.Client({ connectionString: ADMIN });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}
export const portOf = (s: { address(): unknown }) => (s.address() as AddressInfo).port;

import { vi } from "vitest";
import { World as W2 } from "./world.ts";

/** Start the app on its own database. The test file must have vi.mock'ed the app's provider module. */
export async function startInline(name: string): Promise<Ctx> {
  const url = await createDb(name);
  process.env.DATABASE_URL = url;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }); // the 500ms recovery scan must not race schedules
  const app = await import("../../inline-marketplace/src/server.ts");
  await app.migrate();
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  return { base: `http://127.0.0.1:${portOf(app.server)}`, db, world: new W2(), app, pending: [] };
}
export async function stopInline(ctx: Ctx, name: string): Promise<void> {
  await ctx.db.end();
  await ctx.app.stop();
  await dropDb(name);
}
export async function resetInline(ctx: Ctx): Promise<void> {
  await ctx.db.query("TRUNCATE orders, order_lines, refunds, refund_requests, ledger_entries, processed_events CASCADE");
  ctx.world = new W2();
  ctx.pending = [];
  g.__B3_PROVIDER = inlineProvider(ctx.world, g.__B3_REAL as never);
}

export const ev = {
  pi: (ctx: Ctx, type: string, ref: string, id?: string) => signedEvent(WHSEC, type, ctx.world.piJson(ref), id),
  refund: (ctx: Ctx, type: string, ref: string, id?: string) => signedEvent(WHSEC, type, ctx.world.refundJson(ref), id),
};
export async function send(ctx: Ctx, e: { payload: string; headers: Record<string, string> }) {
  return http(ctx.base, "POST", "/webhooks/stripe", e.payload, e.headers);
}
/** Deliver once; a non-200 answer means the provider will retry later (remembered in ctx.pending). */
export async function deliver(ctx: Ctx, e: ReturnType<typeof signedEvent>) {
  const r = await send(ctx, e);
  if (r.status !== 200) ctx.pending.push(e);
  return r;
}
/** Let the world settle: redeliver unacknowledged events and run the refund recovery scan until quiet. */
export async function settle(ctx: Ctx): Promise<void> {
  for (let round = 0; round < 12; round++) {
    const todo = ctx.pending.splice(0);
    for (const e of todo) await deliver(ctx, e);
    await ctx.db.query("UPDATE refund_requests SET next_attempt_at = now() WHERE NOT resolved");
    await ctx.app.recoverPendingRefunds();
    if (!ctx.pending.length && round > 0) return;
  }
  expect(ctx.pending.map((p) => p.id)).toEqual([]);
}
