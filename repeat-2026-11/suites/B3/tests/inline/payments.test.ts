// inline-marketplace: orders, checkout, capture, payment webhooks, ledger arithmetic.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api, assertBooks, big, deliver, ev, g, pgUp, resetInline, send, settle, startInline, stopInline, type Ctx } from "../helpers/inlineHarness.ts";
import { refCommission, signedEvent } from "../helpers/world.ts";

vi.mock("../../inline-marketplace/src/provider.ts", async (importActual) => {
  const actual = await importActual<typeof import("../../inline-marketplace/src/provider.ts")>();
  (globalThis as Record<string, unknown>).__B3_REAL = actual.providerFromEnv({
    PAYMENT_PROVIDER: "stripe",
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_WEBHOOK_SECRET: "whsec_b3_inline",
  });
  return {
    ...actual,
    providerFromEnv: () =>
      new Proxy({}, { get: (_t, k) => (globalThis as unknown as { __B3_PROVIDER: Record<string | symbol, unknown> }).__B3_PROVIDER[k] }),
  };
});

const up = await pgUp();
const NAME = `b3_inl_pay_${process.pid}`;
let ctx: Ctx;
let A: ReturnType<typeof api>;

describe.skipIf(!up)("inline: orders, checkout, payments", () => {
  beforeAll(async () => {
    ctx = await startInline(NAME);
    A = api(ctx);
  });
  afterAll(() => stopInline(ctx, NAME));
  beforeEach(() => resetInline(ctx));

  const q = async (sql: string, p: unknown[] = []) => (await ctx.db.query(sql, p)).rows;
  const paid = async (lines: number[], opts: { currency?: string; capture?: string } = {}) => {
    const o = await A.order(lines, opts);
    const co = await A.checkout(o.id);
    expect(co.status).toBe(200);
    const ref = String(co.body.payment_intent_id);
    return { o, ref };
  };

  describe("input validation: nothing is created for bad money", () => {
    const bad: [string, unknown][] = [
      ["zero amount", [{ seller_id: "seller_a", amount: 0 }]],
      ["negative amount", [{ seller_id: "seller_a", amount: -5 }]],
      ["fractional number", [{ seller_id: "seller_a", amount: 10.5 }]],
      ["decimal string", [{ seller_id: "seller_a", amount: "10.50" }]],
      ["exponent string", [{ seller_id: "seller_a", amount: "1e3" }]],
      ["unsafe integer", [{ seller_id: "seller_a", amount: 2 ** 53 }]],
      ["huge digit string", [{ seller_id: "seller_a", amount: "99999999999999999999" }]],
      ["null amount", [{ seller_id: "seller_a", amount: null }]],
      ["total overflows safe range", [{ seller_id: "seller_a", amount: "9007199254740990" }, { seller_id: "seller_b", amount: 10 }]],
      ["no lines", []],
    ];
    for (const [name, lines] of bad)
      it(`rejects ${name}`, async () => {
        const r = await A.post("/orders", { currency: "INR", lines });
        expect(r.status).toBe(400);
        expect(await q("SELECT 1 FROM orders")).toEqual([]);
      });
    it("rejects a malformed currency", async () => {
      for (const currency of ["RUPEE", "in", "12", ""]) {
        const r = await A.post("/orders", { currency, lines: [{ seller_id: "seller_a", amount: 100 }] });
        expect(r.status).toBe(400);
      }
      expect(await q("SELECT 1 FROM orders")).toEqual([]);
    });
    it("an unknown seller leaves no half-written order", async () => {
      const r = await A.post("/orders", { lines: [{ seller_id: "seller_a", amount: 100 }, { seller_id: "ghost", amount: 100 }] });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(await q("SELECT 1 FROM orders")).toEqual([]);
      expect(await q("SELECT 1 FROM order_lines")).toEqual([]);
    });
    it("accepts decimal digit strings and normalises currency case; total is the exact sum", async () => {
      const r = await A.post("/orders", { currency: "usd", lines: [{ seller_id: "seller_a", amount: "00123" }, { seller_id: "seller_b", amount: 7 }] });
      expect(r.status).toBe(201);
      expect(r.body.total).toBe("130");
      expect(r.body.currency).toBe("USD");
    });
    it("accepts a total at the exact SDK integer limit and refuses one unit more", async () => {
      expect((await A.post("/orders", { lines: [{ seller_id: "seller_a", amount: "9007199254740991" }] })).status).toBe(201);
      expect((await A.post("/orders", { lines: [{ seller_id: "seller_a", amount: "9007199254740991" }, { seller_id: "seller_b", amount: 1 }] })).status).toBe(400);
    });
  });

  describe("checkout", () => {
    it("creates exactly one provider payment with the order's exact money, however often it is submitted", async () => {
      const o = await A.order([600, 400]);
      const rs = [await A.checkout(o.id), await A.checkout(o.id), await A.checkout(o.id)];
      expect(new Set(rs.map((r) => r.body.payment_intent_id)).size).toBe(1);
      expect(ctx.world.payments.size).toBe(1);
      const p = [...ctx.world.payments.values()][0]!;
      expect([p.amount, p.currency, p.orderId]).toEqual([1000n, "INR", o.id]);
    });
    it("concurrent double submit creates at most one provider payment", async () => {
      const o = await A.order([500, 500]);
      const rs = await Promise.all([A.checkout(o.id), A.checkout(o.id), A.checkout(o.id), A.checkout(o.id)]);
      expect(ctx.world.payments.size).toBe(1);
      expect(rs.some((r) => r.status === 200)).toBe(true);
      for (const r of rs) expect([200, 502]).toContain(r.status);
    });
    it("a lost create response never causes a second provider payment, even after the idempotency key expired", async () => {
      const o = await A.order([500, 500]);
      ctx.world.fault("createPayment", "lost");
      expect((await A.checkout(o.id)).status).toBe(502);
      ctx.world.expireIdempotency();
      expect((await A.checkout(o.id)).status).toBe(502);
      expect(ctx.world.count("createPayment")).toBe(1);
      expect(ctx.world.payments.size).toBe(1);
      // the signed payment_intent.created observation recovers the identity; checkout then reuses it
      const ref = [...ctx.world.payments.keys()][0]!;
      expect((await deliver(ctx, ev.pi(ctx, "payment_intent.created", ref))).status).toBe(200);
      const again = await A.checkout(o.id);
      expect(again.status).toBe(200);
      expect(again.body.payment_intent_id).toBe(ref);
      expect(ctx.world.payments.size).toBe(1);
    });
    it("a 5xx before apply does not allow a second create either", async () => {
      const o = await A.order([300, 300]);
      ctx.world.fault("createPayment", "before5xx");
      expect((await A.checkout(o.id)).status).toBe(502);
      await A.checkout(o.id);
      expect(ctx.world.count("createPayment")).toBe(1);
    });
    it("refuses to checkout an order that is already paid", async () => {
      const { o, ref } = await paid([100, 100]);
      ctx.world.customerPays(ref);
      await deliver(ctx, ev.pi(ctx, "payment_intent.succeeded", ref));
      expect((await A.checkout(o.id)).status).toBe(409);
      expect(ctx.world.payments.size).toBe(1);
    });
    it("a provider payment whose amount differs from the order is never accepted as the order's payment", async () => {
      const o = await A.order([400, 600]);
      const orig = ctx.world.createPayment.bind(ctx.world);
      ctx.world.createPayment = async (p) => orig({ ...p, amount: p.amount - 1n });
      const r = await A.checkout(o.id);
      expect(r.status).toBeGreaterThanOrEqual(500);
      expect((await q("SELECT payment_intent_id FROM orders WHERE id=$1", [o.id]))[0].payment_intent_id).toBeNull();
    });
  });

  describe("payment webhooks", () => {
    it("books a sale once: balanced, correct split, per-line commission rounded half to even", async () => {
      const { o, ref } = await paid([5, 15, 25, 35, 1, 999, 100001]);
      ctx.world.customerPays(ref);
      expect((await deliver(ctx, ev.pi(ctx, "payment_intent.succeeded", ref))).status).toBe(200);
      await assertBooks(ctx);
      const total = o.total;
      expect(total).toBe(5n + 15n + 25n + 35n + 1n + 999n + 100001n);
      // half-even spot checks: 10% of 5=0.5->0, 15=1.5->2, 25=2.5->2, 35=3.5->4, 1->0
      expect([5n, 15n, 25n, 35n, 1n].map(refCommission)).toEqual([0n, 2n, 2n, 4n, 0n]);
    });
    it("a payment event delivered many times, sequentially and concurrently, books once", async () => {
      const { ref } = await paid([700, 300]);
      ctx.world.customerPays(ref);
      const e = ev.pi(ctx, "payment_intent.succeeded", ref);
      expect((await send(ctx, e)).status).toBe(200);
      expect((await send(ctx, e)).status).toBe(200);
      const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => send(ctx, e)));
      for (const r of rs) expect(r.status).toBe(200);
      expect(Number((await q("SELECT count(*) c FROM ledger_entries WHERE kind='sale'"))[0].c)).toBe(3);
      await assertBooks(ctx);
    });
    it("concurrent first deliveries of the same event book once", async () => {
      const { ref } = await paid([700, 300]);
      ctx.world.customerPays(ref);
      const e = ev.pi(ctx, "payment_intent.succeeded", ref);
      const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => send(ctx, e)));
      expect(rs.every((r) => r.status === 200)).toBe(true);
      await assertBooks(ctx);
    });
    it("the same payment under fresh event ids (redelivery by a different envelope) does not double book", async () => {
      const { ref } = await paid([700, 300]);
      ctx.world.customerPays(ref);
      for (let i = 0; i < 3; i++) await deliver(ctx, ev.pi(ctx, "payment_intent.succeeded", ref));
      await A.post(`/orders/${(await q("SELECT id FROM orders"))[0].id}/confirm`);
      await assertBooks(ctx);
    });
    it("return-from-checkout confirm and the webhook together book once; confirm before payment books nothing", async () => {
      const { o, ref } = await paid([250, 250]);
      expect((await A.post(`/orders/${o.id}/confirm`)).body.status).toBe("pending_payment");
      expect(await q("SELECT 1 FROM ledger_entries")).toEqual([]);
      ctx.world.customerPays(ref);
      expect((await A.post(`/orders/${o.id}/confirm`)).body.status).toBe("paid");
      await deliver(ctx, ev.pi(ctx, "payment_intent.succeeded", ref));
      await A.post(`/orders/${o.id}/confirm`);
      await assertBooks(ctx);
    });
    it("a forged or tampered webhook has no effect", async () => {
      const { ref } = await paid([500, 500]);
      ctx.world.customerPays(ref);
      const good = ev.pi(ctx, "payment_intent.succeeded", ref);
      const forged = { ...good, headers: { "stripe-signature": "t=1700000000,v1=deadbeef" } };
      expect((await send(ctx, forged)).status).toBe(400);
      const tampered = { ...good, payload: good.payload.replace('"amount":1000', '"amount":1') };
      expect((await send(ctx, tampered)).status).toBe(400);
      expect((await send(ctx, { payload: good.payload, headers: {} })).status).toBe(400);
      const wrongSecret = signedEvent("whsec_other", "payment_intent.succeeded", ctx.world.piJson(ref));
      expect((await send(ctx, wrongSecret)).status).toBe(400);
      expect(await q("SELECT 1 FROM ledger_entries")).toEqual([]);
      expect(await q("SELECT 1 FROM processed_events")).toEqual([]);
    });
    it("a payment event for an unknown order is retried later and books nothing", async () => {
      const pay = ctx.world.rogueCapturedPayment("ord_missing", 100n, "INR");
      const e = ev.pi(ctx, "payment_intent.succeeded", pay.ref);
      expect((await send(ctx, e)).status).toBe(503);
      expect(await q("SELECT 1 FROM ledger_entries")).toEqual([]);
      expect(await q("SELECT 1 FROM processed_events")).toEqual([]);
    });
    it("a second provider payment for an order is never booked as another sale", async () => {
      const { o, ref } = await paid([500, 500]);
      ctx.world.customerPays(ref);
      await deliver(ctx, ev.pi(ctx, "payment_intent.succeeded", ref));
      const rogue = ctx.world.rogueCapturedPayment(o.id, 1000n, "INR");
      const r = await send(ctx, ev.pi(ctx, "payment_intent.succeeded", rogue.ref));
      expect(r.status).toBeGreaterThanOrEqual(500);
      expect(Number((await q("SELECT count(*) c FROM ledger_entries WHERE kind='sale' AND account='provider:clearing'"))[0].c)).toBe(1);
      expect(Number((await q("SELECT count(*) c FROM processed_events"))[0].c)).toBe(1);
    });
    it("a captured amount or currency different from the order is not booked as the order's sale", async () => {
      const { ref } = await paid([500, 500]);
      ctx.world.customerPays(ref);
      const partial = { ...ctx.world.piJson(ref), amount_received: 400 };
      expect((await send(ctx, signedEvent("whsec_b3_inline", "payment_intent.succeeded", partial))).status).toBeGreaterThanOrEqual(500);
      const wrongCur = { ...ctx.world.piJson(ref), currency: "usd" };
      expect((await send(ctx, signedEvent("whsec_b3_inline", "payment_intent.succeeded", wrongCur))).status).toBeGreaterThanOrEqual(500);
      expect(await q("SELECT 1 FROM ledger_entries")).toEqual([]);
      expect((await q("SELECT status FROM orders"))[0].status).toBe("pending_payment");
    });
    it("a signed 'succeeded' event whose status says not succeeded cannot book money", async () => {
      const { ref } = await paid([500, 500]); // customer has not paid
      expect((await send(ctx, ev.pi(ctx, "payment_intent.succeeded", ref))).status).toBeGreaterThanOrEqual(500);
      expect(await q("SELECT 1 FROM ledger_entries")).toEqual([]);
    });
    it("created/authorised observations never book captured money", async () => {
      const { ref } = await paid([500, 500]);
      expect((await send(ctx, ev.pi(ctx, "payment_intent.created", ref))).status).toBe(200);
      expect(await q("SELECT 1 FROM ledger_entries")).toEqual([]);
      expect((await q("SELECT status FROM orders"))[0].status).toBe("pending_payment");
    });
    it("a late duplicate payment event after refunds neither re-books the sale nor undoes the refund", async () => {
      const { o, ref } = await paid([600, 400]);
      ctx.world.customerPays(ref);
      const e = ev.pi(ctx, "payment_intent.succeeded", ref);
      await deliver(ctx, e);
      expect((await A.refund(o.id, o.lines[0]!, 600)).status).toBe(200);
      await deliver(ctx, ev.pi(ctx, "payment_intent.succeeded", ref));
      await send(ctx, e);
      await A.post(`/orders/${o.id}/confirm`);
      expect((await q("SELECT status FROM orders"))[0].status).toBe("partially_refunded");
      await assertBooks(ctx);
    });
    it("works in non-INR currencies with every ledger row in the order currency", async () => {
      for (const currency of ["USD", "JPY", "KWD"]) {
        const { o, ref } = await paid([333, 667], { currency });
        ctx.world.customerPays(ref);
        await deliver(ctx, ev.pi(ctx, "payment_intent.succeeded", ref));
        expect((await A.refund(o.id, o.lines[0]!, 100)).status).toBe(200);
      }
      expect((await q("SELECT DISTINCT currency FROM ledger_entries ORDER BY 1")).map((r) => r.currency)).toEqual(["JPY", "KWD", "USD"]);
      await assertBooks(ctx);
    });
  });

  describe("manual capture", () => {
    it("is paid only after capture; a repeated capture is idempotent", async () => {
      const { o, ref } = await paid([600, 400], { capture: "manual" });
      ctx.world.customerPays(ref);
      await deliver(ctx, ev.pi(ctx, "payment_intent.amount_capturable_updated", ref));
      expect((await q("SELECT status FROM orders"))[0].status).toBe("pending_payment");
      expect(await q("SELECT 1 FROM ledger_entries")).toEqual([]);
      expect((await A.post(`/orders/${o.id}/capture`)).body.status).toBe("paid");
      expect((await A.post(`/orders/${o.id}/capture`)).status).toBe(200);
      expect(ctx.world.get(ref).captured).toBe(1000n);
      await assertBooks(ctx);
    });
    it("a capture whose response is lost is parked and then resolved by the webhook exactly once", async () => {
      const { o, ref } = await paid([600, 400], { capture: "manual" });
      ctx.world.customerPays(ref);
      ctx.world.fault("capture", "lost");
      const r = await A.post(`/orders/${o.id}/capture`);
      expect(r.status).toBe(502);
      expect((await q("SELECT status FROM orders"))[0].status).toBe("capture_pending");
      expect(ctx.world.get(ref).captured).toBe(1000n);
      expect(await q("SELECT 1 FROM ledger_entries")).toEqual([]);
      await deliver(ctx, ev.pi(ctx, "payment_intent.succeeded", ref));
      await A.post(`/orders/${o.id}/confirm`);
      await assertBooks(ctx);
      expect(ctx.world.count("capture")).toBe(1);
    });
    it("a capture rejected or failed before apply books nothing and can be retried", async () => {
      const { o, ref } = await paid([600, 400], { capture: "manual" });
      ctx.world.customerPays(ref);
      ctx.world.fault("capture", "before5xx");
      expect((await A.post(`/orders/${o.id}/capture`)).status).toBe(502);
      expect(await q("SELECT 1 FROM ledger_entries")).toEqual([]);
      expect(ctx.world.get(ref).captured).toBe(0n);
      expect((await A.post(`/orders/${o.id}/capture`)).status).toBe(200);
      await assertBooks(ctx);
    });
    it("a partial capture is never booked as the full sale", async () => {
      const { o, ref } = await paid([600, 400], { capture: "manual" });
      ctx.world.customerPays(ref);
      // provider captured less than the order total (partial capture)
      const pay = ctx.world.get(ref);
      Object.assign(pay, { status: "succeeded", captured: 700n });
      const r = await deliver(ctx, ev.pi(ctx, "payment_intent.succeeded", ref));
      expect(r.status).toBeGreaterThanOrEqual(500);
      await A.post(`/orders/${o.id}/confirm`);
      const clearing = big((await q("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE account='provider:clearing'"))[0].s);
      expect(clearing === 0n || clearing === 700n).toBe(true);
      const sellerCredits = big((await q("SELECT coalesce(sum(-amount),0)::text s FROM ledger_entries WHERE account LIKE 'seller:%'"))[0].s);
      expect(sellerCredits <= 700n).toBe(true);
      expect(await q("SELECT txn_id FROM ledger_entries GROUP BY txn_id HAVING sum(amount)<>0")).toEqual([]);
    });
  });

  describe("ledger arithmetic", () => {
    it("for many line shapes the seller and platform parts sum exactly to each line and balance", async () => {
      const shapes = [[1], [2, 3], [9, 99, 999], [5, 5, 5, 5, 5], [15, 25, 35, 45], [1, 1, 1, 1, 1, 1, 1], [100, 101, 102], [123456789, 7]];
      for (const lines of shapes) {
        const { ref } = await paid(lines);
        ctx.world.customerPays(ref);
        await deliver(ctx, ev.pi(ctx, "payment_intent.succeeded", ref));
      }
      await assertBooks(ctx);
      const rows = await q("SELECT effect_ref, sum(amount)::text s FROM ledger_entries WHERE effect_ref LIKE 'allocation:%' GROUP BY 1");
      for (const r of rows) {
        const line = (await q("SELECT amount FROM order_lines WHERE id=$1", [String(r.effect_ref).slice("allocation:".length)]))[0];
        expect(big(r.s)).toBe(-big(line.amount));
      }
    });
  });

  it("health check answers", async () => {
    expect((await (await fetch(`${ctx.base}/healthz`)).json()) as unknown).toEqual({ ok: true });
  });
  it("unknown routes and methods change nothing", async () => {
    expect((await A.post("/nope")).status).toBe(404);
    expect((await A.post("/orders/ord_x/explode")).status).toBe(404);
    expect((await A.checkout("ord_missing")).status).toBe(404);
  });
  it("settle helper leaves nothing pending in a quiet system", async () => {
    await settle(ctx);
  });
});
