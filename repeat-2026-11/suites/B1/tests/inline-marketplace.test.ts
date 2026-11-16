// Money-correctness suite for inline-marketplace (Stripe adapter semantics) against an in-memory provider "world".
// The provider world (tests/helpers/world.ts) is the source of truth; assertions compare the app's DB and ledger to it.
import type { AddressInfo } from "node:net";
import fc from "fast-check";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, dropDb } from "./helpers/db.ts";
import { event, holds, newEventId, piObject, refundObject, sign, type RStatus, World, WorldError, WHSEC } from "./helpers/world.ts";

const PROVIDER_PATH = "../inline-marketplace/src/provider.ts";
vi.mock("../inline-marketplace/src/provider.ts", async (orig) => {
  const a = await orig<Record<string, unknown>>();
  return { ...a, providerFromEnv: () => (globalThis as Record<string, unknown>).__fakeProvider };
});

type Any = any; // eslint-disable-line
const actual = (await vi.importActual(PROVIDER_PATH)) as Any;
const real: Any = actual.providerFromEnv({ PAYMENT_PROVIDER: "stripe", STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_SECRET_KEY: "sk_test_x" });
const rzpReal: Any = actual.providerFromEnv({ PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: "k", RAZORPAY_KEY_SECRET: "s", RAZORPAY_WEBHOOK_SECRET: "w" });

const world = new World();
const toErr = (e: unknown): never => {
  if (e instanceof WorldError) {
    const type = e.kind === "network" ? "StripeConnectionError" : e.status === 429 ? "StripeRateLimitError" : e.status === 400 || e.status === 404 ? "StripeInvalidRequestError" : "StripeAPIError";
    throw Object.assign(new Error(e.message), { type, statusCode: e.status, code: e.code });
  }
  throw e;
};
const payOf = (p: Any): Any => ({
  ref: p.id,
  status: p.status === "succeeded" ? "succeeded" : p.status === "requires_capture" ? "requires_capture" : p.status === "canceled" ? "canceled" : "pending",
  amount: p.amount,
  amountReceived: p.received,
  currency: p.currency,
  orderId: p.orderId,
  clientSecret: `${p.id}_secret`,
});
const refOf = (r: Any): Any => ({ ref: r.id, requestId: r.metadata?.refund_id, paymentRef: r.paymentRef, amount: r.amount, currency: r.currency, status: r.status });
const fake: Any = {
  name: "stripe",
  tamperRefund: undefined as undefined | ((r: Any) => Any),
  refundRequestError: undefined as Any,
  async createPayment(p: Any) { try { return payOf(await world.createPayment(p)); } catch (e) { return toErr(e); } },
  async retrievePayment(ref: string) { try { return payOf(await world.retrievePayment(ref)); } catch (e) { return toErr(e); } },
  async retrieveRefund(ref: string) { try { return refOf(await world.retrieveRefund(ref)); } catch (e) { return toErr(e); } },
  async capture(ref: string, p: Any) { try { return payOf(await world.capture(ref, p.idempotencyKey)); } catch (e) { return toErr(e); } },
  async cancel() {},
  async refundTarget(ref: string) { return ref; },
  async refund(ref: string, p: Any) {
    try {
      const r = refOf(await world.createRefund(ref, { amount: p.amount, key: p.idempotencyKey, metadata: p.metadata }));
      return fake.tamperRefund ? fake.tamperRefund(r) : r;
    } catch (e) { return toErr(e); }
  },
  parseWebhook: (raw: string, h: Any) => real.parseWebhook(raw, h),
  isProviderError: (e: unknown) => real.isProviderError(e),
  definitiveRefundRejection: (e: unknown) => real.definitiveRefundRejection(e),
};
(globalThis as Record<string, unknown>).__fakeProvider = fake;

const { url: DBURL, name: DBNAME } = await createDb("inline");
let app: Any;
let base = "";
let db: pg.Client;

beforeAll(async () => {
  process.env.DATABASE_URL = DBURL;
  app = await import("../inline-marketplace/src/server.ts");
  await app.migrate();
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  db = new pg.Client({ connectionString: DBURL });
  await db.connect();
});
afterAll(async () => {
  await db?.end();
  await app?.stop();
  await dropDb(DBNAME);
});
beforeEach(async () => {
  world.reset();
  fake.tamperRefund = undefined;
  fake.refundRequestError = undefined;
  await db.query("TRUNCATE orders, order_lines, refunds, refund_requests, ledger_entries, processed_events CASCADE");
});

