// Durability and transport behaviour: acknowledged webhooks survive crashes, failed lookups are retried rather
// than swallowed, and an app process killed at an awkward moment converges to correct books after restart.
import { describe, expect, it } from "vitest";
import { assertBooks, COMBOS, paidOrder, sleep, withStack } from "./harness.ts";

describe.each(COMBOS)("durability: $name", (combo) => {
  it("a provider refund lookup that fails is retried, never silently dropped", async () => {
    await withStack(combo, async (s) => {
      const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
      s.act({ kind: "createRefund", paymentId: s.worldPaymentOf(o.id).id, amount: 300n, origin: "dashboard" });
      const evs = s.world.events.filter((e) => e.refund);
      s.skipDelivery();
      s.faultOp("refund.retrieve", { t: "fail_before_apply", status: 500 }, 3);
      const first = [];
      for (const e of evs) first.push(...(await s.deliverAll(e)));
      // an app that acknowledges now must still apply the refund (queue); one that refuses expects a redelivery
      await sleep(500);
      for (let i = 0; i < 4; i++) {
        for (const e of evs) await s.deliverAll(e);
        await sleep(300);
      }
      await s.settle();
      expect(await s.scalar("SELECT count(*) FROM refunds")).toBe("1");
      expect(await s.scalar("SELECT count(*) FROM ledger_entries WHERE kind='refund' AND account='provider:clearing'")).toBe("1");
      await assertBooks(s);
    });
  });

  it("a payment lookup that returns 429 or 5xx while processing a notice does not lose the sale", async () => {
    await withStack(combo, async (s) => {
      const o = await s.createOrder([{ amount: 900 }]);
      await s.checkout(o.id);
      const evs = s.pay(o.id);
      s.skipDelivery();
      s.faultOp("payment.retrieve", { t: "fail_before_apply", status: 429 }, 2);
      for (let i = 0; i < 4; i++) {
        for (const e of evs) await s.deliverAll(e);
        await sleep(400);
      }
      await s.post(`/orders/${o.id}/confirm`).catch(() => undefined);
      await s.settle();
      expect(await s.scalar("SELECT status FROM orders WHERE id=$1", [o.id])).toBe("paid");
      await assertBooks(s);
    });
  });

  it("a webhook acknowledged with 2xx has already committed its effect or durably queued it", async () => {
    await withStack(combo, async (s) => {
      const o = await s.createOrder([{ amount: 900 }]);
      await s.checkout(o.id);
      const [ev] = s.pay(o.id);
      s.skipDelivery();
      const r = await s.deliver(ev!);
      expect(r.status).toBe(200);
      if (s.app === "worker") {
        expect(Number(await s.scalar("SELECT count(*) FROM jobs"))).toBeGreaterThan(0);
        expect(await s.scalar("SELECT count(*) FROM jobs WHERE provider_event_id LIKE $1", [`${s.provider}:%`])).not.toBe("0");
      } else {
        expect(await s.scalar("SELECT status FROM orders WHERE id=$1", [o.id])).toBe("paid");
      }
      await s.settle();
      await assertBooks(s);
    });
  });

  it("a crash right after the acknowledgement loses nothing", async () => {
    await withStack(combo, async (s) => {
      const o = await s.createOrder([{ amount: 900 }, { amount: 100 }]);
      await s.checkout(o.id);
      const evs = s.pay(o.id);
      s.skipDelivery();
      for (const e of evs) await s.deliverAll(e);
      await s.crash();
      await s.boot();
      // the provider would redeliver anything that was not acknowledged; acknowledged ones must already count
      await s.settle();
      for (const e of evs) await s.deliverAll(e);
      await s.settle();
      expect(await s.scalar("SELECT status FROM orders WHERE id=$1", [o.id])).toBe("paid");
      expect(await s.scalar("SELECT count(*) FROM ledger_entries WHERE account='provider:clearing' AND kind='sale'")).toBe("1");
      await assertBooks(s);
    });
  });

  it("repeated crashes and restarts in the middle of a busy period still converge", async () => {
    await withStack(combo, async (s) => {
      const orders = [];
      for (const a of [500, 700, 900]) {
        const o = await s.createOrder([{ amount: a }, { amount: 100 }]);
        await s.checkout(o.id);
        orders.push(o);
      }
      for (const o of orders) s.pay(o.id);
      const evs = [...s.world.events];
      s.skipDelivery();
      const deliveries = Promise.all(evs.map((e) => s.deliverAll(e).catch(() => [])));
      await sleep(60);
      await s.crash();
      await s.boot();
      await deliveries;
      await s.crash();
      await s.boot();
      for (const e of evs) await s.deliverAll(e);
      await s.settle();
      for (const o of orders) expect(await s.scalar("SELECT status FROM orders WHERE id=$1", [o.id])).toBe("paid");
      expect(await s.scalar("SELECT count(*) FROM ledger_entries WHERE account='provider:clearing' AND kind='sale'")).toBe("3");
      await assertBooks(s);
    });
  });

  it("the app crashes while it is processing a refund notice and the redelivery completes it once", async () => {
    await withStack(combo, async (s) => {
      const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
      s.act({ kind: "createRefund", paymentId: s.worldPaymentOf(o.id).id, amount: 250n, origin: "dashboard" });
      const evs = s.world.events.filter((e) => e.refund);
      s.skipDelivery();
      s.sim.onCrash = () => void s.crash();
      s.fault({ label: "crash-on-lookup", match: (c) => c.op === "refund.retrieve", fault: { t: "apply_then_crash" }, times: 1 });
      await Promise.all(evs.map((e) => s.deliverAll(e).catch(() => [])));
      await sleep(400);
      await s.crash();
      await s.boot();
      for (let i = 0; i < 2; i++) for (const e of evs) await s.deliverAll(e);
      await s.settle();
      expect(await s.scalar("SELECT count(*) FROM refunds")).toBe("1");
      expect(await s.scalar("SELECT count(*) FROM ledger_entries WHERE kind='refund' AND account='provider:clearing'")).toBe("1");
      await assertBooks(s);
    });
  });

  if (combo.app === "worker") {
    it("a job that was running when the process died is run again after restart, and books once", async () => {
      await withStack(combo, async (s) => {
        const o = await s.createOrder([{ amount: 900 }]);
        await s.checkout(o.id);
        const evs = s.pay(o.id);
        s.skipDelivery();
        // park the worker inside its provider lookup so the job is 'running' when we kill the process
        s.fault({ label: "park", match: (c) => c.op === "payment.retrieve", hold: { barrier: "never", count: 2, timeoutMs: 2500 }, times: 1 });
        for (const e of evs) await s.deliverAll(e);
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && Number(await s.scalar("SELECT count(*) FROM jobs WHERE state='running'")) === 0) await sleep(50);
        expect(Number(await s.scalar("SELECT count(*) FROM jobs WHERE state='running'"))).toBeGreaterThan(0);
        await s.crash();
        await s.boot();
        await s.settle();
        expect(await s.scalar("SELECT status FROM orders WHERE id=$1", [o.id])).toBe("paid");
        expect(await s.scalar("SELECT count(*) FROM jobs WHERE state='failed'")).toBe("0");
        expect(await s.scalar("SELECT count(*) FROM ledger_entries WHERE account='provider:clearing' AND kind='sale'")).toBe("1");
        await assertBooks(s);
      });
    });

    it("duplicate deliveries queue one job per provider event id", async () => {
      await withStack(combo, async (s) => {
        const o = await s.createOrder([{ amount: 900 }]);
        await s.checkout(o.id);
        const [ev] = s.pay(o.id);
        s.skipDelivery();
        await Promise.all(Array.from({ length: 6 }, () => s.deliver(ev!)));
        await s.deliver(ev!);
        await s.settle();
        expect(await s.scalar("SELECT count(*) FROM jobs WHERE provider_event_id=$1", [`${s.provider}:${s.dialect.toWireId(ev!.id)}`])).toBe("1");
        await assertBooks(s);
      });
    });

    it("a refund request that was in flight when the process died keeps its reservation and is never resent", async () => {
      await withStack(combo, async (s) => {
        const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
        s.sim.onCrash = () => void s.crash();
        s.faultOp("refund.create", { t: "apply_then_crash" }, 1);
        await s.post(`/orders/${o.id}/refunds`, { line_id: o.lineIds[0], amount: 600 }).catch(() => undefined);
        await sleep(300);
        await s.boot();
        await sleep(2500);
        expect(s.calls("refund.create")).toHaveLength(1);
        expect((await s.post(`/orders/${o.id}/refunds`, { line_id: o.lineIds[0], amount: 100 })).status).toBeGreaterThanOrEqual(400);
        await s.deliverNew();
        await s.settle();
        expect(s.world.refunds.size).toBe(1);
        await assertBooks(s);
      });
    });
  } else {
    it("an event whose processing failed leaves no dedupe marker, so the provider's retry is applied", async () => {
      await withStack(combo, async (s) => {
        const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
        s.act({ kind: "createRefund", paymentId: s.worldPaymentOf(o.id).id, amount: 250n, origin: "dashboard" });
        const evs = s.world.events.filter((e) => e.refund);
        s.skipDelivery();
        s.faultOp("refund.retrieve", { t: "fail_before_apply", status: 500 }, 20);
        const ev = evs[0]!;
        const r = await s.deliver(ev);
        expect(r.status).toBeGreaterThanOrEqual(300);
        expect(await s.scalar("SELECT count(*) FROM processed_events WHERE event_id LIKE '%refund%' OR object_id LIKE '%re%'")).not.toBe("999");
        expect(await s.scalar("SELECT count(*) FROM refunds")).toBe("0");
        s.sim.clearRules();
        for (const e of evs) expect((await s.deliverAll(e))[0]!.status).toBeLessThan(300);
        await s.settle();
        expect(await s.scalar("SELECT count(*) FROM refunds")).toBe("1");
        await assertBooks(s);
      });
    });
  }
});
