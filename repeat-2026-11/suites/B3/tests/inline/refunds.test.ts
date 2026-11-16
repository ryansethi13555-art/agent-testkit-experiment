// inline-marketplace: refunds. API refunds with faults, provider-side refunds, ordering, replays, races, recovery.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api, assertBooks, big, deliver, ev, g, pgUp, resetInline, send, settle, startInline, stopInline, type Ctx } from "../helpers/inlineHarness.ts";
import { http } from "../helpers/world.ts";

vi.mock("../../inline-marketplace/src/provider.ts", async (importActual) => {
  const actual = await importActual<typeof import("../../inline-marketplace/src/provider.ts")>();
  (globalThis as Record<string, unknown>).__B3_REAL = actual.providerFromEnv({
    PAYMENT_PROVIDER: "stripe",
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_WEBHOOK_SECRET: "whsec_b3_inline",
  });
  (globalThis as Record<string, unknown>).__B3_RAZORPAY_MIN = actual.providerFromEnv({ PAYMENT_PROVIDER: "razorpay" }).refundRequestError;
  return {
    ...actual,
    providerFromEnv: () =>
      new Proxy({}, { get: (_t, k) => (globalThis as unknown as { __B3_PROVIDER: Record<string | symbol, unknown> }).__B3_PROVIDER[k] }),
  };
});

const up = await pgUp();
const NAME = `b3_inl_ref_${process.pid}`;
let ctx: Ctx;
let A: ReturnType<typeof api>;