async function post(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Any };
}
async function deliver(type: string, object: unknown, id?: string) {
  const s = sign(event(type, object, id));
  return post("/webhooks/stripe", s.payload, { "stripe-signature": s.header });
}
const piEvent = (type: string, ref: string, id?: string) => deliver(type, piObject(world.payment(ref)), id);
const rfEvent = (type: string, ref: string, id?: string, status?: RStatus) => {
  const r = world.refunds.get(ref) as Any;
  return deliver(type, refundObject(r, status), id);
};
async function mk(lines: [string, number][], o: { currency?: string; capture?: string } = {}) {
  const r = await post("/orders", { buyer: "b", currency: o.currency ?? "INR", capture: o.capture ?? "automatic", lines: lines.map(([s, a]) => ({ seller_id: s, amount: a })) });
  expect(r.status).toBe(201);
  return r.body as { id: string; total: string; lines: string[] };
}
async function paid(lines: [string, number][] = [["seller_a", 1000], ["seller_b", 500]], o: { currency?: string } = {}) {
  const order = await mk(lines, o);
  const co = await post(`/orders/${order.id}/checkout`);
  expect(co.status).toBe(200);
  const ref = String(co.body.payment_intent_id);
  world.customerPays(ref);
  expect((await piEvent("payment_intent.succeeded", ref)).status).toBe(200);
  return { order, ref };
}
const refund = (orderId: string, lineId: string, amount: unknown) => post(`/orders/${orderId}/refunds`, { line_id: lineId, amount });
const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as Any[];
const bal = async (account: string) => BigInt((await q("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE account=$1", [account]))[0].s);
const orderStatus = async (id: string) => (await q("SELECT status FROM orders WHERE id=$1", [id]))[0]?.status;
const saleRows = async () => Number((await q("SELECT count(*)::int c FROM ledger_entries WHERE kind IN ('sale','commission')"))[0].c);
const worldRefundTotal = (ref: string) => world.heldOn(ref);
const expedite = () => db.query("UPDATE refund_requests SET next_attempt_at = now() - interval '1 second'");

/** Money laws, checked against the provider world's true state. */
async function invariants(opts: { settled?: boolean } = {}) {
  const settled = opts.settled ?? true;
  expect(await q("SELECT txn_id FROM ledger_entries GROUP BY txn_id, currency HAVING sum(amount)<>0")).toEqual([]);
  expect(await q("SELECT cause_ref, effect_ref, account FROM ledger_entries WHERE kind IN ('sale','commission','refund') GROUP BY 1,2,3 HAVING count(*)>1")).toEqual([]);
  expect(await q("SELECT cause_ref FROM ledger_entries WHERE kind='refund_reversal' GROUP BY cause_ref, account HAVING count(*)>1")).toEqual([]);
  // refund.line-bounded and order bound, on refunds that still hold money
  expect(await q("SELECT l.id FROM order_lines l JOIN refunds r ON r.line_id=l.id WHERE r.status NOT IN ('failed','canceled') GROUP BY l.id, l.amount HAVING sum(r.amount) > l.amount")).toEqual([]);
  expect(await q("SELECT o.id FROM orders o JOIN refunds r ON r.order_id=o.id WHERE r.status NOT IN ('failed','canceled') GROUP BY o.id, o.total HAVING sum(r.amount) > o.total")).toEqual([]);
  // every recorded refund's ledger effect matches its status
  for (const r of await q("SELECT * FROM refunds")) {
    const net = BigInt((await q("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE cause_ref=$1 AND account='provider:clearing'", [r.provider_ref]))[0].s);
    const wanted = holds(r.status) && r.booked ? -BigInt(r.amount) : 0n;
    if (settled) expect(net, `refund ${r.provider_ref} (${r.status}) clearing effect`).toBe(wanted);
    if (!holds(r.status))
      expect(BigInt((await q("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE cause_ref=$1", [r.provider_ref]))[0].s)).toBe(0n);
  }
  // ledger vs provider truth
  let clearing = 0n;
  for (const o of await q("SELECT * FROM orders")) {
    const sale = BigInt((await q("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE kind='sale' AND account='provider:clearing' AND cause_ref=$1", [o.payment_intent_id ?? ""]))[0].s);
    const p = o.payment_intent_id ? world.payments.get(o.payment_intent_id) : undefined;
    const captured = p?.status === "succeeded" && p.received === BigInt(o.total);
    if (settled) {
      expect(["paid", "partially_refunded", "refunded"].includes(o.status), `order ${o.id} paid-iff-captured`).toBe(Boolean(captured));
      expect(sale).toBe(captured ? BigInt(o.total) : 0n);
    }
    if (captured && p) {
      clearing += p.received;
      for (const r of world.refunds.values()) if (r.paymentRef === p.id && holds(r.status)) clearing -= r.amount;
    }
  }
  if (settled) expect(await bal("provider:clearing")).toBe(clearing);
  // recon.refunds-agree and outcome agree
  if (settled) {
    const appRefunds = new Map((await q("SELECT * FROM refunds")).map((r) => [r.provider_ref, r]));
    const known = new Set((await q("SELECT payment_intent_id FROM orders")).map((o) => o.payment_intent_id));
    for (const r of world.refunds.values()) {
      if (!known.has(r.paymentRef)) continue;
      const a = appRefunds.get(r.id);
      expect(a, `provider refund ${r.id} recorded`).toBeTruthy();
      expect(BigInt(a.amount)).toBe(r.amount);
      expect(a.status).toBe(r.status);
    }
    for (const ref of appRefunds.keys()) expect(world.refunds.has(ref)).toBe(true);
  }
}

