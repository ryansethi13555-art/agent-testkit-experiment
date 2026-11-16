// worker-marketplace: pure money rules (src/money.ts) and job queue arithmetic. No database needed.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { backoffMs } from "../../worker-marketplace/src/jobs.ts";
import {
  commissionOf,
  deriveOrderStatus,
  divHalfEven,
  lineHeadroom,
  MAX_AMOUNT,
  PAYMENT_STATUSES,
  parseMinorUnits,
  paymentMayMove,
  paymentRank,
  providerMinor,
  REFUND_STATUSES,
  refundHoldsMoney,
  saleLegs,
  sdkMinor,
  sumLegs,
} from "../../worker-marketplace/src/money.ts";
import { parseMinor, refundHoldsMoney as inlineHolds, sdkMinor as inlineSdk, stripeRefundStatus } from "../../inline-marketplace/src/money.ts";
import { realRazorpay } from "../helpers/workerHarness.ts";
import { refCommission } from "../helpers/world.ts";

const amount = fc.bigInt({ min: 1n, max: 999_999_999_999n });

describe("worker money.ts", () => {
  it("commission is exactly 10% rounded half to even, and net + fee = amount", () => {
    fc.assert(
      fc.property(amount, (a) => {
        const fee = commissionOf(a);
        expect(fee).toBe(refCommission(a));
        expect(fee >= 0n && fee <= a).toBe(true);
        // within half a unit of the exact rational 10%
        expect((fee * 10n - a) * 2n <= 10n && (a - fee * 10n) * 2n <= 10n).toBe(true);
      }),
      { numRuns: 500 },
    );
    expect([0n, 1n, 2n, 5n, 15n, 25n, 35n, 45n, 55n, 95n].map(commissionOf)).toEqual([0n, 0n, 0n, 0n, 2n, 2n, 4n, 4n, 6n, 10n]);
  });
  it("divHalfEven matches an exact reference on small values and rejects bad input", () => {
    for (let n = 0n; n < 200n; n++)
      for (const d of [1n, 2n, 3n, 4n, 7n, 10n]) {
        const exact = Number(n) / Number(d);
        const got = Number(divHalfEven(n, d));
        const lo = Math.floor(exact);
        const frac = exact - lo;
        const want = frac > 0.5 ? lo + 1 : frac < 0.5 ? lo : lo % 2 === 0 ? lo : lo + 1;
        expect(got).toBe(want);
      }
    expect(() => divHalfEven(-1n, 3n)).toThrow();
    expect(() => divHalfEven(1n, 0n)).toThrow();
  });
  it("sale legs always balance and credit each seller line minus its commission", () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 1n, max: 100_000_000n }), { minLength: 1, maxLength: 20 }), (amts) => {
        const lines = amts.map((a, i) => ({ id: `l${i}`, seller: i % 2 ? "b" : "a", amount: a }));
        const total = amts.reduce((s, a) => s + a, 0n);
        const legs = saleLegs(total, lines);
        expect(sumLegs(legs)).toBe(0n);
        expect(legs.find((l) => l.account === "provider:clearing")?.amount).toBe(total);
        for (const l of lines) {
          const net = legs.filter((x) => x.effectRef === `allocation:${l.id}`).reduce((s, x) => s - x.amount, 0n);
          expect(net).toBe(l.amount);
        }
        expect(legs.every((l) => l.amount !== 0n)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
  it("parseMinorUnits accepts only exact non-negative integers within the domain", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (n) => {
        const out = parseMinorUnits(n);
        if (BigInt(n) <= MAX_AMOUNT) expect(out).toBe(BigInt(n));
        else expect(out).toBeUndefined();
      }),
    );
    for (const bad of [-1, 1.5, NaN, Infinity, 2 ** 53, "1.5", "-1", "1e3", " 1", "", "0x10", "1".repeat(16), null, undefined, {}, [], true, 10n])
      expect(parseMinorUnits(bad as never), String(bad)).toBeUndefined();
    expect(parseMinorUnits("0")).toBe(0n);
    expect(parseMinorUnits("999999999999")).toBe(MAX_AMOUNT);
    expect(parseMinorUnits("1000000000000")).toBeUndefined();
    expect(parseMinorUnits("007")).toBe(7n);
  });
  it("provider money must be an exact JSON integer in range", () => {
    expect(providerMinor(5)).toBe(5n);
    for (const bad of ["5", 5.5, -1, 2 ** 60, null, undefined]) expect(() => providerMinor(bad)).toThrow();
    expect(() => sdkMinor(-1n)).toThrow();
    expect(() => sdkMinor(MAX_AMOUNT + 1n)).toThrow();
    expect(sdkMinor(MAX_AMOUNT)).toBe(Number(MAX_AMOUNT));
  });
  it("refund statuses: exactly pending, requires_action and succeeded hold money", () => {
    expect(REFUND_STATUSES.filter(refundHoldsMoney)).toEqual(["pending", "requires_action", "succeeded"]);
    expect((["pending", "requires_action", "succeeded", "failed", "canceled"] as const).filter(inlineHolds)).toEqual(["pending", "requires_action", "succeeded"]);
    expect(() => stripeRefundStatus("weird")).toThrow();
  });
  it("line headroom subtracts live refunds and reservations only", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000n }),
        fc.array(fc.record({ amount: fc.bigInt({ min: 1n, max: 500n }), status: fc.constantFrom(...REFUND_STATUSES) }), { maxLength: 8 }),
        fc.array(fc.bigInt({ min: 1n, max: 500n }), { maxLength: 4 }),
        (line, refunds, reserved) => {
          const live = refunds.filter((r) => refundHoldsMoney(r.status)).reduce((s, r) => s + r.amount, 0n);
          expect(lineHeadroom(line, refunds, reserved)).toBe(line - live - reserved.reduce((s, x) => s + x, 0n));
        },
      ),
    );
  });
  it("payment status only moves forward; terminal states never change", () => {
    for (const from of PAYMENT_STATUSES)
      for (const to of PAYMENT_STATUSES) {
        const may = paymentMayMove(from, to);
        if (from === to) expect(may).toBe(false);
        if (paymentRank(from) === 2) expect(may).toBe(false);
        if (may) expect(paymentRank(to)).toBeGreaterThanOrEqual(paymentRank(from));
      }
    expect(paymentMayMove("requires_capture", "pending")).toBe(false);
    expect(paymentMayMove("succeeded", "requires_capture")).toBe(false);
    expect(paymentMayMove("succeeded", "canceled")).toBe(false);
    expect(paymentMayMove("pending", "succeeded")).toBe(true);
  });
  it("order status follows money, not event order", () => {
    expect(deriveOrderStatus({ captured: 100n, refunded: 0n, payments: ["succeeded"] })).toBe("paid");
    expect(deriveOrderStatus({ captured: 100n, refunded: 40n, payments: ["succeeded"] })).toBe("partially_refunded");
    expect(deriveOrderStatus({ captured: 100n, refunded: 100n, payments: ["succeeded"] })).toBe("refunded");
    expect(deriveOrderStatus({ captured: 0n, refunded: 0n, payments: ["requires_capture"] })).toBe("authorized");
    expect(deriveOrderStatus({ captured: 0n, refunded: 0n, payments: ["canceled", "canceled"] })).toBe("canceled");
    expect(deriveOrderStatus({ captured: 0n, refunded: 0n, payments: [] })).toBe("pending_payment");
    expect(deriveOrderStatus({ captured: 0n, refunded: 0n, payments: ["failed", "canceled"] })).toBe("pending_payment");
  });
  it("retry backoff is monotonic and capped", () => {
    let prev = 0;
    for (let n = 0; n < 40; n++) {
      const b = backoffMs(n);
      expect(b).toBeGreaterThanOrEqual(prev);
      expect(b).toBeLessThanOrEqual(2000);
      prev = b;
    }
    expect([backoffMs(1), backoffMs(2), backoffMs(3)]).toEqual([100, 200, 400]);
  });
});

describe("inline money.ts", () => {
  it("parseMinor accepts only exact safe integers and digit strings", () => {
    expect(parseMinor("0012")).toBe(12n);
    expect(parseMinor(Number.MAX_SAFE_INTEGER)).toBe(BigInt(Number.MAX_SAFE_INTEGER));
    expect(parseMinor("9007199254740991")).toBe(9007199254740991n);
    for (const bad of [-1, 1.5, NaN, 2 ** 53, "9007199254740992", "1.0", "-0", "1e3", "", " 5", null, undefined, true, 5n, "9".repeat(17)])
      expect(() => parseMinor(bad), String(bad)).toThrow();
  });
  it("sdkMinor refuses values outside the exact range", () => {
    expect(inlineSdk(10n)).toBe(10);
    expect(() => inlineSdk(-1n)).toThrow();
    expect(() => inlineSdk(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow();
  });
});

describe("provider adapters (pure parts)", () => {
  it("Razorpay's INR minimum refund is 100 minor units and applies to INR only", () => {
    const f = realRazorpay.refundRequestError!;
    expect(f(99n, "INR")).toBeTruthy();
    expect(f(100n, "INR")).toBeUndefined();
    expect(f(1n, "USD")).toBeUndefined();
  });
});
