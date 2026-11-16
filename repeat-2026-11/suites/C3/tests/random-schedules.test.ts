// Seeded randomised adversarial schedules. A small, deterministic PRNG picks interleavings of orders, payments
// (success, decline, manual capture), refunds (valid and over limit, with lost responses and 5xx), dashboard refunds,
// asynchronous refund outcomes, and webhook delivery that is partial, duplicated and reordered. After the schedule the
// provider "retries" every notice and the books must satisfy all the money laws. Same seed, same schedule.
import { describe, expect, it } from "vitest";
import { assertBooks, COMBOS, type Stack, withStack } from "./harness.ts";

function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T,
    chance: (p: number) => next() < p,
    shuffle: <T>(xs: T[]): T[] => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j] as T, out[i] as T];
      }
      return out;
    },
  };
}

interface Ord {
  id: string;
  lineIds: string[];
  amounts: number[];
  paid: boolean;
  manual: boolean;
  authorised: boolean;
}

async function schedule(s: Stack, seed: number) {
  const rnd = prng(seed);
  const orders: Ord[] = [];
  const pendingEvents = () => s.world.events.slice(s.delivered);
  const undeliveredLater: number[] = [];
  void undeliveredLater;
  const steps = 22;
  for (let i = 0; i < steps; i++) {
    const action = rnd.pick(["order", "order", "pay", "pay", "refund", "refund", "refund", "dash", "settleRefund", "deliver", "deliver", "capture"] as const);
    if (action === "order" || orders.length === 0) {
      const n = rnd.int(1, 3);
      const amounts = Array.from({ length: n }, () => rnd.int(2, 60) * 100 + rnd.pick([0, 0, 0, 1, 7, 33]));
      const manual = rnd.chance(0.25);
      const o = await s.createOrder(amounts.map((amount) => ({ amount })), { capture: manual ? "manual" : "automatic" });
      const co = await s.checkout(o.id);
      if (co.status !== 200) continue;
      orders.push({ id: o.id, lineIds: o.lineIds, amounts, paid: false, manual, authorised: false });
      continue;
    }
    const o = rnd.pick(orders);
    if (action === "pay") {
      if (o.paid || s.worldPayments(o.id).length !== 1) continue;
      const outcome = rnd.chance(0.25) ? "decline" : "success";
      s.pay(o.id, outcome);
      if (outcome === "success") {
        if (o.manual) o.authorised = true;
        else o.paid = true;
      }
    } else if (action === "capture") {
      if (!o.manual || !o.authorised || o.paid) continue;
      const r = await s.post(`/orders/${o.id}/capture`);
      if (r.status === 200) o.paid = true;
    } else if (action === "refund") {
      const li = rnd.int(0, o.lineIds.length - 1);
      const amount = rnd.int(1, 40) * 100;
      const f = rnd.next();
      if (f < 0.12) s.faultOp("refund.create", { t: "fail_before_apply", status: 500 });
      else if (f < 0.24) s.faultOp("refund.create", { t: "apply_then_reset" });
      else if (f < 0.34) s.faultOp("refund.create", { t: "apply_then_500" });
      await s.post(`/orders/${o.id}/refunds`, { line_id: o.lineIds[li], amount });
      s.sim.clearRules();
    } else if (action === "dash") {
      const p = s.worldPayments(o.id)[0];
      if (!p || p.amountCaptured === 0n) continue;
      const room = p.amountCaptured - p.amountRefunded;
      if (room < 100n) continue;
      s.act({ kind: "createRefund", paymentId: p.id, amount: BigInt(rnd.int(1, Math.max(1, Math.floor(Number(room) / 100))) * 100), origin: "dashboard" });
    } else if (action === "settleRefund") {
      const pend = [...s.world.refunds.values()].filter((r) => r.status === "pending");
      if (!pend.length) continue;
      s.act({ kind: "settleRefund", refundId: rnd.pick(pend).id, outcome: rnd.chance(0.5) ? "succeeded" : "failed" });
    } else if (action === "deliver") {
      const evs = rnd.shuffle(pendingEvents()).slice(0, rnd.int(1, 4));
      for (const e of evs) {
        await s.deliverAll(e);
        if (rnd.chance(0.3)) await s.deliverAll(e);
      }
    }
  }
  // the provider keeps retrying everything it ever sent, in arbitrary order, until acknowledged
  for (let round = 0; round < 3; round++) {
    for (const e of rnd.shuffle([...s.world.events])) await s.deliverAll(e);
    await s.settle({ allowUnknownRefunds: true });
  }
  for (const o of orders) if (o.manual && o.authorised && !o.paid) await s.post(`/orders/${o.id}/confirm`).catch(() => undefined);
}

describe.each(COMBOS)("random adversarial schedules: $name", (combo) => {
  for (const seed of [11, 23, 37, 101]) {
    for (const refunds of ["immediate", "async"] as const) {
      it(`seed ${seed} with ${refunds} refund settlement ends with correct books`, async () => {
        await withStack({ ...combo, refunds }, async (s) => {
          await schedule(s, seed);
          // refunds left unknown by a lost response are only closed by the provider's own notice, which was resent
          const unresolved =
            s.app === "inline"
              ? Number(await s.scalar("SELECT count(*) FROM refund_requests WHERE NOT resolved AND post_started = false AND ambiguity_history = false"))
              : 0;
          expect(unresolved).toBe(0);
          await assertBooks(s);
          expect([...s.world.payments.values()].every((p) => p.amountRefunded <= p.amountCaptured)).toBe(true);
        });
      });
    }
  }
});
