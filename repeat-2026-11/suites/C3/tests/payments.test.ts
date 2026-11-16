// Payment path: checkout, capture, webhooks (duplicate, concurrent, forged, reordered, dropped), commission split.
// Every scenario ends by auditing the app's books against the provider twin's ground truth (assertBooks).
import { describe, expect, it } from "vitest";
import { assertBooks, COMBOS, paidOrder, sleep, withStack } from "./harness.ts";

const halfEven = (n: bigint, d: bigint) => {
  const q = n / d;
  const r = n % d;
  return r * 2n > d || (r * 2n === d && q % 2n === 1n) ? q + 1n : q;
};

describe.each(COMBOS)("payments: $name", (combo) => {
  it("books a captured payment once: clearing debit equals sellers plus 10% commission", async () => {
    await withStack(combo, async (s) => {
      const o = await paidOrder(s, [{ amount: 600 }, { amount: 400 }]);
      expect(await s.scalar("SELECT status FROM orders WHERE id=$1", [o.id])).toBe("paid");
      expect(await s.scalar("SELECT coalesce(sum(amount),0) FROM ledger_entries WHERE account='provider:clearing'")).toBe("1000");
      expect(await s.scalar("SELECT coalesce(sum(-amount),0) FROM ledger_entries WHERE kind='commission'")).toBe("100");
      expect(await s.scalar("SELECT coalesce(sum(-amount),0) FROM ledger_entries WHERE account='seller:seller_a'")).toBe("540");
      await assertBooks(s);
    });
  });

  it("splits odd amounts with half-even rounding and loses no minor unit", async () => {
    await withStack(combo, async (s) => {
      const amounts = [1, 5, 15, 25, 33, 105, 999_999];
      const o = await paidOrder(s, amounts.map((amount) => ({ amount })));
      const fee = amounts.reduce((a, x) => a + halfEven(BigInt(x) * 1000n, 10000n), 0n);
      expect(BigInt(await s.scalar("SELECT coalesce(sum(-amount),0) FROM ledger_entries WHERE kind='commission'"))).toBe(fee);
      const total = amounts.reduce((a, x) => a + x, 0);
      expect(await s.scalar("SELECT coalesce(sum(-amount),0) FROM ledger_entries WHERE kind IN ('sale','commission') AND account<>'provider:clearing'")).toBe(String(total));
      expect(o.total).toBe(BigInt(total));
      await assertBooks(s);
    });
  });

  it("S01 a webhook redelivered with the same event id posts once", async () => {
    await withStack(combo, async (s) => {
      const o = await s.createOrder([{ amount: 700 }, { amount: 300 }]);
      await s.checkout(o.id);
      const [ev] = s.pay(o.id);
      for (let i = 0; i < 4; i++) {
        const rs = await s.deliverAll(ev!);
        for (const r of rs) expect(r.status).toBe(200);
      }
      await s.settle();
      expect(await s.scalar("SELECT count(*) FROM ledger_entries WHERE account='provider:clearing'")).toBe("1");
      await assertBooks(s);
    });
  });

  it("S02 concurrent deliveries of the same event post once", async () => {
    await withStack(combo, async (s) => {
      const o = await s.createOrder([{ amount: 700 }, { amount: 300 }]);
      await s.checkout(o.id);
      const [ev] = s.pay(o.id);
      const rs = await Promise.all(Array.from({ length: 8 }, () => s.deliver(ev!)));
      // a concurrent duplicate may be asked to retry (non 2xx) but must never double post
      for (const r of rs) expect([200, 409, 503]).toContain(r.status);
      await s.deliver(ev!); // the provider's retry
      await s.settle();
      expect(await s.scalar("SELECT count(*) FROM ledger_entries WHERE account='provider:clearing' AND kind='sale'")).toBe("1");
      await assertBooks(s);
    });
  });

  it("the same change under a fresh event id (Stripe's duplicate event objects) does not double post", async () => {
    await withStack(combo, async (s) => {
      const o = await s.createOrder([{ amount: 700 }, { amount: 300 }]);
      await s.checkout(o.id);
      const [ev] = s.pay(o.id);
      await s.deliver(ev!, { sibling: 0 });
      await s.deliver(ev!, { sibling: 7 });
      await s.deliver(ev!, { sibling: 8 });
      await s.settle();
      expect(await s.scalar("SELECT count(*) FROM ledger_entries WHERE account='provider:clearing' AND kind='sale'")).toBe("1");
      await assertBooks(s);
    });
  });

  it("return-from-checkout (confirm) and the webhook together book once, in either order", async () => {
    await withStack(combo, async (s) => {
      const a = await s.createOrder([{ amount: 500 }]);
      const b = await s.createOrder([{ amount: 500 }]);
      await s.checkout(a.id);
      await s.checkout(b.id);
      const evA = s.pay(a.id);
      const evB = s.pay(b.id);
      expect((await s.post(`/orders/${a.id}/confirm`)).status).toBe(200);
      for (const e of evA) await s.deliverAll(e);
      for (const e of evB) await s.deliverAll(e);
      expect((await s.post(`/orders/${b.id}/confirm`)).status).toBe(200);
      expect((await s.post(`/orders/${b.id}/confirm`)).status).toBe(200);
      s.skipDelivery();
      await s.settle();
      expect(await s.scalar("SELECT count(*) FROM ledger_entries WHERE account='provider:clearing' AND kind='sale'")).toBe("2");
      await assertBooks(s);
    });
  });

  it("S05 a dropped payment webhook is recovered by the buyer return, and the late webhook then changes nothing", async () => {
    await withStack(combo, async (s) => {
      const o = await s.createOrder([{ amount: 800 }]);
      await s.checkout(o.id);
      const evs = s.pay(o.id);
      s.skipDelivery(); // the provider's delivery never got through
      expect(await s.scalar("SELECT status FROM orders WHERE id=$1", [o.id])).not.toBe("paid");
      expect((await s.post(`/orders/${o.id}/confirm`)).status).toBe(200);
      await s.settle();
      expect(await s.scalar("SELECT status FROM orders WHERE id=$1", [o.id])).toBe("paid");
      for (const e of evs) await s.deliverAll(e); // the provider retries much later
      await s.settle();
      expect(await s.scalar("SELECT count(*) FROM ledger_entries WHERE account='provider:clearing' AND kind='sale'")).toBe("1");
      await assertBooks(s);
    });
  });

  it("an order is not paid by a declined attempt, and is paid once by the later success", async () => {
    await withStack(combo, async (s) => {
      const o = await s.createOrder([{ amount: 900 }]);
      await s.checkout(o.id);
      s.pay(o.id, "decline");
      await s.deliverNew();
      await s.settle();
      expect(await s.scalar("SELECT status FROM orders WHERE id=$1", [o.id])).not.toBe("paid");
      expect(await s.scalar("SELECT count(*) FROM ledger_entries")).toBe("0");
      s.pay(o.id, "success");
      await s.deliverNew();
      await s.settle();
      expect(await s.scalar("SELECT status FROM orders WHERE id=$1", [o.id])).toBe("paid");
      await assertBooks(s);
    });
  });

  it("a stale failure notice delivered after the success does not unpay the order", async () => {
    await withStack(combo, async (s) => {
      const o = await s.createOrder([{ amount: 900 }]);
      await s.checkout(o.id);
      const failed = s.pay(o.id, "decline");
      const ok = s.pay(o.id, "success");
      for (const e of ok) await s.deliverAll(e);
      for (const e of failed) await s.deliverAll(e); // late and stale
      s.skipDelivery();
      await s.settle();
      expect(await s.scalar("SELECT status FROM orders WHERE id=$1", [o.id])).toBe("paid");
      await assertBooks(s);
    });
  });

  it("fan-out events of one capture delivered in reverse order book once", async () => {
    await withStack(combo, async (s) => {
      const o = await s.createOrder([{ amount: 450 }, { amount: 550 }]);
      await s.checkout(o.id);
      const [ev] = s.pay(o.id);
      const types = s.dialect.siblings?.(ev!, 2, new Set()) ?? [];
      const order = types.map((type, i) => ({ type, i })).reverse();
      for (const { type, i } of order) await s.deliver(ev!, { sibling: i, type });
      s.skipDelivery();
      await s.settle();
      expect(await s.scalar("SELECT count(*) FROM ledger_entries WHERE account='provider:clearing' AND kind='sale'")).toBe("1");
      await assertBooks(s);
    });
  });

  it("S11 a client that double submits checkout never creates a second provider payment", async () => {
    await withStack(combo, async (s) => {
      const o = await s.createOrder([{ amount: 1200 }]);
      const rs = await Promise.all(Array.from({ length: 6 }, () => s.checkout(o.id)));
      expect(rs.some((r) => r.status === 200)).toBe(true);
      await s.checkout(o.id);
      expect(s.worldPayments(o.id)).toHaveLength(1);
      s.pay(o.id);
      await s.deliverNew();
      await s.settle();
      await assertBooks(s);
    });
  });

  it("a checkout whose response was lost never leads to a second provider payment", async () => {
    await withStack(combo, async (s) => {
      const o = await s.createOrder([{ amount: 1200 }]);
      s.faultOp("payment.create", { t: "apply_then_reset" });
      const first = await s.checkout(o.id);
      expect(first.status).not.toBe(200);
      for (let i = 0; i < 3; i++) await s.checkout(o.id);
      expect(s.worldPayments(o.id).length).toBeLessThanOrEqual(1);
      // whatever the app did, the buyer can still pay and the order is paid exactly once
      if (s.worldPayments(o.id).length === 1) {
        s.pay(o.id);
        await s.deliverNew();
        await s.settle();
      }
      await assertBooks(s);
    });
  });

  it("a checkout that failed before reaching the provider can be retried without losing or duplicating money", async () => {
    await withStack(combo, async (s) => {
      const o = await s.createOrder([{ amount: 1200 }]);
      s.faultOp("payment.create", { t: "fail_before_apply", status: 500 });
      expect((await s.checkout(o.id)).status).not.toBe(200);
      for (let i = 0; i < 3; i++) await s.checkout(o.id);
      expect(s.worldPayments(o.id).length).toBeLessThanOrEqual(1);
      if (s.worldPayments(o.id).length === 1) {
        s.pay(o.id);
        await s.deliverNew();
        await s.settle();
      }
      await assertBooks(s);
    });
  });

  it("manual capture: authorisation alone books nothing, capture books once, a repeated capture request changes nothing", async () => {
    await withStack(combo, async (s) => {
      const o = await s.createOrder([{ amount: 500 }, { amount: 500 }], { capture: "manual" });
      await s.checkout(o.id);
      s.pay(o.id);
      await s.deliverNew();
      await s.settle();
      expect(await s.scalar("SELECT count(*) FROM ledger_entries")).toBe("0");
      expect(await s.scalar("SELECT status FROM orders WHERE id=$1", [o.id])).not.toBe("paid");
      expect((await s.post(`/orders/${o.id}/capture`)).status).toBe(200);
      await s.deliverNew();
      await s.settle();
      const again = await s.post(`/orders/${o.id}/capture`);
      expect([200, 409, 502]).toContain(again.status);
      await s.deliverNew();
      await s.settle();
      expect(await s.scalar("SELECT status FROM orders WHERE id=$1", [o.id])).toBe("paid");
      expect(await s.scalar("SELECT count(*) FROM ledger_entries WHERE account='provider:clearing' AND kind='sale'")).toBe("1");
      await assertBooks(s);
    });
  });

  it("S06 capture applied but the response is lost on every retry: the order ends paid, booked once", async () => {
    await withStack(combo, async (s) => {
      const o = await s.createOrder([{ amount: 500 }, { amount: 500 }], { capture: "manual" });
      await s.checkout(o.id);
      s.pay(o.id);
      await s.deliverNew();
      await s.settle();
      s.faultOp("payment.capture", { t: "apply_then_reset" }, 4);
      const first = await s.post(`/orders/${o.id}/capture`);
      expect(first.status).not.toBe(200);
      await s.post(`/orders/${o.id}/capture`).catch(() => undefined);
      await s.deliverNew(); // the capture webhook arrives
      await s.post(`/orders/${o.id}/confirm`);
      await s.settle();
      expect(await s.scalar("SELECT status FROM orders WHERE id=$1", [o.id])).toBe("paid");
      expect(await s.scalar("SELECT count(*) FROM ledger_entries WHERE account='provider:clearing' AND kind='sale'")).toBe("1");
      await assertBooks(s);
    });
  });

  it("capture answered with 5xx after it was applied does not lose the sale", async () => {
    await withStack(combo, async (s) => {
      const o = await s.createOrder([{ amount: 1000 }], { capture: "manual" });
      await s.checkout(o.id);
      s.pay(o.id);
      await s.deliverNew();
      await s.settle();
      s.faultOp("payment.capture", { t: "apply_then_500" }, 3);
      expect((await s.post(`/orders/${o.id}/capture`)).status).not.toBe(200);
      await s.deliverNew();
      await s.post(`/orders/${o.id}/confirm`);
      await s.settle();
      expect(await s.scalar("SELECT status FROM orders WHERE id=$1", [o.id])).toBe("paid");
      await assertBooks(s);
    });
  });

  it("S14 the app crashes right after the provider applied the capture: restart and webhook converge", async () => {
    await withStack(combo, async (s) => {
      const o = await s.createOrder([{ amount: 300 }, { amount: 700 }], { capture: "manual" });
      await s.checkout(o.id);
      s.pay(o.id);
      await s.deliverNew();
      await s.settle();
      s.sim.onCrash = () => void s.crash();
      s.faultOp("payment.capture", { t: "apply_then_crash" });
      await s.post(`/orders/${o.id}/capture`).catch(() => undefined);
      await sleep(300);
      await s.restart();
      await s.deliverNew();
      await s.post(`/orders/${o.id}/confirm`);
      await s.settle();
      expect(await s.scalar("SELECT status FROM orders WHERE id=$1", [o.id])).toBe("paid");
      expect(await s.scalar("SELECT count(*) FROM ledger_entries WHERE account='provider:clearing' AND kind='sale'")).toBe("1");
      await assertBooks(s);
    });
  });

  it("a payment for an order the app never created posts no money", async () => {
    await withStack(combo, async (s) => {
      const p = s.act({ kind: "createPayment", amount: 777n, currency: "INR", captureMethod: "automatic", metadata: { order_id: "ord_unknown" } });
      s.act({ kind: "customerPays", paymentId: (p as { id: string }).id, outcome: "success" });
      const rs = await s.deliverNew();
      expect(rs.length).toBeGreaterThan(0);
      await sleep(500);
      expect(await s.scalar("SELECT count(*) FROM ledger_entries")).toBe("0");
      expect(await s.scalar("SELECT count(*) FROM orders WHERE status IN ('paid','partially_refunded','refunded')")).toBe("0");
    });
  });

  it("works in a non-default currency", async () => {
    await withStack(combo, async (s) => {
      const o = await paidOrder(s, [{ amount: 1999 }, { amount: 1 }], { currency: "USD" });
      expect(await s.scalar("SELECT currency FROM orders WHERE id=$1", [o.id])).toBe("USD");
      expect(await s.scalar("SELECT count(DISTINCT currency) FROM ledger_entries")).toBe("1");
      expect(await s.scalar("SELECT DISTINCT currency FROM ledger_entries")).toBe("USD");
      await assertBooks(s);
    });
  });

  it("several independent orders paid in interleaved delivery order stay separate", async () => {
    await withStack(combo, async (s) => {
      const orders = [];
      for (const amt of [111, 222, 333]) {
        const o = await s.createOrder([{ amount: amt }]);
        await s.checkout(o.id);
        orders.push(o);
      }
      for (const o of [...orders].reverse()) s.pay(o.id);
      const evs = [...s.world.events];
      for (const e of [...evs].reverse()) await s.deliverAll(e);
      s.skipDelivery();
      await s.settle();
      for (const o of orders) expect(await s.scalar("SELECT status FROM orders WHERE id=$1", [o.id])).toBe("paid");
      expect(await s.scalar("SELECT sum(amount) FROM ledger_entries WHERE account='provider:clearing'")).toBe("666");
      await assertBooks(s);
    });
  });
});