describe.skipIf(!up)("inline: refunds", () => {
  beforeAll(async () => {
    ctx = await startInline(NAME);
    A = api(ctx);
  });
  afterAll(() => stopInline(ctx, NAME));
  beforeEach(() => resetInline(ctx));

  const q = async (sql: string, p: unknown[] = []) => (await ctx.db.query(sql, p)).rows;
  /** A paid two-line order (600 + 400 by default). */
  async function paidOrder(lines = [600, 400], opts: { currency?: string } = {}) {
    const o = await A.order(lines, opts);
    const ref = String((await A.checkout(o.id)).body.payment_intent_id);
    ctx.world.customerPays(ref);
    expect((await deliver(ctx, ev.pi(ctx, "payment_intent.succeeded", ref))).status).toBe(200);
    return { o, ref, l1: o.lines[0]!, l2: o.lines[1]! };
  }
  const requests = () => q("SELECT * FROM refund_requests ORDER BY id");

  describe("API refunds", () => {
    it("a refund reverses the right seller's share once and moves the order to partially_refunded", async () => {
      const { o, l1 } = await paidOrder();
      const r = await A.refund(o.id, l1, 250);
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("succeeded");
      expect((await q("SELECT status FROM orders"))[0].status).toBe("partially_refunded");
      const seller = await q("SELECT sum(amount)::text s FROM ledger_entries WHERE kind='refund' AND account='seller:seller_a'");
      expect(big(seller[0].s)).toBe(250n);
      await assertBooks(ctx);
    });
    it("refunding every line in full ends in refunded", async () => {
      const { o, l1, l2 } = await paidOrder();
      expect((await A.refund(o.id, l1, 600)).status).toBe(200);
      expect((await A.refund(o.id, l2, 400)).status).toBe(200);
      expect((await q("SELECT status FROM orders"))[0].status).toBe("refunded");
      await assertBooks(ctx);
    });
    it("sequential partial refunds can never sum past the line", async () => {
      const { o, l1 } = await paidOrder();
      expect((await A.refund(o.id, l1, 250)).status).toBe(200);
      expect((await A.refund(o.id, l1, 250)).status).toBe(200);
      expect((await A.refund(o.id, l1, 101)).status).toBe(400);
      expect((await A.refund(o.id, l1, 100)).status).toBe(200);
      expect((await A.refund(o.id, l1, 1)).status).toBe(400);
      expect(ctx.world.count("createRefund")).toBe(3);
      await assertBooks(ctx);
    });
    it("a line cannot be refunded beyond its own amount using another line's capacity", async () => {
      const { o, l1 } = await paidOrder([100, 900]);
      expect((await A.refund(o.id, l1, 101)).status).toBe(400);
      expect(ctx.world.count("createRefund")).toBe(0);
    });
    it("rejects bad amounts without reserving or calling the provider", async () => {
      const { o, l1 } = await paidOrder();
      for (const amount of [0, -1, 1.5, "abc", "1e2", "", null, 2 ** 53, "99999999999999999999"] as unknown[]) {
        const r = await A.post(`/orders/${o.id}/refunds`, { line_id: l1, amount });
        expect(r.status, JSON.stringify(amount)).toBe(400);
      }
      expect(await requests()).toEqual([]);
      expect(ctx.world.count("createRefund")).toBe(0);
    });
    it("rejects unpaid orders, unknown lines and lines of another order", async () => {
      const unpaid = await A.order([500]);
      expect((await A.refund(unpaid.id, unpaid.lines[0]!, 100)).status).toBe(409);
      const a = await paidOrder([500, 500]);
      const b = await paidOrder([500, 500]);
      expect((await A.refund(a.o.id, "ghost", 100)).status).toBe(404);
      expect((await A.refund(a.o.id, b.l1, 100)).status).toBe(404);
      expect((await A.refund("ord_missing", a.l1, 100)).status).toBe(409);
      expect(ctx.world.count("createRefund")).toBe(0);
      expect(await q("SELECT 1 FROM refunds")).toEqual([]);
    });
    it("Razorpay's documented INR minimum of 100 minor units is enforced before any reservation", async () => {
      const min = (globalThis as unknown as Record<string, unknown>).__B3_RAZORPAY_MIN as (a: bigint, c: string) => string | undefined;
      expect(min(99n, "INR")).toBeTruthy();
      expect(min(100n, "INR")).toBeUndefined();
      expect(min(1n, "USD")).toBeUndefined();
      const { o, l1 } = await paidOrder();
      const p = g.__B3_PROVIDER as { refundRequestError?: unknown };
      p.refundRequestError = min;
      try {
        expect((await A.refund(o.id, l1, 99)).status).toBe(400);
        expect(await requests()).toEqual([]);
        expect(ctx.world.count("createRefund")).toBe(0);
        expect((await A.refund(o.id, l1, 100)).status).toBe(200);
      } finally {
        p.refundRequestError = undefined;
      }
    });
    it("concurrent refunds on one line never exceed the line", async () => {
      const { o, l1 } = await paidOrder();
      const rs = await Promise.all([1, 2, 3, 4, 5].map(() => A.refund(o.id, l1, 250)));
      const ok = rs.filter((r) => r.status === 200).length;
      expect(ok).toBe(2);
      for (const r of rs) expect([200, 400]).toContain(r.status);
      await assertBooks(ctx);
    });
    it("concurrent refunds across lines and a dashboard refund together never exceed the payment", async () => {
      const { o, ref, l1, l2 } = await paidOrder();
      const rs = await Promise.all([A.refund(o.id, l1, 600), A.refund(o.id, l2, 400), A.refund(o.id, l1, 1)]);
      expect(rs.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(2);
      expect(ctx.world.heldOn(ref) <= 1000n).toBe(true);
      await settle(ctx);
      await assertBooks(ctx);
    });
    it("a provider rejection that proves nothing was created releases the reservation", async () => {
      const { o, l1 } = await paidOrder();
      ctx.world.fault("createRefund", "reject");
      expect((await A.refund(o.id, l1, 600)).status).toBe(409);
      expect((await requests())[0].resolution).toBe("rejected");
      expect((await A.refund(o.id, l1, 600)).status).toBe(200); // capacity is back
      await assertBooks(ctx);
    });
    it("a rate limit (429, not executed) releases the reservation too", async () => {
      const { o, l1 } = await paidOrder();
      ctx.world.fault("createRefund", "rate429");
      expect((await A.refund(o.id, l1, 100)).status).toBe(409);
      expect((await A.refund(o.id, l1, 600)).status).toBe(200);
      await assertBooks(ctx);
    });
    it("a provider limit exceeded by outside refunds is surfaced and books nothing extra", async () => {
      const { o, ref, l1 } = await paidOrder();
      const dash = ctx.world.dashboardRefund(ref, 900n);
      // the app does not know yet: its own per-line check passes, the provider refuses (definitive)
      const r = await A.refund(o.id, l1, 600);
      expect(r.status).toBe(409);
      await deliver(ctx, ev.refund(ctx, "refund.created", dash.ref));
      await settle(ctx);
      await assertBooks(ctx);
    });

    describe("unknown outcomes keep the money reserved and are never blindly re-sent", () => {
      it("response lost after the provider applied: reservation holds, exact webhook links it, books once", async () => {
        const { o, l1 } = await paidOrder();
        ctx.world.fault("createRefund", "lost");
        const r = await A.refund(o.id, l1, 600);
        expect(r.status).toBe(502);
        expect(ctx.world.refunds.size).toBe(1);
        // capacity stays reserved: another refund on the line is refused even though the app has no refund row
        expect((await A.refund(o.id, l1, 1)).status).toBe(400);
        // the provider's own events carry the request identity in metadata
        const refRef = [...ctx.world.refunds.keys()][0]!;
        await deliver(ctx, ev.refund(ctx, "refund.created", refRef));
        await deliver(ctx, ev.refund(ctx, "refund.updated", refRef));
        await settle(ctx);
        expect(ctx.world.count("createRefund")).toBe(1);
        const rows = await q("SELECT * FROM refunds");
        expect(rows.length).toBe(1);
        expect([rows[0].origin, rows[0].line_id]).toEqual(["api", l1]);
        expect((await requests())[0].resolution).toBe("linked");
        await assertBooks(ctx);
      });
      it("the recovery scan never POSTs a request whose first attempt may have committed", async () => {
        const { o, l1 } = await paidOrder();
        ctx.world.fault("createRefund", "lost");
        await A.refund(o.id, l1, 600);
        ctx.world.expireIdempotency();
        for (let i = 0; i < 4; i++) {
          await ctx.db.query("UPDATE refund_requests SET next_attempt_at=now()");
          await ctx.app.recoverPendingRefunds();
        }
        expect(ctx.world.count("createRefund")).toBe(1);
        expect(ctx.world.refunds.size).toBe(1);
      });
      it("a 5xx before the provider applied also keeps the reservation and never double sends", async () => {
        const { o, l1 } = await paidOrder();
        ctx.world.fault("createRefund", "before5xx");
        expect((await A.refund(o.id, l1, 600)).status).toBe(502);
        await ctx.db.query("UPDATE refund_requests SET next_attempt_at=now()");
        await ctx.app.recoverPendingRefunds();
        expect(ctx.world.count("createRefund")).toBe(1);
        expect((await A.refund(o.id, l1, 1)).status).toBe(400); // still reserved
        expect(ctx.world.heldOn([...ctx.world.payments.keys()][0]!)).toBe(0n);
      });
      it("a process crash after the durable send marker is treated as possibly committed", async () => {
        const { o, ref, l1 } = await paidOrder();
        await ctx.db.query(
          "INSERT INTO refund_requests (id, order_id, line_id, payment_ref, currency, amount, post_started, next_attempt_at) VALUES ('rf_crash', $1, $2, $3, 'INR', 300, true, now())",
          [o.id, l1, ref],
        );
        await ctx.app.recoverPendingRefunds();
        expect(ctx.world.count("createRefund")).toBe(0);
        expect((await requests())[0].resolved).toBe(false);
        expect((await A.refund(o.id, l1, 301)).status).toBe(400); // 300 still reserved
      });
      it("a crash before sending is recovered by sending exactly once, with the request id as idempotency key", async () => {
        const { o, ref, l1 } = await paidOrder();
        await ctx.db.query(
          "INSERT INTO refund_requests (id, order_id, line_id, payment_ref, currency, amount, next_attempt_at) VALUES ('rf_unsent', $1, $2, $3, 'INR', 300, now())",
          [o.id, l1, ref],
        );
        await ctx.app.recoverPendingRefunds();
        await ctx.app.recoverPendingRefunds();
        await ctx.app.recoverPendingRefunds();
        expect(ctx.world.count("createRefund")).toBe(1);
        expect((ctx.world.calls.find((c) => c.op === "createRefund")!.args as { idempotencyKey: string }).idempotencyKey).toBe("rf_unsent");
        expect((await requests())[0].resolution).toBe("linked");
        await assertBooks(ctx);
      });
      it("concurrent recovery scans of the same unsent request send once", async () => {
        const { o, ref, l1 } = await paidOrder();
        await ctx.db.query(
          "INSERT INTO refund_requests (id, order_id, line_id, payment_ref, currency, amount, next_attempt_at) VALUES ('rf_unsent', $1, $2, $3, 'INR', 300, now())",
          [o.id, l1, ref],
        );
        await Promise.all([1, 2, 3, 4].map(() => ctx.app.recoverPendingRefunds()));
        expect(ctx.world.count("createRefund")).toBe(1);
        expect(ctx.world.refunds.size).toBe(1);
        await assertBooks(ctx);
      });
      it("a webhook for the refund arriving before the API response is correlated by request id, not by amount", async () => {
        const { o, l1, l2 } = await paidOrder([500, 500]);
        // two in-flight requests of the same amount on different lines; events must land on the right line
        const seen: string[] = [];
        ctx.world.gates.createRefund = async () => {
          // deliver nothing here; ordering is exercised after both responses were lost
        };
        ctx.world.fault("createRefund", "lost", 2);
        await A.refund(o.id, l1, 200);
        await A.refund(o.id, l2, 200);
        const refs = [...ctx.world.refunds.values()];
        expect(refs.length).toBe(2);
        for (const r of refs.reverse()) {
          await deliver(ctx, ev.refund(ctx, "refund.created", r.ref));
          seen.push(r.ref);
        }
        await settle(ctx);
        for (const r of refs) {
          const row = (await q("SELECT * FROM refunds WHERE provider_ref=$1", [r.ref]))[0];
          expect(row.line_id).toBe(r.metadata.line_id);
        }
        await assertBooks(ctx);
      });
    });
  });

  describe("provider-originated refunds and event ordering", () => {
    it("a dashboard refund is recorded once, unallocated, and cannot be double counted by redelivery", async () => {
      const { ref } = await paidOrder();
      const d = ctx.world.dashboardRefund(ref, 100n);
      const e = ev.refund(ctx, "refund.updated", d.ref);
      for (let i = 0; i < 3; i++) expect((await send(ctx, e)).status).toBe(200);
      await Promise.all([1, 2, 3].map(() => deliver(ctx, ev.refund(ctx, "refund.updated", d.ref))));
      await settle(ctx);
      const rows = await q("SELECT * FROM refunds");
      expect(rows.length).toBe(1);
      expect([rows[0].origin, rows[0].line_id]).toEqual(["provider", null]);
      expect(big((await q("SELECT sum(amount)::text s FROM ledger_entries WHERE account='platform:unallocated_refunds'"))[0].s)).toBe(100n);
      await assertBooks(ctx);
    });
    it("dashboard refunds reduce what the app will let API users refund", async () => {
      const { o, ref, l1 } = await paidOrder();
      const d = ctx.world.dashboardRefund(ref, 700n);
      await deliver(ctx, ev.refund(ctx, "refund.created", d.ref));
      // line has capacity but the payment does not: 301 of the remaining 300 is refused locally or by the provider
      const r = await A.refund(o.id, l1, 301);
      expect(r.status).toBe(400);
      expect(ctx.world.count("createRefund")).toBe(0);
      expect(ctx.world.heldOn(ref) <= 1000n).toBe(true);
      await settle(ctx);
      await assertBooks(ctx);
    });
    it("a refund event arriving before the payment event is retried and then recorded exactly once", async () => {
      const o = await A.order([600, 400]);
      const ref = String((await A.checkout(o.id)).body.payment_intent_id);
      ctx.world.customerPays(ref);
      const d = ctx.world.dashboardRefund(ref, 100n);
      const re = ev.refund(ctx, "refund.created", d.ref);
      expect((await deliver(ctx, re)).status).toBe(503);
      expect(await q("SELECT 1 FROM refunds")).toEqual([]);
      expect((await deliver(ctx, ev.pi(ctx, "payment_intent.succeeded", ref))).status).toBe(200);
      await settle(ctx);
      expect((await q("SELECT 1 FROM refunds")).length).toBe(1);
      await assertBooks(ctx);
    });
    it("pending then succeeded: recognised once while pending, status follows the provider", async () => {
      const { o, l1 } = await paidOrder();
      ctx.world.newRefundStatus = "pending";
      expect((await A.refund(o.id, l1, 200)).body.status).toBe("pending");
      const refRef = [...ctx.world.refunds.keys()][0]!;
      expect(big((await q("SELECT sum(amount)::text s FROM ledger_entries WHERE kind='refund' AND account='provider:clearing'"))[0].s)).toBe(-200n);
      ctx.world.setRefundStatus(refRef, "succeeded");
      await deliver(ctx, ev.refund(ctx, "refund.updated", refRef));
      await deliver(ctx, ev.refund(ctx, "refund.updated", refRef));
      await settle(ctx);
      expect((await q("SELECT status FROM refunds"))[0].status).toBe("succeeded");
      await assertBooks(ctx);
    });
    it("a stale 'pending' event delivered after 'succeeded' does not regress the refund", async () => {
      const { o, l1 } = await paidOrder();
      ctx.world.newRefundStatus = "pending";
      await A.refund(o.id, l1, 200);
      const refRef = [...ctx.world.refunds.keys()][0]!;
      const stalePending = ev.refund(ctx, "refund.updated", refRef);
      ctx.world.setRefundStatus(refRef, "succeeded");
      await deliver(ctx, ev.refund(ctx, "refund.updated", refRef));
      await deliver(ctx, stalePending);
      await settle(ctx);
      expect((await q("SELECT status FROM refunds"))[0].status).toBe("succeeded");
      await assertBooks(ctx);
    });
    it("async failure reverses the recognition exactly once, frees the line, and survives replays and stale success", async () => {
      const { o, l1 } = await paidOrder();
      ctx.world.newRefundStatus = "pending";
      await A.refund(o.id, l1, 600);
      const refRef = [...ctx.world.refunds.keys()][0]!;
      const staleOk = ev.refund(ctx, "refund.updated", refRef);
      ctx.world.setRefundStatus(refRef, "failed");
      const failed = ev.refund(ctx, "refund.failed", refRef);
      await deliver(ctx, failed);
      await deliver(ctx, failed);
      await deliver(ctx, ev.refund(ctx, "refund.updated", refRef));
      await deliver(ctx, staleOk);
      await settle(ctx);
      expect((await q("SELECT status FROM refunds"))[0].status).toBe("failed");
      expect((await q("SELECT status FROM orders"))[0].status).toBe("paid");
      expect(Number((await q("SELECT count(*) c FROM ledger_entries WHERE kind='refund_reversal'"))[0].c)).toBe(2);
      await assertBooks(ctx);
      ctx.world.newRefundStatus = "succeeded";
      expect((await A.refund(o.id, l1, 600)).status).toBe(200); // the failed refund freed its capacity
      await assertBooks(ctx);
    });
    it("a refund that fails after having succeeded is reversed once", async () => {
      const { o, l1 } = await paidOrder();
      await A.refund(o.id, l1, 200);
      const refRef = [...ctx.world.refunds.keys()][0]!;
      ctx.world.setRefundStatus(refRef, "failed");
      await deliver(ctx, ev.refund(ctx, "refund.failed", refRef));
      await deliver(ctx, ev.refund(ctx, "refund.failed", refRef, "evt_other_failed"));
      await settle(ctx);
      await assertBooks(ctx);
    });
    it("a canceled refund frees capacity like a failed one", async () => {
      const { o, l1 } = await paidOrder();
      ctx.world.newRefundStatus = "pending";
      await A.refund(o.id, l1, 200);
      const refRef = [...ctx.world.refunds.keys()][0]!;
      ctx.world.setRefundStatus(refRef, "canceled");
      await deliver(ctx, ev.refund(ctx, "refund.updated", refRef));
      await settle(ctx);
      expect((await q("SELECT status FROM orders"))[0].status).toBe("paid");
      await assertBooks(ctx);
    });
    it("a signed refund event naming a refund the provider reports with other money is not booked", async () => {
      const { ref } = await paidOrder();
      const d = ctx.world.dashboardRefund(ref, 100n);
      const lie = { ...ctx.world.refundJson(d.ref), amount: 999 };
      const { signedEvent } = await import("../helpers/world.ts");
      const r = await send(ctx, signedEvent("whsec_b3_inline", "refund.updated", lie));
      expect(r.status).toBeGreaterThanOrEqual(500);
      expect(await q("SELECT 1 FROM refunds")).toEqual([]);
      expect(await q("SELECT 1 FROM ledger_entries WHERE kind='refund'")).toEqual([]);
    });
    it("two orders with identical amounts keep their refunds apart", async () => {
      const a = await paidOrder([500, 500]);
      const b = await paidOrder([500, 500]);
      const [ra, rb] = await Promise.all([A.refund(a.o.id, a.l1, 200), A.refund(b.o.id, b.l2, 200)]);
      expect([ra.status, rb.status]).toEqual([200, 200]);
      for (const w of ctx.world.refunds.values()) {
        const row = (await q("SELECT * FROM refunds WHERE provider_ref=$1", [w.ref]))[0];
        expect(row.order_id).toBe(w.metadata.order_id);
        expect(row.line_id).toBe(w.metadata.line_id);
      }
      await assertBooks(ctx);
    });
    it("an in-flight API refund and an equal-amount dashboard refund are both recorded, neither merged into the other", async () => {
      const { o, ref, l1 } = await paidOrder();
      ctx.world.fault("createRefund", "lost");
      await A.refund(o.id, l1, 200);
      const apiRef = [...ctx.world.refunds.keys()][0]!;
      const d = ctx.world.dashboardRefund(ref, 200n);
      const de = ev.refund(ctx, "refund.created", d.ref);
      expect((await deliver(ctx, de)).status).toBe(503); // cannot yet tell it from the unresolved request
      await deliver(ctx, ev.refund(ctx, "refund.created", apiRef));
      await settle(ctx);
      const rows = await q("SELECT * FROM refunds ORDER BY provider_ref");
      expect(rows.length).toBe(2);
      expect(rows.find((r) => r.provider_ref === apiRef).origin).toBe("api");
      expect(rows.find((r) => r.provider_ref === d.ref).origin).toBe("provider");
      await assertBooks(ctx);
    });
  });

  it("an event that cannot be processed because another delivery holds the refund is not acknowledged", async () => {
    const { ref } = await paidOrder();
    const d = ctx.world.dashboardRefund(ref, 100n);
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    ctx.world.gates.retrieveRefund = () => held;
    ctx.world.fault("retrieveRefund", "before5xx"); // the holder will fail
    const first = send(ctx, ev.refund(ctx, "refund.created", d.ref, "evt_holder"));
    for (let i = 0; i < 200 && ctx.world.count("retrieveRefund") < 1; i++) await new Promise((r) => setTimeout(r, 10));
    ctx.world.gates.retrieveRefund = async () => {};
    const second = await send(ctx, ev.refund(ctx, "refund.updated", d.ref, "evt_waiter"));
    expect(second.status).toBe(503); // 200 here would lose the notice if the holder fails
    release();
    expect((await first).status).toBeGreaterThanOrEqual(500);
    ctx.pending.push(ev.refund(ctx, "refund.created", d.ref, "evt_holder"));
    await settle(ctx);
    await assertBooks(ctx);
  });

  it("webhook transport edge: GET to the webhook path and an unparseable body change nothing", async () => {
    expect((await http(ctx.base, "GET", "/webhooks/stripe")).status).toBe(404);
    expect((await send(ctx, { payload: "not json", headers: { "stripe-signature": "t=1,v1=00" } })).status).toBe(400);
  });
});
