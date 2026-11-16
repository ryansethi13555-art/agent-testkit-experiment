// inline-marketplace: randomised interleavings of API refunds (with faults), provider refunds, status changes,
// late/duplicate/stale deliveries and recovery scans. After the system settles, every money law must hold
// against the world's true state. Seeds are fixed so failures reproduce.
import fc from "fast-check";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api, assertBooks, deliver, ev, pgUp, resetInline, settle, startInline, stopInline, type Ctx } from "../helpers/inlineHarness.ts";
import type { signedEvent } from "../helpers/world.ts";

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
const NAME = `b3_inl_model_${process.pid}`;
let ctx: Ctx;

type Fault = "none" | "lost" | "before5xx" | "rate429" | "reject";
type Step =
  | { t: "refund"; line: number; half: number; fault: Fault; pend: boolean; announce: boolean }
  | { t: "burst"; line: number; half: number; n: number }
  | { t: "dash"; amt: number; pend: boolean }
  | { t: "transition"; idx: number; to: "succeeded" | "failed" | "canceled" }
  | { t: "replay"; idx: number }
  | { t: "recover" };

const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ t: fc.constant("refund" as const), line: fc.nat(2), half: fc.integer({ min: 1, max: 400 }), fault: fc.constantFrom<Fault>("none", "none", "none", "lost", "before5xx", "rate429", "reject"), pend: fc.boolean(), announce: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("burst" as const), line: fc.nat(2), half: fc.integer({ min: 1, max: 300 }), n: fc.integer({ min: 2, max: 4 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("dash" as const), amt: fc.integer({ min: 0, max: 200 }), pend: fc.boolean() }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant("transition" as const), idx: fc.nat(8), to: fc.constantFrom("succeeded" as const, "failed" as const, "canceled" as const) }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant("replay" as const), idx: fc.nat(40) }) },
  { weight: 1, arbitrary: fc.constant({ t: "recover" as const }) },
);

describe.skipIf(!up)("inline: model-based interleavings", () => {
  beforeAll(async () => {
    ctx = await startInline(NAME);
  });
  afterAll(() => stopInline(ctx, NAME));
  beforeEach(() => resetInline(ctx));

  async function run(lines: number[], steps: Step[], order: number[]) {
    await resetInline(ctx);
    const A = api(ctx);
    const o = await A.order(lines);
    const ref = String((await A.checkout(o.id)).body.payment_intent_id);
    ctx.world.customerPays(ref);
    const all: ReturnType<typeof signedEvent>[] = [];
    const announced = new Set<string>();
    const emit = async (type: string, rr: string, now: boolean) => {
      const e = ev.refund(ctx, type, rr);
      all.push(e);
      if (now) await deliver(ctx, e);
    };
    const payEvent = ev.pi(ctx, "payment_intent.succeeded", ref);
    all.push(payEvent);
    // the payment event may be late: deliver it first only for even-length scenarios
    if (steps.length % 2 === 0) await deliver(ctx, payEvent);
    else await A.post(`/orders/${o.id}/confirm`);
    const announceNew = async (now: boolean) => {
      for (const r of ctx.world.refunds.values())
        if (!announced.has(r.ref)) {
          announced.add(r.ref);
          await emit("refund.created", r.ref, now);
        }
    };
    for (const s of steps) {
      if (s.t === "refund") {
        ctx.world.newRefundStatus = s.pend ? "pending" : "succeeded";
        if (s.fault !== "none") ctx.world.fault("createRefund", s.fault);
        const line = o.lines[s.line % o.lines.length]!;
        const r = await A.refund(o.id, line, 2 * s.half);
        expect([200, 400, 409, 502, 409]).toContain(r.status);
        ctx.world.faults.createRefund = [];
        await announceNew(s.announce);
      } else if (s.t === "burst") {
        ctx.world.newRefundStatus = "succeeded";
        const line = o.lines[s.line % o.lines.length]!;
        const rs = await Promise.all(Array.from({ length: s.n }, () => A.refund(o.id, line, 2 * s.half)));
        for (const r of rs) expect([200, 400, 502]).toContain(r.status);
        await announceNew(true);
      } else if (s.t === "dash") {
        const pay = ctx.world.get(ref);
        const room = pay.captured - ctx.world.heldOn(ref);
        const amt = BigInt(2 * s.amt + 1);
        if (amt <= room) {
          const d = ctx.world.dashboardRefund(ref, amt, s.pend ? "pending" : "succeeded");
          announced.add(d.ref);
          await emit("refund.created", d.ref, true);
        }
      } else if (s.t === "transition") {
        const list = [...ctx.world.refunds.values()];
        const r = list[s.idx % Math.max(1, list.length)];
        if (r) {
          const legal = r.status === "pending" || r.status === "requires_action" ? true : r.status === "succeeded" && s.to === "failed";
          if (legal) {
            ctx.world.setRefundStatus(r.ref, s.to);
            await emit(s.to === "failed" ? "refund.failed" : "refund.updated", r.ref, true);
          }
        }
      } else if (s.t === "replay") {
        const e = all[s.idx % all.length]!;
        await deliver(ctx, e);
      } else {
        await ctx.db.query("UPDATE refund_requests SET next_attempt_at=now() WHERE NOT resolved");
        await ctx.app.recoverPendingRefunds();
      }
    }
    // at-least-once delivery: everything is eventually delivered, in an arbitrary order, at least once
    await announceNew(false);
    const shuffled = order.length ? [...all].sort((a, b) => order[all.indexOf(a) % order.length]! - order[all.indexOf(b) % order.length]!) : all;
    for (const e of shuffled) await deliver(ctx, e);
    await settle(ctx);
    await assertBooks(ctx);
  }

  it("holds the money laws under random schedules (3 lines)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 100, max: 6000 }), { minLength: 2, maxLength: 3 }),
        fc.array(step, { minLength: 1, maxLength: 12 }),
        fc.array(fc.nat(100), { maxLength: 10 }),
        (lines, steps, order) => run(lines, steps, order),
      ),
      { seed: 20261114, numRuns: 40, endOnFailure: true },
    );
  });

  it("holds the money laws for hostile fixed schedules", async () => {
    const S = (s: Step) => s;
    const schedules: Step[][] = [
      [S({ t: "refund", line: 0, half: 50, fault: "lost", pend: true, announce: false }), S({ t: "transition", idx: 0, to: "failed" }), S({ t: "refund", line: 0, half: 50, fault: "none", pend: false, announce: true }), S({ t: "replay", idx: 1 })],
      [S({ t: "dash", amt: 40, pend: true }), S({ t: "refund", line: 1, half: 99, fault: "before5xx", pend: false, announce: true }), S({ t: "transition", idx: 0, to: "succeeded" }), S({ t: "transition", idx: 0, to: "failed" }), S({ t: "recover" })],
      [S({ t: "burst", line: 0, half: 200, n: 4 }), S({ t: "refund", line: 0, half: 100, fault: "reject", pend: false, announce: true }), S({ t: "replay", idx: 3 }), S({ t: "replay", idx: 0 })],
    ];
    for (const steps of schedules) await run([1000, 2000, 1500], steps, [3, 1, 2]);
    expect(true).toBe(true);
  });
});
