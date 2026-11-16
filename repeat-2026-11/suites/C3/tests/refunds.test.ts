// Refund path: bounds, partial and concurrent refunds, async outcomes, lost responses, crashes, dashboard refunds,
// stale and duplicate notices. Laws are asserted on stored state against the provider twin, not on HTTP bodies.
import { describe, expect, it } from "vitest";
import { assertBooks, COMBOS, paidOrder, sleep, type Stack, withStack } from "./harness.ts";

const refundOf = (s: Stack, orderId: string, lineId: string, amount: number | string) =>
  s.post(`/orders/${orderId}/refunds`, { line_id: lineId, amount });
const providerRefundTotal = (s: Stack) =>
  [...s.world.refunds.values()].filter((r) => !["failed", "canceled"].includes(r.status)).reduce((a, r) => a + r.amount, 0n);
const appStatus = (s: Stack, id: string) => s.scalar("SELECT status FROM orders WHERE id=$1", [id]);

describe.each(COMBOS)("refunds: $name", (combo) => {
  it("refunds part of a line: only that line's seller is debited and the platform keeps its commission", async () => {
    await withStack(combo, async (s) => {
      const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
      const r = await refundOf(s, o.id, o.lineIds[0]!, 250);
      expect(r.status).toBe(200);
      await s.deliverNew();
      await s.settle();
      expect(await appStatus(s, o.id)).toBe("partially_refunded");
      expect(await s.scalar("SELECT sum(amount) FROM ledger_entries WHERE kind='refund' AND account='seller:seller_a'")).toBe("250");
      expect(await s.scalar("SELECT count(*) FROM ledger_entries WHERE kind='refund' AND account='seller:seller_b'")).toBe("0");
      expect(await s.scalar("SELECT coalesce(sum(amount),0) FROM ledger_entries WHERE kind='refund' AND account LIKE 'platform:%'")).toBe("0");
      expect(providerRefundTotal(s)).toBe(250n);
      await assertBooks(s);
    });
  });

  it("S10 sequential partial refunds can never sum past the line, and exhausting every line marks the order refunded", async () => {
    await withStack(combo, async (s) => {
      const o = await paidOrder(s, [{ amount: 33300 }, { amount: 16700 }]);
      for (let i = 0; i < 3; i++) expect((await refundOf(s, o.id, o.lineIds[0]!, 11100)).status).toBe(200);
      const over = await refundOf(s, o.id, o.lineIds[0]!, 100);
      expect(over.status).toBeGreaterThanOrEqual(400);
      expect(over.status).toBeLessThan(500);
      expect((await refundOf(s, o.id, o.lineIds[1]!, 10000)).status).toBe(200);
      expect((await refundOf(s, o.id, o.lineIds[1]!, 6800)).status).toBeGreaterThanOrEqual(400);
      expect((await refundOf(s, o.id, o.lineIds[1]!, 6700)).status).toBe(200);
      await s.deliverNew();
      await s.settle();
      expect(providerRefundTotal(s)).toBe(50000n);
      expect(await appStatus(s, o.id)).toBe("refunded");
      expect((await refundOf(s, o.id, o.lineIds[0]!, 100)).status).toBeGreaterThanOrEqual(400);
      expect(s.calls("refund.create")).toHaveLength(5);
      await assertBooks(s);
    });
  });

  it("a refund above the line but within the order is rejected without calling the provider", async () => {
    await withStack(combo, async (s) => {
      const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
      const r = await refundOf(s, o.id, o.lineIds[1]!, 401);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expect(s.calls("refund.create")).toHaveLength(0);
      await assertBooks(s);
    });
  });

  it("invalid refund requests never reach the provider", async () => {
    await withStack(combo, async (s) => {
      const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
      const other = await paidOrder(s, [{ amount: 100 }]);
      const unpaid = await s.createOrder([{ amount: 100 }]);
      const bad: [string, string, unknown][] = [
        [o.id, o.lineIds[0]!, 0],
        [o.id, o.lineIds[0]!, -5],
        [o.id, o.lineIds[0]!, 1.5],
        [o.id, o.lineIds[0]!, "abc"],
        [o.id, o.lineIds[0]!, "1e3"],
        [o.id, o.lineIds[0]!, 9007199254740993n.toString()],
        [o.id, o.lineIds[0]!, null],
        [o.id, "no_such_line", 10],
        [o.id, other.lineIds[0]!, 10], // a line of another order
        [other.id, o.lineIds[0]!, 10],
        [unpaid.id, `${unpaid.id}_l1`, 10],
        ["ord_nonexistent", "x", 10],
      ];
      for (const [oid, lid, amt] of bad) {
        const r = await s.post(`/orders/${oid}/refunds`, { line_id: lid, amount: amt });
        expect(r.status, JSON.stringify([oid, lid, amt])).toBeGreaterThanOrEqual(400);
        expect(r.status, JSON.stringify([oid, lid, amt])).toBeLessThan(500);
      }
      expect(s.calls("refund.create")).toHaveLength(0);
      await assertBooks(s);
    });
  });

  it("every refund POST carries an idempotency key", async () => {
    await withStack(combo, async (s) => {
      const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
      await refundOf(s, o.id, o.lineIds[0]!, 100);
      await refundOf(s, o.id, o.lineIds[1]!, 100);
      const calls = s.calls("refund.create");
      expect(calls).toHaveLength(2);
      for (const c of calls) expect(c.idempotencyKey).toBeTruthy();
      expect(new Set(calls.map((c) => c.idempotencyKey)).size).toBe(2);
    });
  });

  if (combo.provider === "razorpay") {
    it("Razorpay INR refunds under the 100 paise minimum are refused locally", async () => {
      await withStack(combo, async (s) => {
        const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
        const r = await refundOf(s, o.id, o.lineIds[0]!, 99);
        expect(r.status).toBeGreaterThanOrEqual(400);
        expect(r.status).toBeLessThan(500);
        expect(s.calls("refund.create")).toHaveLength(0);
        expect((await refundOf(s, o.id, o.lineIds[0]!, 100)).status).toBe(200);
        await s.deliverNew();
        await s.settle();
        await assertBooks(s);
      });
    });
  } else {
    it("Stripe accepts a one minor unit refund", async () => {
      await withStack(combo, async (s) => {
        const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
        expect((await refundOf(s, o.id, o.lineIds[0]!, 1)).status).toBe(200);
        await s.deliverNew();
        await s.settle();
        await assertBooks(s);
      });
    });
  }

  it("S09 concurrent refunds on one line never exceed the line", async () => {
    await withStack(combo, async (s) => {
      const o = await paidOrder(s, [{ amount: 300 }, { amount: 700 }]);
      const rs = await Promise.all(Array.from({ length: 8 }, () => refundOf(s, o.id, o.lineIds[0]!, 100)));
      const ok = rs.filter((r) => r.status === 200 || r.status === 202).length;
      expect(ok).toBeLessThanOrEqual(3);
      await s.deliverNew();
      await s.settle({ allowUnknownRefunds: true });
      expect(providerRefundTotal(s)).toBeLessThanOrEqual(300n);
      await assertBooks(s, { allowUnsettledRefunds: true });
      await s.deliverNew();
      expect(Number(await s.scalar("SELECT coalesce(sum(amount),0) FROM refunds WHERE line_id=$1 AND status IN ('pending','requires_action','succeeded')", [o.lineIds[0]]))).toBeLessThanOrEqual(300);
    });
  });

  it("S09 two refunds that reach the provider at the very same moment are both accounted for (or one cleanly refused)", async () => {
    await withStack(combo, async (s) => {
      const o = await paidOrder(s, [{ amount: 300 }, { amount: 700 }]);
      s.fault({
        label: "rendezvous",
        match: (c) => c.op === "refund.create",
        hold: { barrier: "refunds", count: 2, timeoutMs: 8000, release: "together" },
        times: 2,
      });
      const rs = await Promise.all([refundOf(s, o.id, o.lineIds[0]!, 100), refundOf(s, o.id, o.lineIds[0]!, 100)]);
      for (const r of rs) expect(r.status).toBeLessThan(500);
      await s.deliverNew();
      await s.settle({ allowUnknownRefunds: true });
      await s.deliverNew();
      await assertBooks(s, { allowUnsettledRefunds: true });
      const appLive = Number(await s.scalar("SELECT count(*) FROM refunds WHERE status IN ('pending','requires_action','succeeded')"));
      expect(appLive).toBe([...s.world.refunds.values()].filter((r) => r.status !== "failed").length);
    });
  });

  it("S08 provider 5xx before anything is applied: no money moves, nothing is double counted, a retry works or is refused", async () => {
    await withStack(combo, async (s) => {
      const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
      s.faultOp("refund.create", { t: "fail_before_apply", status: 500 });
      const first = await refundOf(s, o.id, o.lineIds[0]!, 200);
      expect(first.status).not.toBe(200);
      expect(s.world.refunds.size).toBe(0);
      const retry = await refundOf(s, o.id, o.lineIds[0]!, 200);
      expect(retry.status).toBeLessThan(500 + 100);
      await s.deliverNew();
      await s.settle({ allowUnknownRefunds: true });
      expect(providerRefundTotal(s)).toBeLessThanOrEqual(200n);
      await assertBooks(s);
    });
  });

  it("a 429 on the refund call leaves no phantom refund in the books", async () => {
    await withStack(combo, async (s) => {
      const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
      s.faultOp("refund.create", { t: "fail_before_apply", status: 429 });
      const first = await refundOf(s, o.id, o.lineIds[0]!, 200);
      expect(first.status).not.toBe(200);
      await s.settle({ allowUnknownRefunds: true });
      expect(s.world.refunds.size).toBe(0);
      expect(await s.scalar("SELECT count(*) FROM ledger_entries WHERE kind='refund'")).toBe("0");
      await assertBooks(s);
    });
  });

  for (const fault of ["apply_then_500", "apply_then_reset", "apply_then_timeout"] as const) {
    it(`refund applied but the answer is lost (${fault}): exactly one provider refund, recognised once after the webhook`, async () => {
      await withStack(combo, async (s) => {
        const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
        s.faultOp("refund.create", fault === "apply_then_timeout" ? { t: fault, holdMs: 400 } : { t: fault }, 1);
        const first = await refundOf(s, o.id, o.lineIds[0]!, 600);
        expect(first.status).not.toBe(200);
        expect(s.world.refunds.size).toBe(1);
        // the whole line is spoken for: a user retrying the same refund must not create a second one
        const again = await refundOf(s, o.id, o.lineIds[0]!, 600);
        expect(again.status).toBeGreaterThanOrEqual(202);
        expect(s.world.refunds.size).toBe(1);
        // the provider's webhook tells the app what happened; the books converge
        await s.deliverNew();
        await s.settle();
        expect(s.world.refunds.size).toBe(1);
        await assertBooks(s);
        expect(await s.scalar("SELECT count(*) FROM refunds")).toBe("1");
        expect(await s.scalar("SELECT sum(amount) FROM ledger_entries WHERE kind='refund' AND account='seller:seller_a'")).toBe("600");
      });
    });
  }

  it("a lost refund response is never resent after the idempotency key expired (no second refund)", async () => {
    await withStack(combo, async (s) => {
      const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
      s.faultOp("refund.create", { t: "apply_then_reset" }, 1);
      await refundOf(s, o.id, o.lineIds[0]!, 600);
      expect(s.world.refunds.size).toBe(1);
      s.sim.expireIdempotencyKeys();
      await s.restart(); // recovery scans run at startup and on a timer
      await sleep(3500);
      expect(s.calls("refund.create").length).toBe(1);
      expect(s.world.refunds.size).toBe(1);
      await s.deliverNew();
      await s.settle();
      expect(s.world.refunds.size).toBe(1);
      await assertBooks(s);
    });
  });

  it("the app crashes while a refund is in flight: after restart there is one refund and the books agree", async () => {
    await withStack(combo, async (s) => {
      const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
      s.sim.onCrash = () => void s.crash();
      s.faultOp("refund.create", { t: "apply_then_crash" }, 1);
      await refundOf(s, o.id, o.lineIds[0]!, 250).catch(() => undefined);
      await sleep(300);
      await s.restart();
      await sleep(1500);
      expect(s.world.refunds.size).toBe(1);
      expect(s.calls("refund.create").length).toBe(1);
      await s.deliverNew();
      await s.settle();
      expect(s.world.refunds.size).toBe(1);
      await assertBooks(s);
    });
  });

  it("S03 a refund notice that arrives before the payment notice is retried, never lost or misbooked", async () => {
    await withStack(combo, async (s) => {
      const o = await s.createOrder([{ amount: 600 }, { amount: 400 }]);
      await s.checkout(o.id);
      const payEvents = s.pay(o.id);
      s.skipDelivery();
      s.act({ kind: "createRefund", paymentId: s.worldPaymentOf(o.id).id, amount: 150n, origin: "dashboard" });
      const refundEvents = s.world.events.slice(payEvents.length);
      s.skipDelivery();
      const early: number[] = [];
      for (const e of refundEvents) for (const r of await s.deliverAll(e)) early.push(r.status);
      await sleep(300);
      for (const e of payEvents) await s.deliverAll(e);
      await s.settle();
      // the provider retries whatever was not acknowledged with a 2xx
      for (const e of refundEvents) await s.deliverAll(e);
      await s.settle();
      expect(await s.scalar("SELECT count(*) FROM refunds")).toBe("1");
      expect(await appStatus(s, o.id)).toBe("partially_refunded");
      await assertBooks(s);
    });
  });

  it("S04 a stale pending notice delivered after the final one does not regress the refund", async () => {
    await withStack({ ...combo, refunds: "async" }, async (s) => {
      const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
      const r = await refundOf(s, o.id, o.lineIds[0]!, 200);
      expect(r.status).toBeLessThan(300);
      const rid = s.dialect.fromWireId(String(r.body.provider_refund_id));
      s.act({ kind: "settleRefund", refundId: rid, outcome: "succeeded" });
      const events = s.world.events.filter((e) => e.refund?.id === rid);
      const final = events[events.length - 1]!;
      const stale = events[0]!;
      s.skipDelivery();
      await s.deliverAll(final);
      await s.settle();
      await s.deliverAll(stale);
      await s.deliverAll(stale);
      await s.settle();
      expect(await s.scalar("SELECT status FROM refunds")).toBe("succeeded");
      expect(await s.scalar("SELECT count(*) FROM ledger_entries WHERE kind='refund' AND account='provider:clearing'")).toBe("1");
      await assertBooks(s);
    });
  });

  it("S13 a refund accepted as pending that later fails is reversed exactly once and its capacity is released", async () => {
    await withStack({ ...combo, refunds: "async" }, async (s) => {
      const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
      const r = await refundOf(s, o.id, o.lineIds[0]!, 600);
      expect(r.status).toBeLessThan(300);
      await s.deliverNew();
      await s.settle();
      // pending refunds hold the line: the same line cannot be refunded again meanwhile
      expect((await refundOf(s, o.id, o.lineIds[0]!, 1)).status).toBeGreaterThanOrEqual(400);
      expect(await appStatus(s, o.id)).toBe("partially_refunded");
      const rid = s.dialect.fromWireId(String(r.body.provider_refund_id));
      s.act({ kind: "settleRefund", refundId: rid, outcome: "failed" });
      await s.deliverNew();
      await s.deliverNew();
      await s.settle();
      expect(await s.scalar("SELECT status FROM refunds")).toBe("failed");
      expect(await s.scalar("SELECT coalesce(sum(amount),0) FROM ledger_entries WHERE kind IN ('refund','refund_reversal') AND account='seller:seller_a'")).toBe("0");
      expect(await appStatus(s, o.id)).toBe("paid");
      // the failure released the capacity: the line can be refunded again
      const again = await refundOf(s, o.id, o.lineIds[0]!, 600);
      expect(again.status).toBeLessThan(300);
      const rid2 = s.dialect.fromWireId(String(again.body.provider_refund_id));
      s.act({ kind: "settleRefund", refundId: rid2, outcome: "succeeded" });
      await s.deliverNew();
      await s.settle();
      expect(await s.scalar("SELECT sum(amount) FROM ledger_entries WHERE kind IN ('refund','refund_reversal') AND account='seller:seller_a'")).toBe("600");
      await assertBooks(s);
    });
  });

  it("a failure notice redelivered many times (also concurrently) reverses once", async () => {
    await withStack({ ...combo, refunds: "async" }, async (s) => {
      const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
      const r = await refundOf(s, o.id, o.lineIds[0]!, 300);
      const rid = s.dialect.fromWireId(String(r.body.provider_refund_id));
      s.act({ kind: "settleRefund", refundId: rid, outcome: "failed" });
      const evs = s.world.events.filter((e) => e.refund?.id === rid);
      const last = evs[evs.length - 1]!;
      s.skipDelivery();
      await Promise.all(Array.from({ length: 6 }, () => s.deliverAll(last)));
      await s.deliverAll(last);
      await s.settle();
      await s.deliverAll(last);
      await s.settle();
      expect(await s.scalar("SELECT count(*) FROM ledger_entries WHERE kind='refund_reversal'")).not.toBe("0");
      expect(await s.scalar("SELECT coalesce(sum(amount),0) FROM ledger_entries WHERE kind IN ('refund','refund_reversal')")).toBe("0");
      await assertBooks(s);
    });
  });

  it("a canceled refund (Stripe) or processed one (Razorpay) after pending leaves consistent books", async () => {
    await withStack({ ...combo, refunds: "async" }, async (s) => {
      const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
      const r = await refundOf(s, o.id, o.lineIds[1]!, 250);
      const rid = s.dialect.fromWireId(String(r.body.provider_refund_id));
      s.act({ kind: "settleRefund", refundId: rid, outcome: combo.provider === "stripe" ? "canceled" : "succeeded" });
      await s.deliverNew();
      await s.settle();
      await assertBooks(s);
    });
  });

  it("dashboard refunds are recorded once, whoever delivers the notice and however often", async () => {
    await withStack(combo, async (s) => {
      const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
      const pid = s.worldPaymentOf(o.id).id;
      s.act({ kind: "createRefund", paymentId: pid, amount: 300n, origin: "dashboard" });
      const evs = s.world.events.filter((e) => e.refund);
      s.skipDelivery();
      for (const e of evs) await Promise.all([s.deliverAll(e), s.deliverAll(e), s.deliverAll(e)]);
      await s.settle();
      for (const e of evs) await s.deliverAll(e);
      await s.settle();
      expect(await s.scalar("SELECT count(*) FROM refunds")).toBe("1");
      expect(await s.scalar("SELECT origin FROM refunds")).toBe("provider");
      expect(await s.scalar("SELECT count(*) FROM ledger_entries WHERE kind='refund' AND account='provider:clearing'")).toBe("1");
      expect(await appStatus(s, o.id)).toBe("partially_refunded");
      await assertBooks(s);
    });
  });

  it("refunds made in the dashboard count against what the app may refund afterwards", async () => {
    await withStack(combo, async (s) => {
      const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
      s.act({ kind: "createRefund", paymentId: s.worldPaymentOf(o.id).id, amount: 900n, origin: "dashboard" });
      await s.deliverNew();
      await s.settle();
      const r = await refundOf(s, o.id, o.lineIds[1]!, 200);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expect(providerRefundTotal(s)).toBe(900n);
      expect((await refundOf(s, o.id, o.lineIds[1]!, 100)).status).toBe(200);
      await s.deliverNew();
      await s.settle();
      expect(await appStatus(s, o.id)).toBe("refunded");
      await assertBooks(s);
    });
  });

  it("when the provider refuses an over refund the app records the refusal, not a refund", async () => {
    await withStack(combo, async (s) => {
      const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
      // a dashboard refund the app has not heard about yet takes most of the payment
      s.act({ kind: "createRefund", paymentId: s.worldPaymentOf(o.id).id, amount: 900n, origin: "dashboard" });
      s.skipDelivery();
      const r = await refundOf(s, o.id, o.lineIds[1]!, 400);
      expect(r.status).not.toBe(200);
      expect(providerRefundTotal(s)).toBe(900n);
      for (const e of s.world.events.filter((x) => x.refund)) await s.deliverAll(e);
      await s.settle({ allowUnknownRefunds: true });
      await assertBooks(s, { allowUnsettledRefunds: true });
      expect(await s.scalar("SELECT count(*) FROM refunds")).toBe("1");
      expect(await s.scalar("SELECT coalesce(sum(amount),0) FROM ledger_entries WHERE account='provider:clearing'")).toBe("100");
    });
  });

  if (combo.provider === "stripe") {
    it("a succeeded refund that reverts to requires_action stays recognised, and does not leak money", async () => {
      await withStack(combo, async (s) => {
        const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
        const r = await refundOf(s, o.id, o.lineIds[0]!, 200);
        const rid = s.dialect.fromWireId(String(r.body.provider_refund_id));
        s.act({ kind: "revertRefund", refundId: rid, to: "requires_action" });
        await s.deliverNew();
        await s.settle();
        expect(await s.scalar("SELECT status FROM refunds")).toBe("requires_action");
        expect(await s.scalar("SELECT count(*) FROM ledger_entries WHERE kind='refund' AND account='provider:clearing'")).toBe("1");
        expect((await refundOf(s, o.id, o.lineIds[0]!, 401)).status).toBeGreaterThanOrEqual(400);
        await assertBooks(s);
      });
    });
  }

  it("refunds of every line in several pieces, on odd amounts, balance to the minor unit", async () => {
    await withStack(combo, async (s) => {
      const o = await paidOrder(s, [{ amount: 100100 }, { amount: 300 }, { amount: 99900 }]);
      const plan: [number, number][] = [[0, 33300], [0, 33400], [0, 33400], [1, 100], [1, 200], [2, 50000], [2, 49900]];
      for (const [li, amt] of plan) expect((await refundOf(s, o.id, o.lineIds[li]!, amt)).status).toBe(200);
      await s.deliverNew();
      await s.settle();
      expect(await appStatus(s, o.id)).toBe("refunded");
      expect(await s.scalar("SELECT coalesce(sum(amount),0) FROM ledger_entries WHERE account='provider:clearing'")).toBe("0");
      await assertBooks(s);
    });
  });
});