describe("inline: order input and sale posting", () => {
  it("rejects malformed money without creating rows", async () => {
    for (const amount of [0, -5, 10.5, "1e3", "12.5", "abc", null, 2 ** 53, "9007199254740993", " 5", "-1"]) {
      const r = await post("/orders", { lines: [{ seller_id: "seller_a", amount }] });
      expect(r.status, JSON.stringify(amount)).toBe(400);
    }
    expect((await post("/orders", { lines: [] })).status).toBe(400);
    expect((await post("/orders", { currency: "RS", lines: [{ seller_id: "seller_a", amount: 5 }] })).status).toBe(400);
    expect((await post("/orders", { lines: [{ seller_id: "seller_a", amount: 9007199254740991 }, { seller_id: "seller_b", amount: 5 }] })).status).toBe(400);
    expect(await q("SELECT 1 FROM orders")).toEqual([]);
  });

  it("posts a balanced sale with half-even commission remainders, per line", async () => {
    const { order } = await paid([["seller_a", 5], ["seller_b", 15], ["seller_a", 25], ["seller_b", 1], ["seller_a", 3]]);
    // 10%: 0.5->0, 1.5->2, 2.5->2, 0.1->0, 0.3->0
    const fees = await q("SELECT effect_ref, -amount::int AS fee FROM ledger_entries WHERE kind='commission' ORDER BY effect_ref");
    const byLine = Object.fromEntries(fees.map((f) => [f.effect_ref, f.fee]));
    expect(byLine).toEqual({ [`allocation:${order.id}_l1`]: 0, [`allocation:${order.id}_l2`]: 2, [`allocation:${order.id}_l3`]: 2, [`allocation:${order.id}_l4`]: 0, [`allocation:${order.id}_l5`]: 0 });
    expect(await bal("provider:clearing")).toBe(49n);
    expect(await bal("seller:seller_a")).toBe(-(5n + 23n + 3n));
    await invariants();
  });

  it("books zero-decimal currency in its own currency", async () => {
    const { order, ref } = await paid([["seller_a", 999], ["seller_b", 1]], { currency: "JPY" });
    expect((await q("SELECT DISTINCT currency FROM ledger_entries")).map((r) => r.currency)).toEqual(["JPY"]);
    const r = await refund(order.id, `${order.id}_l1`, 999);
    expect(r.status).toBe(200);
    expect(world.heldOn(ref)).toBe(999n);
    await invariants();
  });

  it("property: random orders always post balanced sales whose parts sum to the whole", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 100000 }), { minLength: 1, maxLength: 6 }), async (amts) => {
        world.reset();
        await db.query("TRUNCATE orders, order_lines, refunds, refund_requests, ledger_entries, processed_events CASCADE");
        const { order } = await paid(amts.map((a, i) => [i % 2 ? "seller_b" : "seller_a", a] as [string, number]));
        const total = amts.reduce((s, a) => s + a, 0);
        expect(await bal("provider:clearing")).toBe(BigInt(total));
        const platform = await q("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE account LIKE 'platform:%'");
        const sellers = (await bal("seller:seller_a")) + (await bal("seller:seller_b"));
        expect(BigInt(platform[0].s) + sellers).toBe(-BigInt(total));
        for (const [i, a] of amts.entries()) {
          const fee = Number((await q("SELECT -amount::int f FROM ledger_entries WHERE effect_ref=$1 AND kind='commission'", [`allocation:${order.id}_l${i + 1}`]))[0].f);
          expect(Math.abs(fee * 10 - a)).toBeLessThanOrEqual(5); // within half a minor unit of 10%
        }
        await invariants();
      }),
      { numRuns: 12 },
    );
  });
});

