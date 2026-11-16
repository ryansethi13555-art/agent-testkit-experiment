// worker-marketplace: orders, checkout, capture, webhooks-as-jobs, refunds, recovery. Real Postgres, shared World.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN, pgUp } from "../helpers/inlineHarness.ts";
import { assertWorkerBooks, bigv, drain, resetWorker, startWorker, stopWorker, W, wev, type WCtx } from "../helpers/workerHarness.ts";
import { http, signedEvent } from "../helpers/world.ts";

const up = await pgUp();
const NAME = `b3_wrk_shop_${process.pid}`;
let c: WCtx;
let A: ReturnType<typeof W>;
void ADMIN;

describe.skipIf(!up)("worker: money logic", () => {
  beforeAll(async () => {
    c = await startWorker(NAME);
  });
  afterAll(() => stopWorker(c, NAME));
  beforeEach(async () => {
    await resetWorker(c);
    A = W(c);
  });
  const q = async (sql: string, p: unknown[] = []) => (await c.db.query(sql, p)).rows;
  const jobs = () => q("SELECT * FROM jobs ORDER BY id");

  /** An order paid in full and fully booked. */
  async function paidOrder(lines = [600, 400], opts: { currency?: string } = {}) {
    const o = await A.order(lines, opts);
    const co = await A.checkout(o.id);
    expect(co.status).toBe(200);
    const ref = String(co.body.payment_ref);
    c.world.customerPays(ref);
    expect((await A.hook(wev.pi(c, "payment_intent.succeeded", ref))).status).toBe(200);
    await drain(c);
    return { o, ref, l1: o.lines[0]!, l2: o.lines[1]! };
  }

  describe("orders", () => {
    const bad: [string, unknown][] = [
      ["no lines", []],
      ["21 lines", Array.from({ length: 21 }, () => ({ seller_id: "seller_a", amount: 10 }))],
      ["zero", [{ seller_id: "seller_a", amount: 0 }]],
      ["negative", [{ seller_id: "seller_a", amount: -1 }]],
      ["fraction", [{ seller_id: "seller_a", amount: 1.5 }]],
      ["decimal string", [{ seller_id: "seller_a", amount: "10.00" }]],
      ["exponent", [{ seller_id: "seller_a", amount: "1e3" }]],
      ["too large line", [{ seller_id: "seller_a", amount: "1000000000000" }]],
      ["total too large", [{ seller_id: "seller_a", amount: "999999999999" }, { seller_id: "seller_b", amount: 1 }]],
      ["missing seller", [{ amount: 10 }]],
      ["unknown seller", [{ seller_id: "ghost", amount: 10 }]],
    ];
    for (const [name, lines] of bad)
      it(`rejects ${name} and stores nothing`, async () => {
        expect((await A.post("/orders", { lines })).status).toBe(400);
        expect(await q("SELECT 1 FROM orders")).toEqual([]);
        expect(await q("SELECT 1 FROM order_lines")).toEqual([]);
      });
    it("rejects bad currency and capture values", async () => {
      expect((await A.post("/orders", { currency: "RUPEES", lines: [{ seller_id: "seller_a", amount: 10 }] })).status).toBe(400);
      expect((await A.post("/orders", { capture: "sometimes", lines: [{ seller_id: "seller_a", amount: 10 }] })).status).toBe(400);
      expect(await q("SELECT 1 FROM orders")).toEqual([]);
    });
    it("stores the exact sum, normalises currency, and exposes the order", async () => {
      const r = await A.post("/orders", { currency: "eur", lines: [{ seller_id: "seller_a", amount: "00007" }, { seller_id: "seller_b", amount: 5 }] });
      expect(r.status).toBe(201);
      expect([r.body.total, r.body.currency]).toEqual(["12", "EUR"]);
      const got = await A.get(`/orders/${r.body.id}`);
      expect(got.status).toBe(200);
      expect((await A.get("/orders/ord_nope")).status).toBe(404);
    });
    it("accepts the largest order total and rejects invalid JSON bodies", async () => {
      expect((await A.post("/orders", { lines: [{ seller_id: "seller_a", amount: "999999999999" }] })).status).toBe(201);
      expect((await A.post("/orders", "{nope")).status).toBe(400);
      expect((await A.post("/orders", "[1,2]")).status).toBe(400);
    });
  });

  describe("checkout and capture", () => {
    it("creates exactly one provider payment however often (and however concurrently) it is submitted", async () => {
      const o = await A.order([500, 500]);
      const rs = await Promise.all([1, 2, 3, 4, 5].map(() => A.checkout(o.id)));
      for (const r of rs) expect([200, 502]).toContain(r.status);
      expect(rs.some((r) => r.status === 200)).toBe(true);
      expect((await A.checkout(o.id)).status).toBe(200);
      expect(c.world.payments.size).toBe(1);
      const p = [...c.world.payments.values()][0]!;
      expect([p.amount, p.currency, p.orderId]).toEqual([1000n, "INR", o.id]);
    });
    it("a lost create response never produces a second provider payment, even after idempotency expiry", async () => {
      const o = await A.order([500, 500]);
      c.world.fault("createPayment", "lost");
      expect((await A.checkout(o.id)).status).toBe(502); // outcome unknown
      c.world.expireIdempotency();
      await A.checkout(o.id);
      await A.checkout(o.id);
      expect(c.world.count("createPayment")).toBe(1);
      expect(c.world.payments.size).toBe(1);
    });
    it("a 5xx before apply also never leads to a second create", async () => {
      const o = await A.order([500, 500]);
      c.world.fault("createPayment", "before5xx");
      expect((await A.checkout(o.id)).status).toBe(502);
      await A.checkout(o.id);
      expect(c.world.count("createPayment")).toBe(1);
    });
    it("a created payment that does not match the order's money is refused", async () => {
      const o = await A.order([500, 500]);
      const orig = c.world.createPayment.bind(c.world);
      c.world.createPayment = async (p) => orig({ ...p, amount: p.amount + 1n });
      expect((await A.checkout(o.id)).status).toBe(502);
      expect((await q("SELECT payment_ref FROM orders"))[0].payment_ref).toBeNull();
    });
    it("a paid order cannot be checked out again", async () => {
      const { o } = await paidOrder();
      expect((await A.checkout(o.id)).status).toBe(409);
      expect(c.world.payments.size).toBe(1);
    });
    it("manual capture: authorised is not paid; capture books once; repeat is harmless", async () => {
      const o = await A.order([600, 400], { capture: "manual" });
      const ref = String((await A.checkout(o.id)).body.payment_ref);
      c.world.customerPays(ref);
      await A.hook(wev.pi(c, "payment_intent.amount_capturable_updated", ref));
      await drain(c);
      expect((await q("SELECT status FROM orders"))[0].status).toBe("authorized");
      expect(await q("SELECT 1 FROM ledger_entries")).toEqual([]);
      expect((await A.post(`/orders/${o.id}/capture`)).body.status).toBe("paid");
      expect((await A.post(`/orders/${o.id}/capture`)).body.status).toBe("paid");
      expect(c.world.get(ref).captured).toBe(1000n);
      await assertWorkerBooks(c);
    });
    it("capture with a lost response is reconciled from the provider object, never booked twice", async () => {
      const o = await A.order([600, 400], { capture: "manual" });
      const ref = String((await A.checkout(o.id)).body.payment_ref);
      c.world.customerPays(ref);
      c.world.fault("capture", "lost");
      expect((await A.post(`/orders/${o.id}/capture`)).status).toBe(502);
      expect((await jobs()).some((j) => j.type === "reconcile_payment")).toBe(true);
      await drain(c);
      await A.post(`/orders/${o.id}/confirm`);
      await A.hook(wev.pi(c, "payment_intent.succeeded", ref));
      await drain(c);
      expect(c.world.count("capture")).toBe(1);
      await assertWorkerBooks(c);
    });
    it("capture rejects a payment that is not awaiting capture", async () => {
      const o = await A.order([600, 400], { capture: "manual" });
      await A.checkout(o.id);
      expect((await A.post(`/orders/${o.id}/capture`)).status).toBe(409);
      expect(c.world.count("capture")).toBe(0);
    });
    it("a partial capture is never allocated as the full sale", async () => {
      const o = await A.order([600, 400], { capture: "manual" });
      const ref = String((await A.checkout(o.id)).body.payment_ref);
      c.world.customerPays(ref);
      const pay = c.world.get(ref);
      Object.assign(pay, { status: "succeeded", captured: 700n });
      await A.post(`/orders/${o.id}/confirm`);
      expect(await q("SELECT 1 FROM allocations")).toEqual([]);
      const sellerCredits = bigv((await q("SELECT coalesce(sum(-amount),0)::text s FROM ledger_entries WHERE account LIKE 'seller:%'"))[0].s);
      expect(sellerCredits).toBe(0n);
      await assertWorkerBooks(c);
    });
  });

  describe("webhooks are notices; state comes from the provider object", () => {
    it("a forged signature stores nothing", async () => {
      const o = await A.order([500, 500]);
      const ref = String((await A.checkout(o.id)).body.payment_ref);
      const good = wev.pi(c, "payment_intent.succeeded", ref);
      expect((await A.hook({ ...good, headers: { "stripe-signature": "t=1,v1=00" } })).status).toBe(400);
      expect((await A.hook({ ...good, headers: {} })).status).toBe(400);
      expect((await A.hook(signedEvent("whsec_other", "payment_intent.succeeded", { id: ref, object: "payment_intent" }))).status).toBe(400);
      expect(await jobs()).toEqual([]);
    });
    it("a (signed) succeeded notice for a payment the provider still shows unpaid books nothing", async () => {
      const o = await A.order([500, 500]);
      const ref = String((await A.checkout(o.id)).body.payment_ref);
      await A.hook(signedEvent("whsec_b3_worker", "payment_intent.succeeded", { id: ref, object: "payment_intent", status: "succeeded", amount: 1000, amount_received: 1000 }));
      await drain(c);
      expect(await q("SELECT 1 FROM ledger_entries")).toEqual([]);
      expect((await q("SELECT status FROM orders"))[0].status).toBe("pending_payment");
    });
    it("duplicate deliveries of one event id, sequential and concurrent, create one job and book once", async () => {
      const o = await A.order([500, 500]);
      const ref = String((await A.checkout(o.id)).body.payment_ref);
      c.world.customerPays(ref);
      const e = wev.pi(c, "payment_intent.succeeded", ref);
      expect((await A.hook(e)).status).toBe(200);
      expect((await A.hook(e)).status).toBe(200);
      await Promise.all([1, 2, 3, 4, 5, 6].map(() => A.hook(e)));
      expect((await jobs()).length).toBe(1);
      await drain(c);
      await A.hook(e); // late duplicate after processing
      await drain(c);
      await assertWorkerBooks(c);
    });
    it("the same fact under different event ids (and confirm) still books once", async () => {
      const { o, ref } = await paidOrder();
      for (let i = 0; i < 4; i++) await A.hook(wev.pi(c, "payment_intent.succeeded", ref));
      await A.hook(signedEvent("whsec_b3_worker", "charge.succeeded", { id: "ch_1", object: "charge", payment_intent: ref }));
      await A.post(`/orders/${o.id}/confirm`);
      await drain(c);
      expect(Number((await q("SELECT count(*) c FROM ledger_entries WHERE kind='sale' AND account='provider:clearing'"))[0].c)).toBe(1);
      await assertWorkerBooks(c);
    });
    it("a notice for an object that is not ours is ignored", async () => {
      const rogue = c.world.rogueCapturedPayment("ord_ghost", 100n, "INR");
      await A.hook(wev.pi(c, "payment_intent.succeeded", rogue.ref));
      await A.hook(signedEvent("whsec_b3_worker", "customer.created", { id: "cus_1", object: "customer" }));
      await drain(c);
      expect(await q("SELECT 1 FROM ledger_entries")).toEqual([]);
      expect(await q("SELECT 1 FROM payments")).toEqual([]);
    });
    it("a late payment notice after refunds does not re-book the sale or reset the order", async () => {
      const { o, ref, l1 } = await paidOrder();
      expect((await A.refund(o.id, l1, 300)).status).toBe(200);
      await A.hook(wev.pi(c, "payment_intent.succeeded", ref));
      await A.hook(wev.pi(c, "payment_intent.processing", ref));
      await drain(c);
      expect((await q("SELECT status FROM orders"))[0].status).toBe("partially_refunded");
      await assertWorkerBooks(c);
    });
    it("a second captured provider payment for the order goes to suspense and credits no seller again", async () => {
      const { o, ref } = await paidOrder();
      const before = bigv((await q("SELECT coalesce(sum(-amount),0)::text s FROM ledger_entries WHERE account LIKE 'seller:%'"))[0].s);
      const rogue = c.world.rogueCapturedPayment(o.id, 1000n, "INR");
      await A.hook(wev.pi(c, "payment_intent.succeeded", rogue.ref));
      await drain(c);
      const after = bigv((await q("SELECT coalesce(sum(-amount),0)::text s FROM ledger_entries WHERE account LIKE 'seller:%'"))[0].s);
      expect(after).toBe(before);
      expect((await q("SELECT count(*)::int n FROM allocations WHERE cause_ref=$1", [rogue.ref]))[0].n).toBe(0);
      expect((await q("SELECT count(*)::int n FROM allocations WHERE cause_ref=$1", [ref]))[0].n).toBe(2);
      await assertWorkerBooks(c);
    });
    it("a currency that differs from the order is not booked", async () => {
      const o = await A.order([500, 500]);
      const ref = String((await A.checkout(o.id)).body.payment_ref);
      c.world.customerPays(ref);
      c.world.get(ref).currency = "USD";
      await A.hook(wev.pi(c, "payment_intent.succeeded", ref));
      await drain(c);
      expect(await q("SELECT 1 FROM ledger_entries")).toEqual([]);
      expect(["pending_payment"]).toContain((await q("SELECT status FROM orders"))[0].status);
    });
    it("books correctly in USD, JPY and KWD with every row in the order currency", async () => {
      for (const currency of ["USD", "JPY", "KWD"]) {
        const { o, l1 } = await paidOrder([333, 667], { currency });
        expect((await A.refund(o.id, l1, 100)).status).toBe(200);
      }
      expect((await q("SELECT DISTINCT currency FROM ledger_entries ORDER BY 1")).map((r) => r.currency)).toEqual(["JPY", "KWD", "USD"]);
      await assertWorkerBooks(c);
    });
    it("commission and seller parts sum exactly to each line for awkward amounts", async () => {
      for (const lines of [[1], [5, 15, 25, 35], [9, 99, 999], [1, 1, 1, 1, 1, 1, 1], [123456789, 7]]) await paidOrder(lines);
      await assertWorkerBooks(c);
    });
  });

  describe("refunds", () => {
    it("books a refund against the right seller once", async () => {
      const { o, l1 } = await paidOrder();
      const r = await A.refund(o.id, l1, 250);
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("succeeded");
      expect(bigv((await q("SELECT sum(amount)::text s FROM ledger_entries WHERE kind='refund' AND account='seller:seller_a'"))[0].s)).toBe(250n);
      expect((await q("SELECT status FROM orders"))[0].status).toBe("partially_refunded");
      await assertWorkerBooks(c);
    });
    it("full refunds of every line end in refunded", async () => {
      const { o, l1, l2 } = await paidOrder();
      await A.refund(o.id, l1, 600);
      await A.refund(o.id, l2, 400);
      expect((await q("SELECT status FROM orders"))[0].status).toBe("refunded");
      await assertWorkerBooks(c);
    });
    it("sequential partial refunds can never exceed the line", async () => {
      const { o, l1 } = await paidOrder();
      expect((await A.refund(o.id, l1, 250)).status).toBe(200);
      expect((await A.refund(o.id, l1, 250)).status).toBe(200);
      expect((await A.refund(o.id, l1, 101)).status).toBe(400);
      expect((await A.refund(o.id, l1, 100)).status).toBe(200);
      expect((await A.refund(o.id, l1, 1)).status).toBe(400);
      expect(c.world.count("createRefund")).toBe(3);
      await assertWorkerBooks(c);
    });
    it("rejects bad amounts, unpaid orders and foreign lines without a provider call", async () => {
      const { o, l1 } = await paidOrder();
      for (const amount of [0, -5, 1.5, "x", "1e2", null, undefined, "1000000000000"]) expect((await A.refund(o.id, l1, amount)).status, String(amount)).toBe(400);
      const unpaid = await A.order([500]);
      expect((await A.refund(unpaid.id, unpaid.lines[0]!, 100)).status).toBe(409);
      const other = await paidOrder([500, 500]);
      expect((await A.refund(o.id, other.l1, 100)).status).toBe(404);
      expect((await A.refund(o.id, "ghost", 100)).status).toBe(404);
      expect((await A.refund("ord_missing", l1, 100)).status).toBe(404);
      expect(c.world.count("createRefund")).toBe(0);
      expect(await q("SELECT 1 FROM refund_requests")).toEqual([]);
    });
    it("a line with no allocated captured money cannot be refunded", async () => {
      const o = await A.order([500, 500]);
      await A.checkout(o.id);
      expect((await A.refund(o.id, o.lines[0]!, 100)).status).toBe(409);
    });
    it("Razorpay's INR minimum is enforced before any reservation", async () => {
      const { o, l1 } = await paidOrder();
      const { realRazorpay } = await import("../helpers/workerHarness.ts");
      c.provider.refundRequestError = realRazorpay.refundRequestError!;
      expect((await A.refund(o.id, l1, 99)).status).toBe(400);
      expect(await q("SELECT 1 FROM refund_requests")).toEqual([]);
      expect(c.world.count("createRefund")).toBe(0);
      expect((await A.refund(o.id, l1, 100)).status).toBe(200);
    });
    it("concurrent refunds on one line never exceed it", async () => {
      const { o, l1 } = await paidOrder();
      const rs = await Promise.all([1, 2, 3, 4, 5].map(() => A.refund(o.id, l1, 250)));
      expect(rs.filter((r) => r.status === 200).length).toBe(2);
      for (const r of rs) expect([200, 400]).toContain(r.status);
      await assertWorkerBooks(c);
    });
    it("concurrent refunds across lines, plus an outside refund, never exceed the payment", async () => {
      const { o, ref, l1, l2 } = await paidOrder();
      const d = c.world.dashboardRefund(ref, 300n);
      await A.hook(wev.refund(c, "refund.created", d.ref));
      await drain(c);
      const rs = await Promise.all([A.refund(o.id, l1, 600), A.refund(o.id, l2, 400), A.refund(o.id, l2, 100)]);
      expect(c.world.heldOn(ref) <= 1000n).toBe(true);
      for (const r of rs) expect([200, 202, 400, 409]).toContain(r.status);
      await drain(c);
      await assertWorkerBooks(c, { reservedOk: true });
    });
    it("a definitive rejection releases the reservation", async () => {
      const { o, l1 } = await paidOrder();
      c.world.fault("createRefund", "reject");
      expect((await A.refund(o.id, l1, 600)).status).toBe(409);
      expect((await q("SELECT state FROM refund_requests"))[0].state).toBe("rejected");
      expect((await A.refund(o.id, l1, 600)).status).toBe(200);
      await assertWorkerBooks(c);
    });
    it("a refund that exceeds what outside refunds left is refused locally once they are known", async () => {
      const { o, ref, l1 } = await paidOrder();
      const d = c.world.dashboardRefund(ref, 800n);
      await A.hook(wev.refund(c, "refund.created", d.ref));
      await drain(c);
      expect((await A.refund(o.id, l1, 201)).status).toBe(400);
      expect(c.world.count("createRefund")).toBe(0);
      await assertWorkerBooks(c);
    });

    describe("unknown outcomes", () => {
      for (const fault of ["lost", "before5xx"] as const)
        it(`${fault}: answers 202, keeps the amount reserved and never re-posts`, async () => {
          const { o, l1 } = await paidOrder();
          c.world.fault("createRefund", fault);
          const r = await A.refund(o.id, l1, 600);
          expect(r.status).toBe(202);
          expect((await q("SELECT state FROM refund_requests"))[0].state).toBe("unknown");
          expect((await A.refund(o.id, l1, 1)).status).toBe(400); // still reserved
          c.world.expireIdempotency();
          await drain(c, 20);
          expect(c.world.count("createRefund")).toBe(1);
          expect((await jobs()).find((j) => j.type === "resolve_refund_request")!.state).toBe("failed"); // dead letter
          expect((await q("SELECT state FROM refund_requests"))[0].state).toBe("unknown");
          expect((await A.refund(o.id, l1, 1)).status).toBe(400); // reservation survives the dead letter
        });
      it("a late exact webhook links the unknown request, retires the dead letter and books once", async () => {
        const { o, l1 } = await paidOrder();
        c.world.fault("createRefund", "lost");
        expect((await A.refund(o.id, l1, 600)).status).toBe(202);
        await drain(c, 20);
        const rr = [...c.world.refunds.keys()][0]!;
        await A.hook(wev.refund(c, "refund.created", rr));
        await A.hook(wev.refund(c, "refund.updated", rr));
        await drain(c);
        const req = (await q("SELECT * FROM refund_requests"))[0];
        expect([req.state, req.provider_ref]).toEqual(["sent", rr]);
        expect((await jobs()).find((j) => j.type === "resolve_refund_request")!.state).toBe("done");
        expect((await q("SELECT count(*)::int n FROM refunds"))[0].n).toBe(1);
        await assertWorkerBooks(c);
      });
      it("a restart finds requests left in flight and resolves them without re-sending", async () => {
        const { o, ref, l1 } = await paidOrder();
        await q("INSERT INTO refund_requests (id, order_id, line_id, currency, amount, state) VALUES ('rr_crash', $1, $2, 'INR', 300, 'requested')", [o.id, l1]);
        expect(await c.app.shop.recoverRefundRequests()).toBe(1);
        await drain(c, 20);
        expect(c.world.count("createRefund")).toBe(0);
        expect((await q("SELECT state FROM refund_requests"))[0].state).toBe("unknown");
        expect((await A.refund(o.id, l1, 301)).status).toBe(400); // 300 reserved
        // and if the provider did apply it, its event links it
        const applied = await c.world.createRefund(ref, { amount: 300n, idempotencyKey: "rr_crash", metadata: { order_id: o.id, line_id: l1, refund_request_id: "rr_crash" } });
        await A.hook(wev.refund(c, "refund.created", applied.ref));
        await drain(c);
        expect((await q("SELECT state FROM refund_requests"))[0].state).toBe("sent");
        await assertWorkerBooks(c);
      });
      it("jobs left running by a crashed process are re-queued and applied idempotently", async () => {
        const o = await A.order([500, 500]);
        const ref = String((await A.checkout(o.id)).body.payment_ref);
        c.world.customerPays(ref);
        await A.hook(wev.pi(c, "payment_intent.succeeded", ref));
        await q("UPDATE jobs SET state='running', attempts=1");
        expect(await c.app.worker.recover()).toBe(1);
        await drain(c);
        await A.hook(wev.pi(c, "payment_intent.succeeded", ref, "evt_again"));
        await drain(c);
        await assertWorkerBooks(c);
      });
      it("a crash between the provider applying a refund and the shop recording it leaves it recoverable by event", async () => {
        const { o, ref, l1 } = await paidOrder();
        c.world.fault("createRefund", "lost");
        await A.refund(o.id, l1, 200);
        const rr = [...c.world.refunds.keys()][0]!;
        await A.hook(wev.refund(c, "refund.updated", rr));
        await drain(c);
        expect(ref).toBeTruthy();
        expect((await q("SELECT count(*)::int n FROM refunds"))[0].n).toBe(1);
        await assertWorkerBooks(c);
      });
    });

    describe("provider-originated refunds and event ordering", () => {
      it("a dashboard refund is recorded once; unallocated to any seller", async () => {
        const { ref } = await paidOrder();
        const d = c.world.dashboardRefund(ref, 100n);
        for (let i = 0; i < 3; i++) await A.hook(wev.refund(c, "refund.updated", d.ref, i === 0 ? "evt_d" : undefined));
        await drain(c);
        const rows = await q("SELECT * FROM refunds");
        expect(rows.length).toBe(1);
        expect([rows[0].origin, rows[0].line_id]).toEqual(["provider", null]);
        expect(bigv((await q("SELECT sum(amount)::text s FROM ledger_entries WHERE account='platform:unallocated_refunds'"))[0].s)).toBe(100n);
        await assertWorkerBooks(c);
      });
      it("a refund event for a payment the shop has not seen yet reconciles the payment first", async () => {
        const o = await A.order([600, 400]);
        const ref = String((await A.checkout(o.id)).body.payment_ref);
        c.world.customerPays(ref);
        const d = c.world.dashboardRefund(ref, 150n);
        await A.hook(wev.refund(c, "refund.created", d.ref));
        await drain(c);
        expect((await q("SELECT status FROM orders"))[0].status).toBe("partially_refunded");
        await assertWorkerBooks(c);
      });
      it("pending then succeeded then a stale pending notice: status follows the provider's current object", async () => {
        const { o, l1 } = await paidOrder();
        c.world.newRefundStatus = "pending";
        expect((await A.refund(o.id, l1, 200)).body.status).toBe("pending");
        const rr = [...c.world.refunds.keys()][0]!;
        const stale = wev.refund(c, "refund.updated", rr);
        c.world.setRefundStatus(rr, "succeeded");
        await A.hook(wev.refund(c, "refund.updated", rr));
        await A.hook(stale);
        await drain(c);
        expect((await q("SELECT status FROM refunds"))[0].status).toBe("succeeded");
        await assertWorkerBooks(c);
      });
      it("async failure reverses the recognition once, restores the line and the order, and replays are harmless", async () => {
        const { o, l1 } = await paidOrder();
        c.world.newRefundStatus = "pending";
        await A.refund(o.id, l1, 600);
        const rr = [...c.world.refunds.keys()][0]!;
        c.world.setRefundStatus(rr, "failed");
        const f = wev.refund(c, "refund.failed", rr);
        await A.hook(f);
        await A.hook(f);
        await A.hook(wev.refund(c, "refund.updated", rr));
        await drain(c);
        expect((await q("SELECT status FROM orders"))[0].status).toBe("paid");
        expect((await q("SELECT count(*)::int n FROM ledger_entries WHERE kind='refund_reversal'"))[0].n).toBe(2);
        await assertWorkerBooks(c);
        c.world.newRefundStatus = "succeeded";
        expect((await A.refund(o.id, l1, 600)).status).toBe(200);
        await assertWorkerBooks(c);
      });
      it("succeeded then failed is reversed once; canceled behaves like failed", async () => {
        const { o, l1, l2 } = await paidOrder();
        await A.refund(o.id, l1, 200);
        c.world.newRefundStatus = "pending";
        await A.refund(o.id, l2, 100);
        const [r1, r2] = [...c.world.refunds.keys()];
        c.world.setRefundStatus(r1!, "failed");
        c.world.setRefundStatus(r2!, "canceled");
        for (const r of [r1!, r2!]) {
          await A.hook(wev.refund(c, "refund.updated", r));
          await A.hook(wev.refund(c, "refund.updated", r));
        }
        await drain(c);
        expect((await q("SELECT status FROM orders"))[0].status).toBe("paid");
        await assertWorkerBooks(c);
      });
      it("two orders with identical amounts keep their refunds apart", async () => {
        const a = await paidOrder([500, 500]);
        const b = await paidOrder([500, 500]);
        const [ra, rb] = await Promise.all([A.refund(a.o.id, a.l1, 200), A.refund(b.o.id, b.l2, 200)]);
        expect([ra.status, rb.status]).toEqual([200, 200]);
        for (const w of c.world.refunds.values()) {
          const row = (await q("SELECT * FROM refunds WHERE provider_ref=$1", [w.ref]))[0];
          expect(row.order_id).toBe(w.metadata.order_id);
          expect(row.line_id).toBe(w.metadata.line_id);
        }
        await assertWorkerBooks(c);
      });
      it("a refund notice whose object the provider reports as another payment's is not mixed into this order", async () => {
        const a = await paidOrder([500, 500]);
        const b = await paidOrder([500, 500]);
        const d = c.world.dashboardRefund(b.ref, 100n);
        // a hostile notice claims the refund belongs to order A's payment
        await A.hook(signedEvent("whsec_b3_worker", "refund.created", { id: d.ref, object: "refund", payment_intent: a.ref }));
        await drain(c);
        const rows = await q("SELECT * FROM refunds");
        expect(rows.every((r) => r.order_id === b.o.id)).toBe(true);
        await assertWorkerBooks(c);
      });
    });
  });

  describe("job queue", () => {
    it("a failing job is retried with backoff, dead-lettered after its limit, and a redelivery revives it", async () => {
      const o = await A.order([500, 500]);
      const ref = String((await A.checkout(o.id)).body.payment_ref);
      c.world.customerPays(ref);
      c.world.fault("retrievePayment", "before5xx", 100);
      await A.hook(wev.pi(c, "payment_intent.succeeded", ref, "evt_q"));
      await drain(c, 40);
      const j = (await jobs())[0];
      expect(j.state).toBe("failed");
      expect(await q("SELECT 1 FROM ledger_entries")).toEqual([]);
      c.world.faults.retrievePayment = [];
      await A.hook(wev.pi(c, "payment_intent.succeeded", ref, "evt_q")); // provider redelivers the same event
      await drain(c);
      expect((await jobs()).length).toBe(1);
      await assertWorkerBooks(c);
    });
    it("a job that succeeded is not re-queued by a redelivery", async () => {
      const { ref } = await paidOrder();
      const before = await jobs();
      const first = before[0]!;
      await A.hook(wev.pi(c, "payment_intent.succeeded", ref, String(first.provider_event_id).replace("stripe:", "")));
      expect((await jobs()).map((j) => j.state)).toEqual(before.map((j) => j.state));
    });
  });

  it("health and unknown routes", async () => {
    expect((await A.get("/healthz")).status).toBe(200);
    expect((await A.post("/nope")).status).toBe(404);
    expect((await http(c.base, "DELETE", "/orders/ord_x")).status).toBe(404);
  });
});
