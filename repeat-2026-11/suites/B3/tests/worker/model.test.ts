// worker-marketplace: randomised interleavings, then the money laws against the world's true state.
import fc from "fast-check";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgUp } from "../helpers/inlineHarness.ts";
import { assertWorkerBooks, drain, resetWorker, startWorker, stopWorker, W, wev, type WCtx } from "../helpers/workerHarness.ts";
import type { signedEvent } from "../helpers/world.ts";

const up = await pgUp();
const NAME = `b3_wrk_model_${process.pid}`;
let c: WCtx;

type Fault = "none" | "lost" | "before5xx" | "rate429" | "reject";
type Step =
  | { t: "refund"; line: number; amt: number; fault: Fault; pend: boolean; announce: boolean }
  | { t: "burst"; line: number; amt: number; n: number }
  | { t: "dash"; amt: number; pend: boolean }
  | { t: "transition"; idx: number; to: "succeeded" | "failed" | "canceled" }
  | { t: "replay"; idx: number }
  | { t: "drain" }
  | { t: "rogue" };

const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ t: fc.constant("refund" as const), line: fc.nat(2), amt: fc.integer({ min: 100, max: 800 }), fault: fc.constantFrom<Fault>("none", "none", "none", "lost", "before5xx", "rate429", "reject"), pend: fc.boolean(), announce: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("burst" as const), line: fc.nat(2), amt: fc.integer({ min: 100, max: 600 }), n: fc.integer({ min: 2, max: 4 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("dash" as const), amt: fc.integer({ min: 100, max: 400 }), pend: fc.boolean() }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant("transition" as const), idx: fc.nat(8), to: fc.constantFrom("succeeded" as const, "failed" as const, "canceled" as const) }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant("replay" as const), idx: fc.nat(40) }) },
  { weight: 2, arbitrary: fc.constant({ t: "drain" as const }) },
  { weight: 1, arbitrary: fc.constant({ t: "rogue" as const }) },
);

describe.skipIf(!up)("worker: model-based interleavings", () => {
  beforeAll(async () => {
    c = await startWorker(NAME);
  });
  afterAll(() => stopWorker(c, NAME));
  beforeEach(() => resetWorker(c));

  async function run(lines: number[], steps: Step[], payFirst: boolean, order: number[]) {
    await resetWorker(c);
    const A = W(c);
    const o = await A.order(lines);
    const ref = String((await A.checkout(o.id)).body.payment_ref);
    c.world.customerPays(ref);
    const all: ReturnType<typeof signedEvent>[] = [];
    const announced = new Set<string>();
    const emit = async (type: string, rr: string, now: boolean) => {
      const e = wev.refund(c, type, rr);
      all.push(e);
      if (now) await A.hook(e);
    };
    const payEvent = wev.pi(c, "payment_intent.succeeded", ref);
    all.push(payEvent);
    if (payFirst) {
      await A.hook(payEvent);
      await drain(c);
    }
    const announceNew = async (now: boolean) => {
      for (const r of c.world.refunds.values())
        if (!announced.has(r.ref)) {
          announced.add(r.ref);
          await emit("refund.created", r.ref, now);
        }
    };
    let rogue = false;
    for (const s of steps) {
      if (s.t === "refund" || s.t === "burst") {
        c.world.newRefundStatus = s.t === "refund" && s.pend ? "pending" : "succeeded";
        const line = o.lines[s.line % o.lines.length]!;
        if (s.t === "refund") {
          if (s.fault !== "none") c.world.fault("createRefund", s.fault);
          const r = await A.refund(o.id, line, s.amt);
          expect([200, 202, 400, 409]).toContain(r.status);
          c.world.faults.createRefund = [];
          await announceNew(s.announce);
        } else {
          const rs = await Promise.all(Array.from({ length: s.n }, () => A.refund(o.id, line, s.amt)));
          for (const r of rs) expect([200, 202, 400, 409]).toContain(r.status);
          await announceNew(true);
        }
      } else if (s.t === "dash") {
        const pay = c.world.get(ref);
        if (pay.status === "succeeded" && BigInt(s.amt) <= pay.captured - c.world.heldOn(ref)) {
          const d = c.world.dashboardRefund(ref, BigInt(s.amt), s.pend ? "pending" : "succeeded");
          announced.add(d.ref);
          await emit("refund.created", d.ref, true);
        }
      } else if (s.t === "transition") {
        const list = [...c.world.refunds.values()];
        const r = list[s.idx % Math.max(1, list.length)];
        if (r && (r.status === "pending" || r.status === "requires_action" || (r.status === "succeeded" && s.to === "failed"))) {
          c.world.setRefundStatus(r.ref, s.to);
          await emit(s.to === "failed" ? "refund.failed" : "refund.updated", r.ref, true);
        }
      } else if (s.t === "replay") {
        await A.hook(all[s.idx % all.length]!);
      } else if (s.t === "rogue" && !rogue) {
        rogue = true;
        const p = c.world.rogueCapturedPayment(o.id, o.total, "INR");
        const e = wev.pi(c, "payment_intent.succeeded", p.ref);
        all.push(e);
        await A.hook(e);
      } else if (s.t === "drain") {
        await drain(c, 3);
      }
    }
    await announceNew(false);
    const shuffled = order.length ? [...all].sort((a, b) => order[all.indexOf(a) % order.length]! - order[all.indexOf(b) % order.length]!) : all;
    for (const e of shuffled) await A.hook(e);
    await drain(c, 25);
    await assertWorkerBooks(c, { reservedOk: true });
  }

  it("holds the money laws under random schedules", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 100, max: 6000 }), { minLength: 2, maxLength: 3 }),
        fc.array(step, { minLength: 1, maxLength: 12 }),
        fc.boolean(),
        fc.array(fc.nat(100), { maxLength: 10 }),
        (lines, steps, payFirst, order) => run(lines, steps, payFirst, order),
      ),
      { seed: 20261114, numRuns: 40, endOnFailure: true },
    );
  });

  it("holds the money laws for hostile fixed schedules", async () => {
    const S = (s: Step) => s;
    const schedules: Step[][] = [
      [S({ t: "refund", line: 0, amt: 500, fault: "lost", pend: true, announce: false }), S({ t: "transition", idx: 0, to: "failed" }), S({ t: "refund", line: 0, amt: 500, fault: "none", pend: false, announce: true }), S({ t: "replay", idx: 1 })],
      [S({ t: "dash", amt: 400, pend: true }), S({ t: "refund", line: 1, amt: 900, fault: "before5xx", pend: false, announce: true }), S({ t: "transition", idx: 0, to: "succeeded" }), S({ t: "transition", idx: 0, to: "failed" }), S({ t: "drain" })],
      [S({ t: "burst", line: 0, amt: 600, n: 4 }), S({ t: "rogue" }), S({ t: "refund", line: 0, amt: 100, fault: "reject", pend: false, announce: true }), S({ t: "replay", idx: 3 })],
    ];
    for (const steps of schedules)
      for (const payFirst of [true, false]) await run([1000, 2000, 1500], steps, payFirst, [3, 1, 2]);
    expect(true).toBe(true);
  });
});
