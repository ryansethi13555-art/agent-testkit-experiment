// Webhook authenticity and input hardening: nothing unsigned, mis-signed, tampered or malformed may move money,
// and hostile order inputs must be refused before any money row exists.
import { describe, expect, it } from "vitest";
import { assertBooks, COMBOS, withStack } from "./harness.ts";

describe.each(COMBOS)("webhook security and input validation: $name", (combo) => {
  for (const variant of ["wrong_secret", "missing_header", "body_tampered"] as const) {
    it(`S16 a payment webhook with signature variant ${variant} is rejected and changes nothing`, async () => {
      await withStack(combo, async (s) => {
        const o = await s.createOrder([{ amount: 500 }]);
        await s.checkout(o.id);
        const [ev] = s.pay(o.id);
        s.skipDelivery();
        const r = await s.deliver(ev!, { signature: variant });
        expect(r.status).toBe(400);
        await s.settle();
        expect(await s.scalar("SELECT count(*) FROM ledger_entries")).toBe("0");
        expect(await s.scalar("SELECT status FROM orders WHERE id=$1", [o.id])).not.toBe("paid");
        // the genuine delivery still works afterwards
        expect((await s.deliver(ev!)).status).toBe(200);
        await s.settle();
        expect(await s.scalar("SELECT status FROM orders WHERE id=$1", [o.id])).toBe("paid");
        await assertBooks(s);
      });
    });
  }

  if (combo.provider === "stripe") {
    it("a replayed Stripe webhook with a stale timestamp is rejected", async () => {
      await withStack(combo, async (s) => {
        const o = await s.createOrder([{ amount: 500 }]);
        await s.checkout(o.id);
        const [ev] = s.pay(o.id);
        s.skipDelivery();
        expect((await s.deliver(ev!, { signature: "stale_timestamp" })).status).toBe(400);
        expect(await s.scalar("SELECT count(*) FROM ledger_entries")).toBe("0");
      });
    });
  }

  it("a forged refund webhook cannot create a refund or move ledger money", async () => {
    await withStack(combo, async (s) => {
      const o = await s.createOrder([{ amount: 500 }]);
      await s.checkout(o.id);
      s.pay(o.id);
      await s.deliverNew();
      await s.settle();
      s.act({ kind: "createRefund", paymentId: s.worldPaymentOf(o.id).id, amount: 200n, origin: "dashboard" });
      const ev = s.world.events.filter((e) => e.refund)[0]!;
      s.skipDelivery();
      expect((await s.deliver(ev, { signature: "wrong_secret" })).status).toBe(400);
      expect((await s.deliver(ev, { signature: "body_tampered" })).status).toBe(400);
      await s.settle();
      expect(await s.scalar("SELECT count(*) FROM refunds")).toBe("0");
      expect(await s.scalar("SELECT count(*) FROM ledger_entries WHERE kind='refund'")).toBe("0");
    });
  });

  it("garbage bodies and wrong content on the webhook endpoint are refused without side effects", async () => {
    await withStack(combo, async (s) => {
      for (const body of ["", "not json", "{}", "[]", '{"id":"evt_x","type":"payment_intent.succeeded"}']) {
        const r = await fetch(`${s.base}/webhooks/${s.provider}`, { method: "POST", headers: { "content-type": "application/json" }, body });
        expect(r.status).toBeGreaterThanOrEqual(400);
        expect(r.status).toBeLessThan(500);
      }
      expect(await s.scalar("SELECT count(*) FROM ledger_entries")).toBe("0");
    });
  });

  it("malformed money in order creation is refused before any row is written", async () => {
    await withStack(combo, async (s) => {
      const bads: unknown[] = [0, -1, 1.5, "1.5", "1e3", "abc", "", null, true, [], {}, 9007199254740993, "9007199254740993", "99999999999999999999", 1e21, "-5", " 5", "0x10"];
      for (const amount of bads) {
        const r = await s.post("/orders", { currency: "INR", lines: [{ seller_id: "seller_a", amount }] });
        expect(r.status, `amount ${JSON.stringify(amount)}`).toBeGreaterThanOrEqual(400);
        expect(r.status, `amount ${JSON.stringify(amount)}`).toBeLessThan(500);
      }
      expect((await s.post("/orders", { currency: "INR", lines: [] })).status).toBe(400);
      expect((await s.post("/orders", { currency: "INR" })).status).toBeGreaterThanOrEqual(400);
      expect((await s.post("/orders", { currency: "rupee", lines: [{ seller_id: "seller_a", amount: 5 }] })).status).toBe(400);
      expect((await s.post("/orders", { currency: "INR", lines: [{ seller_id: "ghost", amount: 5 }] })).status).toBeGreaterThanOrEqual(400);
      expect((await s.post("/orders", "{not json")).status).toBeGreaterThanOrEqual(400);
      expect(await s.scalar("SELECT count(*) FROM orders")).toBe("0");
      expect(await s.scalar("SELECT count(*) FROM order_lines")).toBe("0");
    });
  });

  it("the order total is the exact sum of its lines and amounts above 2^53 are never silently rounded", async () => {
    await withStack(combo, async (s) => {
      const o = await s.createOrder([{ amount: 123_456_789 }, { amount: 987_654_321 }, { amount: 1 }]);
      expect(o.total).toBe(123_456_789n + 987_654_321n + 1n);
      expect(await s.scalar("SELECT total FROM orders WHERE id=$1", [o.id])).toBe(String(o.total));
      const huge = await s.post("/orders", { currency: "INR", lines: [{ seller_id: "seller_a", amount: 9_007_199_254_740_000 }, { seller_id: "seller_b", amount: 1000 }] });
      // the sum passes the exact integer range: it must be refused, not rounded
      expect(huge.status).toBeGreaterThanOrEqual(400);
      expect(huge.status).toBeLessThan(500);
    });
  });

  it("checkout and actions on an unknown or already paid order do not create provider payments", async () => {
    await withStack(combo, async (s) => {
      expect((await s.checkout("ord_nope")).status).toBe(404);
      const o = await s.createOrder([{ amount: 500 }]);
      await s.checkout(o.id);
      s.pay(o.id);
      await s.deliverNew();
      await s.settle();
      const again = await s.checkout(o.id);
      expect(again.status).toBeGreaterThanOrEqual(200);
      expect(s.worldPayments(o.id)).toHaveLength(1);
      await assertBooks(s);
    });
  });
});
