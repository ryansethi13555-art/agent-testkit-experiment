// The scenario suite. It is app and provider agnostic: it drives the HTTP surface, injects provider misbehaviour
// through the twin, and asserts money laws against Postgres and the twin's true state.
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type AppKind, type Harness, LIVE, type ProviderName, startHarness } from "./harness.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const live = (rs: { status: string; amount: bigint }[]) => rs.filter((r) => LIVE.has(r.status)).reduce((s, r) => s + r.amount, 0n);
const providerLive = (h: Harness, paymentId: string) => live([...h.twin.world.refunds.values()].filter((r) => r.paymentId === paymentId));
const calls = (h: Harness, prefix: string) => h.twin.calls.filter((c) => c.op.startsWith(prefix));

export function defineSuite(appKind: AppKind, provider: ProviderName): void {
  const MIN = provider === "razorpay" ? 100 : 1; // Razorpay INR refunds have a 100 minor unit minimum
  let h: Harness;
  const touched: string[] = [];
  beforeAll(async () => {
    h = await startHarness(appKind, provider);
  }, 60000);
  afterAll(async () => {
    await h?.stop();
  });
  afterEach(async () => {
    h.twin.clearFaults();
    await h.assertGlobalLedger();
    for (const id of touched.splice(0)) await h.assertBooksAgree(id);
  });
  const track = <T extends { id: string }>(o: T): T => (touched.push(o.id), o);
  /** Deliver all pending webhooks until the app has acknowledged everything it can (provider retries). */
  async function settle(rounds = 4) {
    for (let i = 0; i < rounds; i++) {
      const statuses = await h.deliverPending();
      await h.drain();
      if (statuses.every((s) => s === 200 || s === -1)) return;
      await sleep(50);
    }
  }
  const sellerNet = async (seller: string) =>
    BigInt((await h.db.query("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE account=$1", [`seller:${seller}`])).rows[0].s);

  describe(`${appKind} marketplace on ${provider}: payment lifecycle`, () => {
    it("checkout is idempotent: one provider payment however often the client asks", async () => {
      const o = track(await h.newOrder([600, 400]));
      const a = await h.checkout(o.id);
      const b = await h.checkout(o.id);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(b.body.payment_intent_id ?? b.body.payment_ref).toBe(a.body.payment_intent_id ?? a.body.payment_ref);
      expect(calls(h, "payment.create").filter((c) => c.applied).length).toBeGreaterThanOrEqual(1);
      expect(h.paymentOf(o.id).amount).toBe(o.total);
    });

    it("books the sale once: clearing mirrors capture, parts sum to the whole, commission within one minor unit of 10%", async () => {
      const amounts = [5, 15, 25, 1001, 333];
      const sellersBefore = [await sellerNet("seller_a"), await sellerNet("seller_b")];
      const o = track(await h.paidOrder(amounts, { sellers: ["seller_a", "seller_b", "seller_a", "seller_b", "seller_a"] } as any));
      const entries = await h.ledgerFor([h.wire(o.pay.id)]);
      expect(entries.reduce((s, e) => s + BigInt(e.amount), 0n)).toBe(0n);
      expect(entries.find((e) => e.account === "provider:clearing")?.amount).toBe(o.total);
      const a = (await sellerNet("seller_a")) - sellersBefore[0]!;
      const b = (await sellerNet("seller_b")) - sellersBefore[1]!;
      const gross = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
      const feeBounds = (xs: number[]) => ({ lo: xs.reduce((s, x) => s + Math.floor(x / 10), 0), hi: xs.reduce((s, x) => s + Math.ceil(x / 10), 0) });
      for (const [net, xs] of [[a, [5, 25, 333]], [b, [15, 1001]]] as const) {
        const { lo, hi } = feeBounds([...xs]);
        expect(-net).toBeGreaterThanOrEqual(BigInt(gross([...xs]) - hi));
        expect(-net).toBeLessThanOrEqual(BigInt(gross([...xs]) - lo));
      }
      expect((await h.orderRow(o.id)).status).toBe("paid");
    });

    it("duplicate webhook deliveries, same id and fresh id, sequential, post once", async () => {
      const o = track(await h.newOrder([700, 301]));
      await h.checkout(o.id);
      const p = h.paymentOf(o.id);
      h.twin.world.apply({ kind: "customerPays", paymentId: p.id, outcome: "success" });
      const evs = h.eventsFor(p.id);
      for (const ev of evs) await h.deliver(ev);
      for (const ev of evs) await h.deliver(ev); // same event id again
      for (const ev of evs) await h.deliver(ev, { fresh: true }); // a second Event object for the same occurrence
      await settle();
      expect((await h.ledgerFor([h.wire(p.id)])).filter((e) => e.account === "provider:clearing")).toHaveLength(1);
    });

    it("duplicate webhook deliveries in parallel post once", async () => {
      const o = track(await h.newOrder([700, 301]));
      await h.checkout(o.id);
      const p = h.paymentOf(o.id);
      h.twin.world.apply({ kind: "customerPays", paymentId: p.id, outcome: "success" });
      const evs = h.eventsFor(p.id);
      await Promise.all(evs.flatMap((ev) => [h.deliver(ev), h.deliver(ev), h.deliver(ev, { fresh: true }), h.deliver(ev, { fresh: true })]));
      await settle();
      expect((await h.ledgerFor([h.wire(p.id)])).filter((e) => e.account === "provider:clearing")).toHaveLength(1);
    });

    it("confirm (buyer return) racing the webhook still records the sale once", async () => {
      const o = track(await h.newOrder([600, 400]));
      await h.checkout(o.id);
      const p = h.paymentOf(o.id);
      h.twin.world.apply({ kind: "customerPays", paymentId: p.id, outcome: "success" });
      if (provider === "razorpay") return void (await settle()); // Razorpay confirm needs the signed checkout callback
      await Promise.all([h.post(`/orders/${o.id}/confirm`), h.post(`/orders/${o.id}/confirm`), settle()]);
      await settle();
      expect((await h.ledgerFor([h.wire(p.id)])).filter((e) => e.account === "provider:clearing")).toHaveLength(1);
    });

    it("a declined attempt books nothing; a later successful attempt books once", async () => {
      const o = track(await h.newOrder([500, 500]));
      await h.checkout(o.id);
      const p = h.paymentOf(o.id);
      h.twin.world.apply({ kind: "customerPays", paymentId: p.id, outcome: "decline" });
      await settle();
      expect((await h.orderRow(o.id)).status).toBe("pending_payment");
      expect(await h.ledgerFor([h.wire(p.id)])).toHaveLength(0);
      h.twin.world.apply({ kind: "customerPays", paymentId: p.id, outcome: "success" });
      await settle();
      expect((await h.orderRow(o.id)).status).toBe("paid");
    });

    it("rejects forged webhooks (wrong secret, missing header, tampered body) without any effect", async () => {
      const o = track(await h.newOrder([600, 400]));
      await h.checkout(o.id);
      const p = h.paymentOf(o.id);
      h.twin.world.apply({ kind: "customerPays", paymentId: p.id, outcome: "success" });
      for (const signature of ["wrong_secret", "missing_header", "body_tampered"]) {
        for (const ev of h.eventsFor(p.id)) {
          const st = await h.deliver(ev, { signature });
          if (st !== -1) expect(st, `forged (${signature}) webhook must be refused`).toBe(400);
        }
      }
      await h.drain();
      expect((await h.orderRow(o.id)).status).toBe("pending_payment");
      expect(await h.ledgerFor([h.wire(p.id)])).toHaveLength(0);
      await settle(); // the genuine delivery then works
      expect((await h.orderRow(o.id)).status).toBe("paid");
    });

    it("a payment the app never created never books money", async () => {
      const before = (await h.db.query("SELECT count(*)::int c FROM ledger_entries")).rows[0].c;
      const r = h.twin.world.apply({ kind: "createPayment", amount: 4242n, currency: "INR", captureMethod: "automatic", metadata: { order_id: "ord_unknown" } });
      expect(r.ok).toBe(true);
      const pid = (r as any).value.id as string;
      h.twin.world.apply({ kind: "customerPays", paymentId: pid, outcome: "success" });
      const evs = h.eventsFor(pid);
      for (const ev of evs) await h.deliver(ev);
      await sleep(100);
      for (const ev of evs) h.forget(ev);
      await h.db.query("UPDATE jobs SET state='done' WHERE state IN ('queued','running','failed')").catch(() => {});
      expect((await h.db.query("SELECT count(*)::int c FROM ledger_entries")).rows[0].c).toBe(before);
    });

    it("an order is never marked paid by a payment of another order", async () => {
      const a = track(await h.paidOrder([600, 400]));
      const b = track(await h.newOrder([600, 400]));
      await h.checkout(b.id);
      expect((await h.orderRow(b.id)).status).toBe("pending_payment");
      expect((await h.orderRow(b.id)).payRef).not.toBe((await h.orderRow(a.id)).payRef);
    });
  });

  describe(`${appKind} marketplace on ${provider}: refunds`, () => {
    it("partial refunds reverse the seller share and keep the clearing account equal to provider money", async () => {
      const o = track(await h.paidOrder([600, 401]));
      const before = await sellerNet("seller_a");
      const r = await h.refund(o.id, o.lines[0]!, 250);
      expect(r.status).toBe(200);
      await settle();
      expect((await sellerNet("seller_a")) - before).toBe(250n);
      expect((await h.orderRow(o.id)).status).toBe("partially_refunded");
      expect(providerLive(h, o.pay.id)).toBe(250n);
    });

    it("sequential partial refunds can never sum past the line amount", async () => {
      const o = track(await h.paidOrder([600, 401]));
      const l1 = o.lines[0]!;
      expect((await h.refund(o.id, l1, 300)).status).toBe(200);
      expect((await h.refund(o.id, l1, 300)).status).toBe(200);
      expect((await h.refund(o.id, l1, MIN)).status).toBe(400);
      expect((await h.refund(o.id, l1, 601)).status).toBe(400);
      await settle();
      expect(providerLive(h, o.pay.id)).toBe(600n);
      expect(calls(h, "refund.create").filter((c) => c.applied && c.objectRef === o.pay.id)).toHaveLength(2);
    });

    it("one line's budget is not spent from another line, and a full refund of every line marks the order refunded", async () => {
      const o = track(await h.paidOrder([600, 401]));
      expect((await h.refund(o.id, o.lines[1]!, 402)).status).toBe(400);
      expect((await h.refund(o.id, o.lines[0]!, 600)).status).toBe(200);
      expect((await h.refund(o.id, o.lines[1]!, 401)).status).toBe(200);
      await settle();
      expect((await h.orderRow(o.id)).status).toBe("refunded");
      expect(providerLive(h, o.pay.id)).toBe(1001n);
    });

    it("refuses refunds of another order's line, unknown lines/orders, unpaid orders and malformed amounts", async () => {
      const a = track(await h.paidOrder([600, 400]));
      const b = track(await h.paidOrder([600, 400]));
      const unpaid = track(await h.newOrder([600, 400]));
      const before = calls(h, "refund.create").length;
      expect((await h.refund(a.id, b.lines[0]!, 200)).status).toBe(404);
      expect((await h.refund(a.id, "nope", 200)).status).toBe(404);
      expect([404, 409]).toContain((await h.refund("ord_missing", a.lines[0]!, 200)).status);
      expect([409, 404]).toContain((await h.refund(unpaid.id, unpaid.lines[0]!, 200)).status);
      for (const amount of [0, -5, 10.5, "abc", "", null, "1e3", 2 ** 60, "9007199254740993", "99999999999999999999999"]) {
        const r = await h.post(`/orders/${a.id}/refunds`, { line_id: a.lines[0], amount });
        expect(r.status, `amount ${String(amount)}`).toBe(400);
      }
      expect(calls(h, "refund.create").length).toBe(before);
    });

    it("rejects invalid order input and never creates money from it", async () => {
      for (const body of [
        { lines: [] },
        { lines: [{ seller_id: "seller_a", amount: 0 }] },
        { lines: [{ seller_id: "seller_a", amount: -100 }] },
        { lines: [{ seller_id: "seller_a", amount: 10.5 }] },
        { lines: [{ seller_id: "seller_a", amount: "12abc" }] },
        { lines: [{ seller_id: "seller_a", amount: 100 }], currency: "rupees" },
      ]) expect((await h.post("/orders", body)).status).toBe(400);
      const big = await h.post("/orders", { lines: [{ seller_id: "seller_a", amount: "99999999999999999999999" }] });
      expect(big.status).toBe(400);
    });

    it("concurrent refunds on one line never exceed the line amount", async () => {
      const o = track(await h.paidOrder([600, 401]));
      const rs = await Promise.all([1, 2, 3, 4, 5].map(() => h.refund(o.id, o.lines[0]!, 250)));
      await settle();
      const ok = rs.filter((r) => r.status === 200).length;
      expect(ok).toBeLessThanOrEqual(2);
      expect(providerLive(h, o.pay.id)).toBeLessThanOrEqual(600n);
    });

    it("two refunds that meet at the provider together are both accounted exactly once", async () => {
      const o = track(await h.paidOrder([600, 401]));
      h.twin.injectFault({
        label: "rendezvous-refunds",
        match: (c) => c.op.startsWith("refund.create"),
        hold: { barrier: `rf-${o.id}`, count: 2, timeoutMs: 4000, release: "together" },
        times: 2,
      });
      const rs = await Promise.all([h.refund(o.id, o.lines[0]!, 200), h.refund(o.id, o.lines[0]!, 300)]);
      await settle();
      for (const r of rs) expect([200, 202, 400, 409, 502]).toContain(r.status);
      expect(providerLive(h, o.pay.id)).toBeLessThanOrEqual(600n);
      const rows = await h.appRefunds(o.id);
      expect(rows.length).toBe([...h.twin.world.refunds.values()].filter((r) => r.paymentId === o.pay.id).length);
    });

    it("a lost refund response is not resent and the refund is accounted once when the webhook arrives", async () => {
      const o = track(await h.paidOrder([600, 401]));
      h.twin.injectFault({ label: "lose-refund", match: (c) => c.op.startsWith("refund.create"), fault: { t: "apply_then_reset" }, times: 1 });
      const r = await h.refund(o.id, o.lines[0]!, 200);
      expect(r.status).not.toBe(200);
      expect([...h.twin.world.refunds.values()].filter((x) => x.paymentId === o.pay.id)).toHaveLength(1);
      // capacity stays reserved while the outcome is unknown: the rest of the line is still refundable, no more
      expect((await h.refund(o.id, o.lines[0]!, 401)).status).toBe(400);
      await sleep(1500); // let background recovery scans run: they must not POST again
      await settle();
      await sleep(600);
      await settle();
      expect(calls(h, "refund.create").filter((c) => c.objectRef === o.pay.id && c.applied)).toHaveLength(1);
      expect(providerLive(h, o.pay.id)).toBe(200n);
      expect((await h.appRefunds(o.id)).filter((x) => LIVE.has(x.status))).toHaveLength(1);
    });

    it("an applied refund that answers 5xx is not resent with a different identity", async () => {
      const o = track(await h.paidOrder([600, 401]));
      h.twin.injectFault({ label: "refund-500-after-apply", match: (c) => c.op.startsWith("refund.create"), fault: { t: "apply_then_500" }, times: 1 });
      const r = await h.refund(o.id, o.lines[0]!, 200);
      expect(r.status).not.toBe(200);
      await sleep(1200);
      await settle();
      await h.refund(o.id, o.lines[0]!, 200); // client retry of the business action
      await settle();
      expect(providerLive(h, o.pay.id)).toBeLessThanOrEqual(400n);
      expect(providerLive(h, o.pay.id)).toBeGreaterThanOrEqual(200n);
    });

    it("provider 5xx before apply moves no money and never produces an over-refund on retries", async () => {
      const o = track(await h.paidOrder([600, 401]));
      h.twin.injectFault({ label: "refund-500", match: (c) => c.op.startsWith("refund.create"), fault: { t: "fail_before_apply", status: 500 }, times: 1 });
      const r = await h.refund(o.id, o.lines[0]!, 600);
      expect(r.status).not.toBe(200);
      expect([...h.twin.world.refunds.values()].filter((x) => x.paymentId === o.pay.id)).toHaveLength(0);
      for (let i = 0; i < 2; i++) await h.refund(o.id, o.lines[0]!, 600);
      await settle();
      expect(providerLive(h, o.pay.id)).toBeLessThanOrEqual(600n);
    });

    it("provider 429 on refund moves no money and is never booked", async () => {
      const o = track(await h.paidOrder([600, 401]));
      h.twin.injectFault({ label: "refund-429", match: (c) => c.op.startsWith("refund.create"), fault: { t: "fail_before_apply", status: 429 }, times: 1 });
      const r = await h.refund(o.id, o.lines[0]!, 200);
      expect(r.status).not.toBe(200);
      await settle();
      expect(providerLive(h, o.pay.id)).toBe(0n);
      expect(await h.ledgerFor((await h.appRefunds(o.id)).map((x) => x.provider_ref))).toHaveLength(0);
    });

    it("a refund that fails asynchronously after acceptance is reversed exactly once and the budget is released", async () => {
      const o = track(await h.paidOrder([600, 401]));
      const before = await sellerNet("seller_a");
      const r = await h.refund(o.id, o.lines[0]!, 300);
      expect(r.status).toBe(200);
      await settle();
      const wr = [...h.twin.world.refunds.values()].find((x) => x.paymentId === o.pay.id)!;
      expect(h.twin.world.apply({ kind: "revertRefund", refundId: wr.id, to: "failed" }).ok).toBe(true);
      await settle();
      await settle();
      expect((await h.appRefunds(o.id))[0].status).toBe("failed");
      expect(await sellerNet("seller_a")).toBe(before);
      expect((await h.orderRow(o.id)).status).toBe("paid");
      // the failed refund's budget is available again, up to the line amount only
      expect((await h.refund(o.id, o.lines[0]!, 600)).status).toBe(200);
      expect((await h.refund(o.id, o.lines[0]!, MIN)).status).toBe(400);
    });

    it("stale refund events delivered after the final one do not resurrect a failed refund", async () => {
      const o = track(await h.paidOrder([600, 401]));
      expect((await h.refund(o.id, o.lines[0]!, 300)).status).toBe(200);
      await settle();
      const wr = [...h.twin.world.refunds.values()].find((x) => x.paymentId === o.pay.id)!;
      h.twin.world.apply({ kind: "revertRefund", refundId: wr.id, to: "failed" });
      await settle();
      const old = h.eventsFor(o.pay.id).filter((e) => e.refund && e.type !== "refund.failed");
      for (const ev of old) await h.deliver(ev);
      for (const ev of old) await h.deliver(ev, { fresh: true });
      await h.drain();
      await settle();
      expect((await h.appRefunds(o.id))[0].status).toBe("failed");
      const rev = (await h.ledgerFor([h.wire(wr.id)])).reduce((s, e) => s + BigInt(e.amount), 0n);
      expect(rev).toBe(0n);
    });

    it("refund events delivered in reverse order converge to the provider's final state", async () => {
      const o = track(await h.paidOrder([600, 401]));
      h.twin.world.apply({ kind: "createRefund", paymentId: o.pay.id, amount: 250n, origin: "dashboard" });
      const wr = [...h.twin.world.refunds.values()].find((x) => x.paymentId === o.pay.id)!;
      h.twin.world.apply({ kind: "revertRefund", refundId: wr.id, to: "failed" });
      const evs = h.eventsFor(o.pay.id).filter((e) => e.refund);
      for (const ev of [...evs].reverse()) await h.deliver(ev);
      await settle();
      expect((await h.appRefunds(o.id))[0].status).toBe("failed");
      expect((await h.orderRow(o.id)).status).toBe("paid");
    });

    it("a dashboard refund delivered before the payment event is applied once the payment is known", async () => {
      const o = track(await h.newOrder([600, 401]));
      await h.checkout(o.id);
      const p = h.paymentOf(o.id);
      h.twin.world.apply({ kind: "customerPays", paymentId: p.id, outcome: "success" });
      h.twin.world.apply({ kind: "createRefund", paymentId: p.id, amount: 150n, origin: "dashboard" });
      const refundEvents = h.eventsFor(p.id).filter((e) => e.refund);
      const payEvents = h.eventsFor(p.id).filter((e) => !e.refund);
      for (const ev of refundEvents) await h.deliver(ev); // refund first: the app may answer non-2xx so the provider retries
      for (const ev of payEvents) await h.deliver(ev);
      await settle(6);
      expect((await h.orderRow(o.id)).status).toBe("partially_refunded");
      expect(providerLive(h, p.id)).toBe(150n);
    });

    it("dashboard refunds count against the budget: the app cannot refund past the payment", async () => {
      const o = track(await h.paidOrder([600, 401]));
      h.twin.world.apply({ kind: "createRefund", paymentId: o.pay.id, amount: 500n, origin: "dashboard" });
      await settle();
      const r = await h.refund(o.id, o.lines[0]!, 600);
      expect(r.status).not.toBe(200);
      await settle();
      expect(providerLive(h, o.pay.id)).toBeLessThanOrEqual(1001n);
      const ok = await h.refund(o.id, o.lines[0]!, 400);
      expect(ok.status).toBe(200);
      expect((await h.refund(o.id, o.lines[1]!, 401)).status).not.toBe(200); // only 101 is left on the payment
      await settle();
      expect(providerLive(h, o.pay.id)).toBeLessThanOrEqual(1001n);
    });

    it("a full dashboard refund marks the order refunded", async () => {
      const o = track(await h.paidOrder([600, 401]));
      h.twin.world.apply({ kind: "createRefund", paymentId: o.pay.id, amount: 1001n, origin: "dashboard" });
      await settle();
      expect((await h.orderRow(o.id)).status).toBe("refunded");
    });

    it("a refund of a pending refund that the provider later succeeds is booked once", async () => {
      const o = track(await h.paidOrder([600, 401]));
      expect((await h.refund(o.id, o.lines[0]!, 200)).status).toBe(200);
      await settle();
      const evs = h.eventsFor(o.pay.id).filter((e) => e.refund);
      for (const ev of evs) await h.deliver(ev, { fresh: true });
      await Promise.all(evs.map((ev) => h.deliver(ev)));
      await settle();
      const wr = [...h.twin.world.refunds.values()].find((x) => x.paymentId === o.pay.id)!;
      expect((await h.ledgerFor([h.wire(wr.id)])).filter((e) => e.account === "provider:clearing")).toHaveLength(1);
    });
  });

  describe(`${appKind} marketplace on ${provider}: lost responses around payment creation and capture`, () => {
    it("a lost checkout response never creates a second provider payment", async () => {
      const o = track(await h.newOrder([600, 400]));
      h.twin.injectFault({ label: "lose-create", match: (c) => c.op.startsWith("payment.create"), fault: { t: "apply_then_reset" }, times: 1 });
      const first = await h.checkout(o.id);
      expect(first.status).not.toBe(200);
      for (let i = 0; i < 3; i++) await h.checkout(o.id);
      const mine = [...h.twin.world.payments.values()].filter((p) => Object.values(p.metadata).includes(o.id));
      expect(mine).toHaveLength(1);
      // the customer pays the one payment that exists; the signed events let the app learn it
      h.twin.world.apply({ kind: "customerPays", paymentId: mine[0]!.id, outcome: "success" });
      await settle(6);
      await sleep(300);
      await settle(6);
      expect((await h.orderRow(o.id)).status).toBe("paid");
    });

    it("double-submitted checkout creates exactly one provider payment", async () => {
      const o = track(await h.newOrder([600, 400]));
      const rs = await Promise.all(Array.from({ length: 6 }, () => h.checkout(o.id)));
      const mine = [...h.twin.world.payments.values()].filter((p) => Object.values(p.metadata).includes(o.id));
      expect(mine).toHaveLength(1);
      const refs = new Set(rs.filter((r) => r.status === 200).map((r) => r.body.payment_intent_id ?? r.body.payment_ref));
      expect(refs.size).toBeLessThanOrEqual(1);
      h.twin.world.apply({ kind: "customerPays", paymentId: mine[0]!.id, outcome: "success" });
      await settle(6);
      expect((await h.orderRow(o.id)).status).toBe("paid");
    });

    it("checkout answering 5xx after applying does not lead to a second payment", async () => {
      const o = track(await h.newOrder([600, 400]));
      h.twin.injectFault({ label: "create-500", match: (c) => c.op.startsWith("payment.create"), fault: { t: "apply_then_500" }, times: 1 });
      await h.checkout(o.id);
      await h.checkout(o.id);
      await h.checkout(o.id);
      const mine = [...h.twin.world.payments.values()].filter((p) => Object.values(p.metadata).includes(o.id));
      expect(mine.length).toBeLessThanOrEqual(1);
    });

    if (provider === "stripe") {
      it("manual capture whose response is lost is booked once when the event arrives, and a retry does not double book", async () => {
        const o = track(await h.newOrder([600, 400], { capture: "manual" }));
        expect((await h.checkout(o.id)).status).toBe(200);
        const p = h.paymentOf(o.id);
        h.twin.world.apply({ kind: "customerPays", paymentId: p.id, outcome: "success" });
        await settle();
        expect(p.status).toBe("requires_capture");
        expect(await h.ledgerFor([h.wire(p.id)])).toHaveLength(0); // an authorisation is not captured money
        h.twin.injectFault({ label: "lose-capture", match: (c) => c.op.startsWith("payment.capture"), fault: { t: "apply_then_reset" }, times: 1 });
        const r = await h.post(`/orders/${o.id}/capture`);
        expect([200, 202, 409, 502]).toContain(r.status); // the SDK may transparently retry with the same key
        expect(p.amountCaptured).toBe(o.total);
        expect(calls(h, "payment.capture").filter((c) => c.applied && !c.replayed)).toHaveLength(1);
        await settle();
        await sleep(400);
        await settle();
        await h.post(`/orders/${o.id}/capture`); // client retries the capture action
        await settle();
        expect((await h.orderRow(o.id)).status).toBe("paid");
        expect((await h.ledgerFor([h.wire(p.id)])).filter((e) => e.account === "provider:clearing")).toHaveLength(1);
      });

      it("a partial capture made outside the app never books more money than was captured", async () => {
        const o = await h.newOrder([600, 400], { capture: "manual" }); // deliberately not tracked: the app only supports full capture
        await h.checkout(o.id);
        const p = h.paymentOf(o.id);
        h.twin.world.apply({ kind: "customerPays", paymentId: p.id, outcome: "success" });
        const cap = h.twin.world.apply({ kind: "capture", paymentId: p.id, amount: 400n, origin: "dashboard" });
        expect(cap.ok).toBe(true);
        expect(p.amountCaptured).toBe(400n);
        await settle(2);
        for (const ev of h.eventsFor(p.id)) h.forget(ev);
        await h.db.query("UPDATE jobs SET state='done' WHERE state IN ('queued','running','failed')").catch(() => {});
        const entries = await h.ledgerFor([h.wire(p.id)]);
        const clearing = entries.filter((e) => e.account === "provider:clearing").reduce((s, e) => s + BigInt(e.amount), 0n);
        expect([0n, 400n], "booked either nothing or exactly what the provider captured").toContain(clearing);
        expect(entries.reduce((s, e) => s + BigInt(e.amount), 0n)).toBe(0n);
        if (clearing === 0n) expect(["paid", "partially_refunded", "refunded"]).not.toContain((await h.orderRow(o.id)).status);
      });

      it("manual capture happy path books only after capture", async () => {
        const o = track(await h.newOrder([600, 400], { capture: "manual" }));
        await h.checkout(o.id);
        const p = h.paymentOf(o.id);
        h.twin.world.apply({ kind: "customerPays", paymentId: p.id, outcome: "success" });
        await settle();
        expect(["paid", "partially_refunded", "refunded"]).not.toContain((await h.orderRow(o.id)).status); // authorised is not paid
        expect((await h.post(`/orders/${o.id}/capture`)).status).toBe(200);
        await settle();
        expect((await h.orderRow(o.id)).status).toBe("paid");
        expect(p.amountCaptured).toBe(o.total);
      });
    }
  });

  describe(`${appKind} marketplace on ${provider}: amounts and currencies`, () => {
    it("USD order: books and refunds in the order's currency", async () => {
      const r = await h.post("/orders", { currency: "USD", lines: [{ seller_id: "seller_a", amount: 1999 }, { seller_id: "seller_b", amount: 501 }] });
      expect(r.status).toBe(201);
      const o = track({ id: String(r.body.id), lines: r.body.lines as string[] });
      expect((await h.checkout(o.id)).status).toBe(200);
      const pay = await h.pay(o.id);
      const rf = await h.refund(o.id, o.lines[0]!, 1000);
      expect(rf.status).toBe(200);
      await settle();
      const entries = await h.ledgerFor([h.wire(pay.id)]);
      expect(new Set(entries.map((e) => e.currency))).toEqual(new Set(["USD"]));
      expect((await h.appRefunds(o.id)).every((x) => x.currency === "USD")).toBe(true);
    });

    if (provider === "razorpay") {
      it("INR refunds below the provider minimum of 100 minor units never reach the provider", async () => {
        const o = track(await h.paidOrder([600, 401]));
        const before = calls(h, "refund.create").length;
        for (const amount of [1, 50, 99]) expect((await h.refund(o.id, o.lines[0]!, amount)).status).toBe(400);
        expect(calls(h, "refund.create").length).toBe(before);
        expect((await h.refund(o.id, o.lines[0]!, 100)).status).toBe(200);
      });
    }

    it("randomised multi line orders with partial refunds keep every money law (property test)", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 1, max: 250_000 }), { minLength: 1, maxLength: 4 }),
          fc.array(fc.tuple(fc.nat(3), fc.integer({ min: 1, max: 100_000 })), { maxLength: 4 }),
          async (amounts, plan) => {
            const a = amounts.map((x) => Math.max(x, MIN));
            const o = track(await h.paidOrder(a));
            for (const [li, amt] of plan) {
              const line = o.lines[li % o.lines.length]!;
              const res = await h.refund(o.id, line, Math.max(amt, MIN));
              expect([200, 400, 202, 409]).toContain(res.status);
            }
            await settle();
            await h.assertBooksAgree(o.id);
          },
        ),
        { numRuns: 8, seed: 20261114, endOnFailure: true },
      );
    });
  });

  describe(`${appKind} marketplace on ${provider}: engine oracle over the whole database`, () => {
    it("MoneyInvariant oracle: ledger balance, line bounds, refund reconciliation and paid-iff-captured hold after a mixed workload", async () => {
      const o = track(await h.paidOrder([600, 401]));
      await h.refund(o.id, o.lines[0]!, 250);
      h.twin.world.apply({ kind: "createRefund", paymentId: o.pay.id, amount: 101n, origin: "dashboard" });
      await settle();
      const result = await h.oracle();
      expect(result.notEvaluated).toEqual([]);
      expect(result.held.sort()).toEqual(["order.paid-iff-captured", "recon.refunds-agree", "refund.line-bounded", "ledger.txn-balanced"].sort());
    });
  });
}