describe("inline: checkout and payment webhooks", () => {
  it("duplicate payment webhook: same id sequential, same id concurrent, fresh id", async () => {
    const order = await mk([["seller_a", 600], ["seller_b", 400]]);
    const ref = String((await post(`/orders/${order.id}/checkout`)).body.payment_intent_id);
    world.customerPays(ref);
    const id = newEventId();
    const res = await Promise.all(Array.from({ length: 6 }, () => piEvent("payment_intent.succeeded", ref, id)));
    for (const r of res) expect(r.status).toBe(200);
    expect(await piEvent("payment_intent.succeeded", ref, id)).toMatchObject({ status: 200 });
    expect(await saleRows()).toBe(1 + 2 * 2 + 0 * 0 - 0 + 0);
    const fresh = await Promise.all([1, 2, 3].map(() => piEvent("payment_intent.succeeded", ref)));
    for (const r of fresh) expect(r.status).toBe(200);
    expect(await saleRows()).toBe(5);
    expect(await orderStatus(order.id)).toBe("paid");
    await invariants();
  });

  it("confirm-return and webhook racing together book the sale once", async () => {
    const order = await mk([["seller_a", 700]]);
    const ref = String((await post(`/orders/${order.id}/checkout`)).body.payment_intent_id);
    world.customerPays(ref);
    await Promise.all([post(`/orders/${order.id}/confirm`), piEvent("payment_intent.succeeded", ref), post(`/orders/${order.id}/confirm`), piEvent("payment_intent.succeeded", ref)]);
    expect(await saleRows()).toBe(3);
    await invariants();
  });

  it("concurrent checkout double-submit creates exactly one provider payment", async () => {
    const order = await mk([["seller_a", 1000]]);
    world.delay.createPayment = 60;
    const rs = await Promise.all(Array.from({ length: 5 }, () => post(`/orders/${order.id}/checkout`)));
    expect(world.payments.size).toBe(1);
    const ref = [...world.payments.keys()][0];
    for (const r of rs) expect(r.status === 200 ? r.body.payment_intent_id : ref).toBe(ref);
    expect(rs.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    const again = await post(`/orders/${order.id}/checkout`);
    expect(again.body.payment_intent_id).toBe(ref);
    expect(world.payments.size).toBe(1);
  });

  it("checkout response lost after the provider applied it: never creates a second payment, even after idempotency expiry", async () => {
    const order = await mk([["seller_a", 1000]]);
    world.failNext({ op: "createPayment", when: "after", status: 500 });
    expect((await post(`/orders/${order.id}/checkout`)).status).toBe(502);
    world.expireIdempotency();
    expect((await post(`/orders/${order.id}/checkout`)).status).toBe(502);
    expect(world.payments.size).toBe(1);
    // the success webhook recovers the identity and books once
    const ref = [...world.payments.keys()][0] as string;
    world.customerPays(ref);
    expect((await piEvent("payment_intent.succeeded", ref)).status).toBe(200);
    expect((await q("SELECT payment_intent_id p FROM orders"))[0].p).toBe(ref);
    expect(await saleRows()).toBe(3);
    await invariants();
  });

  it("a created observation recovers the lost identity without booking money", async () => {
    const order = await mk([["seller_a", 1000]]);
    world.failNext({ op: "createPayment", when: "after" });
    await post(`/orders/${order.id}/checkout`);
    const ref = [...world.payments.keys()][0] as string;
    expect((await piEvent("payment_intent.created", ref)).status).toBe(200);
    expect(await saleRows()).toBe(0);
    expect((await post(`/orders/${order.id}/checkout`)).body.payment_intent_id).toBe(ref);
    expect(world.payments.size).toBe(1);
    await invariants();
  });

  it("rejects forged, tampered, wrong-secret and stale-timestamp webhooks with no effect", async () => {
    const order = await mk([["seller_a", 1000]]);
    const ref = String((await post(`/orders/${order.id}/checkout`)).body.payment_intent_id);
    world.customerPays(ref);
    const ev = event("payment_intent.succeeded", piObject(world.payment(ref)));
    const good = sign(ev);
    const cases: [string, string, string][] = [
      ["no header", good.payload, ""],
      ["garbage header", good.payload, "t=1,v1=deadbeef"],
      ["tampered body", good.payload.replace("1000", "1"), good.header],
      ["wrong secret", sign(ev, { secret: "whsec_other" }).payload, sign(ev, { secret: "whsec_other" }).header],
      ["stale timestamp", good.payload, sign(ev, { timestamp: Math.floor(Date.now() / 1000) - 3600 }).header],
    ];
    for (const [name, payload, header] of cases) {
      const r = await post("/webhooks/stripe", payload, header ? { "stripe-signature": header } : {});
      expect(r.status, name).toBe(400);
    }
    expect(await saleRows()).toBe(0);
    expect(await q("SELECT 1 FROM processed_events")).toEqual([]);
    expect(await orderStatus(order.id)).toBe("pending_payment");
  });

  it("does not mark paid on partial capture, wrong currency, wrong order or an unrelated payment", async () => {
    const order = await mk([["seller_a", 1000]]);
    const ref = String((await post(`/orders/${order.id}/checkout`)).body.payment_intent_id);
    const p = world.payment(ref);
    const bad = [
      { ...piObject({ ...p, status: "succeeded", received: 600n }) },
      { ...piObject({ ...p, status: "succeeded", received: 1000n }), currency: "usd" },
      { ...piObject({ ...p, status: "succeeded", received: 1000n }), metadata: { order_id: "ord_other" } },
      { ...piObject({ ...p, status: "succeeded", received: 1000n }), id: "pi_unrelated" },
      { ...piObject({ ...p, status: "succeeded", received: 1000n }), amount: 999 },
    ];
    for (const obj of bad) {
      const r = await deliver("payment_intent.succeeded", obj);
      expect(r.status, JSON.stringify(obj)).not.toBe(200);
    }
    expect(await saleRows()).toBe(0);
    expect(await orderStatus(order.id)).toBe("pending_payment");
    expect(await q("SELECT 1 FROM processed_events")).toEqual([]); // failed deliveries stay retryable
  });

  it("payment event for an order that does not exist is retryable, not acknowledged", async () => {
    const r = await deliver("payment_intent.succeeded", { ...piObject({ id: "pi_x", orderId: "ord_nope", amount: 5n, currency: "INR", capture: "automatic", status: "succeeded", received: 5n }) });
    expect(r.status).toBe(503);
    expect(await q("SELECT 1 FROM processed_events")).toEqual([]);
  });
});

describe("inline: manual capture", () => {
  const manual = async () => {
    const order = await mk([["seller_a", 600], ["seller_b", 400]], { capture: "manual" });
    const ref = String((await post(`/orders/${order.id}/checkout`)).body.payment_intent_id);
    world.customerPays(ref);
    expect((await piEvent("payment_intent.amount_capturable_updated", ref)).status).toBe(200);
    expect(await saleRows()).toBe(0); // an authorisation is not captured money
    return { order, ref };
  };
  it("capture applied but response lost: parked, then the webhook books once; retry is harmless", async () => {
    const { order, ref } = await manual();
    world.failNext({ op: "capture", when: "after", status: 500 });
    expect((await post(`/orders/${order.id}/capture`)).status).toBe(502);
    expect(await saleRows()).toBe(0);
    expect(["pending_payment", "capture_pending"]).toContain(await orderStatus(order.id));
    expect((await piEvent("payment_intent.succeeded", ref)).status).toBe(200);
    expect(await saleRows()).toBe(5);
    expect((await post(`/orders/${order.id}/capture`)).status).toBe(200);
    expect(await saleRows()).toBe(5);
    expect(world.count("capture")).toBe(2);
    await invariants();
  });
  it("capture lost with no webhook: confirm recovers it exactly once", async () => {
    const { order } = await manual();
    world.failNext({ op: "capture", when: "after" });
    await post(`/orders/${order.id}/capture`);
    expect((await post(`/orders/${order.id}/confirm`)).body.status).toBe("paid");
    await post(`/orders/${order.id}/confirm`);
    expect(await saleRows()).toBe(5);
    await invariants();
  });
  it("capture rejected before applying leaves nothing booked", async () => {
    const { order } = await manual();
    world.failNext({ op: "capture", when: "before", status: 500 });
    expect((await post(`/orders/${order.id}/capture`)).status).toBe(502);
    expect(await saleRows()).toBe(0);
    await invariants();
  });
});

describe("inline: refunds, happy and bounded", () => {
  it("refund credits back the right seller and the clearing account; ledger stays balanced", async () => {
    const { order, ref } = await paid([["seller_a", 600], ["seller_b", 400]]);
    const r = await refund(order.id, `${order.id}_l2`, 150);
    expect(r.status).toBe(200);
    expect(await bal("seller:seller_b")).toBe(-360n + 150n);
    expect(await bal("seller:seller_a")).toBe(-540n);
    expect(await bal("provider:clearing")).toBe(1000n - 150n);
    expect(await orderStatus(order.id)).toBe("partially_refunded");
    expect(worldRefundTotal(ref)).toBe(150n);
    await invariants();
  });
  it("sequential partial refunds can reach but never pass the line or the order", async () => {
    const { order, ref } = await paid([["seller_a", 700], ["seller_b", 301]]);
    const l1 = `${order.id}_l1`;
    for (const a of [200, 200, 300]) expect((await refund(order.id, l1, a)).status).toBe(200);
    expect((await refund(order.id, l1, 1)).status).toBe(400); // 700 refunded: line exhausted
    expect((await refund(order.id, l1, 2)).status).toBe(400);
    expect((await refund(order.id, `${order.id}_l2`, 302)).status).toBe(400);
    expect((await refund(order.id, `${order.id}_l2`, 301)).status).toBe(200);
    expect(await orderStatus(order.id)).toBe("refunded");
    expect(worldRefundTotal(ref)).toBe(1001n);
    expect((await refund(order.id, l1, 1)).status).toBe(409);
    await invariants();
  });
  it("rejects bad refund inputs and lines that belong to another order or do not exist", async () => {
    const a = await paid([["seller_a", 500]]);
    const b = await paid([["seller_b", 500]]);
    for (const amount of [0, -1, 1.5, "x", "1e2", null, 2 ** 60])
      expect((await refund(a.order.id, `${a.order.id}_l1`, amount)).status, JSON.stringify(amount)).toBe(400);
    expect((await refund(a.order.id, `${b.order.id}_l1`, 100)).status).toBe(404);
    expect((await refund(a.order.id, "nope", 100)).status).toBe(404);
    expect(world.count("refund")).toBe(0);
    expect(await q("SELECT 1 FROM refund_requests")).toEqual([]);
    // refunds on a not yet paid order
    const u = await mk([["seller_a", 500]]);
    expect((await refund(u.id, `${u.id}_l1`, 100)).status).toBe(409);
    await invariants();
  });
  it("Razorpay-style INR minimum: below 100 minor units is refused before any reservation or POST", async () => {
    fake.refundRequestError = rzpReal.refundRequestError;
    expect(rzpReal.refundRequestError(99n, "INR")).toBeTruthy();
    expect(rzpReal.refundRequestError(100n, "INR")).toBeUndefined();
    expect(rzpReal.refundRequestError(1n, "USD")).toBeUndefined();
    const { order } = await paid([["seller_a", 1000]]);
    expect((await refund(order.id, `${order.id}_l1`, 99)).status).toBe(400);
    expect(await q("SELECT 1 FROM refund_requests")).toEqual([]);
    expect(world.count("refund")).toBe(0);
    expect((await refund(order.id, `${order.id}_l1`, 100)).status).toBe(200);
  });
  it("concurrent refunds on one line never over-refund (rendezvous)", async () => {
    const { order, ref } = await paid([["seller_a", 1000], ["seller_b", 500]]);
    world.delay.refund = 40;
    const rs = await Promise.all(Array.from({ length: 6 }, () => refund(order.id, `${order.id}_l1`, 400)));
    expect(rs.filter((r) => r.status === 200).length).toBe(2);
    expect(rs.filter((r) => r.status === 400).length).toBe(4);
    expect(worldRefundTotal(ref)).toBe(800n);
    await invariants();
  });
  it("concurrent refunds across lines are bounded by each line and by the payment", async () => {
    const { order, ref } = await paid([["seller_a", 300], ["seller_b", 300]]);
    world.delay.refund = 30;
    const rs = await Promise.all([1, 2, 3, 4].flatMap((i) => [refund(order.id, `${order.id}_l1`, 100), refund(order.id, `${order.id}_l2`, 100)]));
    expect(rs.filter((r) => r.status === 200).length).toBe(6);
    expect(worldRefundTotal(ref)).toBe(600n);
    expect(await orderStatus(order.id)).toBe("refunded");
    await invariants();
  });
});

describe("inline: refund faults and ambiguity", () => {
  it("response lost after the provider applied the refund: never re-POSTed, capacity held, webhook links it once", async () => {
    const { order, ref } = await paid([["seller_a", 1000]]);
    world.failNext({ op: "refund", when: "after", status: 500 });
    const r = await refund(order.id, `${order.id}_l1`, 600);
    expect(r.status).toBe(502);
    expect(worldRefundTotal(ref)).toBe(600n);
    // the app must not resend, now or after backoff / idempotency expiry
    world.expireIdempotency();
    await expedite();
    await app.recoverPendingRefunds();
    await expedite();
    await app.recoverPendingRefunds();
    expect(world.count("refund")).toBe(1);
    // and must not let the line be refunded beyond what the provider could still take
    await refund(order.id, `${order.id}_l1`, 600);
    expect(worldRefundTotal(ref)).toBeLessThanOrEqual(1000n);
    const wr = [...world.refunds.values()][0] as Any;
    const e1 = await rfEvent("refund.created", wr.id);
    expect(e1.status).toBe(200);
    expect((await rfEvent("refund.updated", wr.id)).status).toBe(200);
    const rows = await q("SELECT * FROM refunds");
    expect(rows.length).toBe(1);
    expect(rows[0].origin).toBe("api");
    expect(rows[0].line_id).toBe(`${order.id}_l1`);
    expect((await q("SELECT resolution FROM refund_requests ORDER BY id"))[0].resolution).toBe("linked");
    expect(await bal("seller:seller_a")).toBe(-900n + 600n);
    await invariants();
  });
  it("network error (no response) is also ambiguous and never double-sent", async () => {
    const { order, ref } = await paid([["seller_a", 1000]]);
    world.failNext({ op: "refund", when: "after" });
    expect((await refund(order.id, `${order.id}_l1`, 1000)).status).toBe(502);
    await expedite();
    await app.recoverPendingRefunds();
    expect(world.count("refund")).toBe(1);
    expect(worldRefundTotal(ref)).toBe(1000n);
  });
  it("5xx before the provider applied anything: no provider refund, no resend, reservation never exceeds the line", async () => {
    const { order, ref } = await paid([["seller_a", 1000]]);
    world.failNext({ op: "refund", when: "before", status: 503 });
    expect((await refund(order.id, `${order.id}_l1`, 1000)).status).toBe(502);
    expect(worldRefundTotal(ref)).toBe(0n);
    await expedite();
    await app.recoverPendingRefunds();
    expect(world.count("refund")).toBe(1);
    const second = await refund(order.id, `${order.id}_l1`, 1000);
    expect(worldRefundTotal(ref)).toBeLessThanOrEqual(1000n);
    expect(second.status === 200 || second.status === 400).toBe(true);
    await invariants();
  });
  it("429 on the first POST is a definitive no-op: released and retryable", async () => {
    const { order, ref } = await paid([["seller_a", 1000]]);
    world.failNext({ op: "refund", when: "before", status: 429 });
    expect((await refund(order.id, `${order.id}_l1`, 1000)).status).toBe(409);
    expect((await q("SELECT resolution, rejection_reason FROM refund_requests"))[0]).toMatchObject({ resolution: "rejected", rejection_reason: "rate_limited" });
    expect((await refund(order.id, `${order.id}_l1`, 1000)).status).toBe(200);
    expect(worldRefundTotal(ref)).toBe(1000n);
    await invariants();
  });
  it("provider says amount too large (out-of-band dashboard refund the app has not seen yet): rejected, then dashboard refund is recorded", async () => {
    const { order, ref } = await paid([["seller_a", 1000]]);
    const dash = world.dashboardRefund(ref, 1000n);
    expect((await refund(order.id, `${order.id}_l1`, 500)).status).toBe(409);
    expect((await q("SELECT resolution FROM refund_requests"))[0].resolution).toBe("rejected");
    expect((await rfEvent("refund.created", dash.id)).status).toBe(200);
    expect(await orderStatus(order.id)).toBe("refunded");
    expect((await q("SELECT origin, line_id FROM refunds"))[0]).toMatchObject({ origin: "provider", line_id: null });
    expect(await bal("platform:unallocated_refunds")).toBe(1000n);
    await invariants();
  });
  it("a provider response whose amount differs from the request is not booked as success", async () => {
    const { order } = await paid([["seller_a", 1000]]);
    fake.tamperRefund = (r: Any) => ({ ...r, amount: r.amount - 1n });
    expect((await refund(order.id, `${order.id}_l1`, 400)).status).toBe(502);
    expect(await q("SELECT 1 FROM refunds")).toEqual([]);
    expect(await bal("provider:clearing")).toBe(1000n);
  });
  it("crash recovery: an unsent persisted reservation is POSTed exactly once; a crash after the send marker is never re-POSTed", async () => {
    const { order, ref } = await paid([["seller_a", 1000]]);
    const ins = (id: string, started: boolean, amount: number) =>
      db.query("INSERT INTO refund_requests (id, order_id, line_id, payment_ref, currency, amount, post_started, next_attempt_at) VALUES ($1,$2,$3,$4,'INR',$5,$6, now() - interval '1 second')", [id, order.id, `${order.id}_l1`, ref, amount, started]);
    await ins("rf_unsent01", false, 300);
    await ins("rf_marked01", true, 200);
    await app.recoverPendingRefunds();
    await app.recoverPendingRefunds();
    expect(world.count("refund")).toBe(1);
    expect(worldRefundTotal(ref)).toBe(300n);
    expect((await q("SELECT resolution FROM refund_requests WHERE id='rf_unsent01'"))[0].resolution).toBe("linked");
    expect((await q("SELECT resolved FROM refund_requests WHERE id='rf_marked01'"))[0].resolved).toBe(false);
    // the marked one is held against capacity: 1000 - 300 - 200 = 500 left
    expect((await refund(order.id, `${order.id}_l1`, 501)).status).toBe(400);
    expect(await bal("seller:seller_a")).toBe(-900n + 300n);
  });
});

describe("inline: refund event ordering and lifecycle", () => {
  it("refund event before the payment event is retried (503), then applied once the payment is known", async () => {
    const order = await mk([["seller_a", 1000]]);
    const ref = String((await post(`/orders/${order.id}/checkout`)).body.payment_intent_id);
    world.customerPays(ref);
    const dash = world.dashboardRefund(ref, 250n);
    const id = newEventId();
    expect((await rfEvent("refund.created", dash.id, id)).status).toBe(503);
    expect(await q("SELECT 1 FROM refunds")).toEqual([]);
    expect(await q("SELECT 1 FROM processed_events")).toEqual([]);
    expect((await piEvent("payment_intent.succeeded", ref)).status).toBe(200);
    expect((await rfEvent("refund.created", dash.id, id)).status).toBe(200);
    expect(await orderStatus(order.id)).toBe("partially_refunded");
    await invariants();
  });
  it("pending then succeeded: recognised once; duplicate and distinct-id events do not re-post", async () => {
    world.newRefundStatus = "pending";
    const { order } = await paid([["seller_a", 1000]]);
    const r = await refund(order.id, `${order.id}_l1`, 400);
    expect(r.body.status).toBe("pending");
    expect(await bal("provider:clearing")).toBe(600n);
    const rf = [...world.refunds.values()][0] as Any;
    world.setRefundStatus(rf.id, "succeeded");
    const id = newEventId();
    const rs = await Promise.all([rfEvent("refund.updated", rf.id, id), rfEvent("refund.updated", rf.id, id), rfEvent("refund.updated", rf.id)]);
    for (const x of rs) expect([200, 503]).toContain(x.status);
    expect((await rfEvent("refund.updated", rf.id, id)).status).toBe(200);
    expect((await rfEvent("refund.created", rf.id)).status).toBe(200);
    expect((await q("SELECT status FROM refunds"))[0].status).toBe("succeeded");
    expect(Number((await q("SELECT count(*)::int c FROM ledger_entries WHERE kind='refund'"))[0].c)).toBe(2);
    await invariants();
  });
  it("async failure after acceptance reverses exactly once, frees the line, and stale events cannot resurrect it", async () => {
    world.newRefundStatus = "pending";
    const { order, ref } = await paid([["seller_a", 1000], ["seller_b", 500]]);
    const l1 = `${order.id}_l1`;
    expect((await refund(order.id, l1, 1000)).status).toBe(200);
    expect((await refund(order.id, l1, 1)).status).toBe(400);
    const rf = [...world.refunds.values()][0] as Any;
    world.setRefundStatus(rf.id, "failed");
    const failId = newEventId();
    expect((await rfEvent("refund.failed", rf.id, failId)).status).toBe(200);
    expect((await rfEvent("refund.failed", rf.id, failId)).status).toBe(200);
    expect((await rfEvent("refund.failed", rf.id)).status).toBe(200);
    // stale pending / succeeded snapshots delivered late (event payload old, provider object failed)
    expect((await rfEvent("refund.updated", rf.id, undefined, "pending")).status).toBe(200);
    expect((await rfEvent("refund.updated", rf.id, undefined, "succeeded")).status).toBe(200);
    expect((await q("SELECT status FROM refunds"))[0].status).toBe("failed");
    expect(await orderStatus(order.id)).toBe("paid");
    expect(await bal("seller:seller_a")).toBe(-900n);
    expect(await bal("provider:clearing")).toBe(1500n);
    // capacity is back, and a new refund works
    world.newRefundStatus = "succeeded";
    expect((await refund(order.id, l1, 1000)).status).toBe(200);
    expect(worldRefundTotal(ref)).toBe(1000n);
    await invariants();
  });
  it("stale pending after success never regresses the recorded refund", async () => {
    world.newRefundStatus = "pending";
    const { order } = await paid([["seller_a", 1000]]);
    await refund(order.id, `${order.id}_l1`, 300);
    const rf = [...world.refunds.values()][0] as Any;
    world.setRefundStatus(rf.id, "succeeded");
    expect((await rfEvent("refund.updated", rf.id)).status).toBe(200);
    expect((await rfEvent("refund.updated", rf.id, undefined, "pending")).status).toBe(200);
    expect((await q("SELECT status FROM refunds"))[0].status).toBe("succeeded");
    await invariants();
  });
  it("requires_action may return to success (cyclic state), booked once", async () => {
    world.newRefundStatus = "requires_action";
    const { order } = await paid([["seller_a", 1000]]);
    await refund(order.id, `${order.id}_l1`, 300);
    const rf = [...world.refunds.values()][0] as Any;
    world.setRefundStatus(rf.id, "succeeded");
    await rfEvent("refund.updated", rf.id);
    world.setRefundStatus(rf.id, "requires_action");
    await rfEvent("refund.updated", rf.id);
    world.setRefundStatus(rf.id, "succeeded");
    await rfEvent("refund.updated", rf.id);
    expect((await q("SELECT status FROM refunds"))[0].status).toBe("succeeded");
    expect(await bal("provider:clearing")).toBe(700n);
    await invariants();
  });
  it("refund events with a different currency or beyond the captured total are never recorded", async () => {
    const { order, ref } = await paid([["seller_a", 1000]]);
    const ok = world.dashboardRefund(ref, 600n);
    expect((await rfEvent("refund.created", ok.id)).status).toBe(200);
    world.refunds.set("re_bad_ccy", { id: "re_bad_ccy", paymentRef: ref, amount: 100n, currency: "USD", status: "succeeded", metadata: {} });
    expect((await rfEvent("refund.created", "re_bad_ccy")).status).not.toBe(200);
    world.refunds.set("re_over", { id: "re_over", paymentRef: ref, amount: 500n, currency: "INR", status: "succeeded", metadata: {} });
    expect((await rfEvent("refund.created", "re_over")).status).not.toBe(200);
    expect((await q("SELECT provider_ref FROM refunds")).map((r) => r.provider_ref)).toEqual([ok.id]);
    expect(await bal("provider:clearing")).toBe(400n);
    world.refunds.delete("re_bad_ccy");
    world.refunds.delete("re_over");
    expect(order.id).toBeTruthy();
    await invariants();
  });
  it("concurrent API refund and dashboard refund of the same amount are not conflated", async () => {
    const { order, ref } = await paid([["seller_a", 1000]]);
    world.delay.refund = 40;
    const api = refund(order.id, `${order.id}_l1`, 300);
    await new Promise((r) => setTimeout(r, 10));
    const dash = world.dashboardRefund(ref, 300n);
    const dres = await rfEvent("refund.created", dash.id);
    expect([200, 503]).toContain(dres.status); // same amount while a request is open: must wait, never guess
    expect((await api).status).toBe(200);
    expect((await rfEvent("refund.created", dash.id)).status).toBe(200);
    const rows = await q("SELECT provider_ref, origin, line_id FROM refunds ORDER BY origin");
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.origin).sort()).toEqual(["api", "provider"]);
    expect(rows.find((r) => r.origin === "api")?.line_id).toBe(`${order.id}_l1`);
    expect(rows.find((r) => r.origin === "provider")?.line_id).toBeNull();
    expect(await bal("provider:clearing")).toBe(400n);
    await invariants();
  });
});
