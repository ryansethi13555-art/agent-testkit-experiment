// Pure money rules of both apps: exact integer arithmetic, parsing discipline, state machines.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_SDK_MINOR, MoneyInputError, parseMinor, refundHoldsMoney as inlineHolds, sdkMinor as inlineSdk, stripeRefundStatus } from "../../inline-marketplace/src/money.ts";
import * as w from "../../worker-marketplace/src/money.ts";

/** independent reference for n/d rounded half to even (n >= 0, d > 0) */
function refHalfEven(n: bigint, d: bigint): bigint {
  const twice = 2n * n + d; // round-half-up of n/d is floor(twice / 2d)
  let q = twice / (2n * d);
  if (twice % (2n * d) === 0n && q % 2n === 1n) q -= 1n; // exact tie landed on an odd number: step to the even one
  return q;
}
const amt = fc.oneof(fc.bigInt({ min: 0n, max: 100n }), fc.bigInt({ min: 0n, max: 999_999_999_999n }));

describe("rounding and commission", () => {
  it("divHalfEven matches an independent reference and brackets the true quotient", () => {
    fc.assert(
      fc.property(amt, fc.bigInt({ min: 1n, max: 100_000n }), (n, d) => {
        const q = w.divHalfEven(n, d);
        expect(q).toBe(refHalfEven(n, d));
        expect(2n * (q * d - n) <= d && 2n * (n - q * d) <= d).toBe(true);
      }),
    );
  });
  it("documented ties: 0.5->0, 1.5->2, 2.5->2, 3.5->4", () => {
    expect([1n, 3n, 5n, 7n].map((n) => w.divHalfEven(n, 2n))).toEqual([0n, 2n, 2n, 4n]);
  });
  it("commission is 10 percent within half a minor unit, never negative, never above the line; seller + fee = line", () => {
    fc.assert(
      fc.property(amt, (a) => {
        const fee = w.commissionOf(a);
        expect(fee >= 0n && fee <= a).toBe(true);
        expect(Math.abs(Number(fee * 10n - a)) <= 5).toBe(true);
        expect(a - fee + fee).toBe(a);
      }),
    );
    expect([w.commissionOf(0n), w.commissionOf(1n), w.commissionOf(5n), w.commissionOf(15n), w.commissionOf(25n), w.commissionOf(100n)]).toEqual([0n, 0n, 0n, 2n, 2n, 10n]);
  });
  it("divHalfEven refuses negative numerators and non positive denominators", () => {
    expect(() => w.divHalfEven(-1n, 2n)).toThrow();
    expect(() => w.divHalfEven(1n, 0n)).toThrow();
  });
  it("sale legs always net to zero, credit each line exactly and never contain zero legs", () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 1n, max: 5_000_000n }), { minLength: 1, maxLength: 8 }), (amounts) => {
        const lines = amounts.map((a, i) => ({ id: `l${i}`, seller: i % 2 ? "b" : "a", amount: a }));
        const total = amounts.reduce((s, a) => s + a, 0n);
        const legs = w.saleLegs(total, lines);
        expect(w.sumLegs(legs)).toBe(0n);
        expect(legs.every((l) => l.amount !== 0n)).toBe(true);
        for (const l of lines) {
          const got = legs.filter((x) => x.effectRef === `allocation:${l.id}`).reduce((s, x) => s - x.amount, 0n);
          expect(got).toBe(l.amount);
        }
        expect(legs[0]).toMatchObject({ account: "provider:clearing", amount: total });
      }),
    );
  });
});

describe("amount parsing (no floats, no rounding, no overflow)", () => {
  it("worker parseMinorUnits accepts only safe non-negative integers and digit strings within range", () => {
    expect(w.parseMinorUnits(0)).toBe(0n);
    expect(w.parseMinorUnits(12345)).toBe(12345n);
    expect(w.parseMinorUnits("00012")).toBe(12n);
    expect(w.parseMinorUnits(w.MAX_AMOUNT)).toBe(undefined); // bigint is not JSON
    expect(w.parseMinorUnits(Number(w.MAX_AMOUNT))).toBe(w.MAX_AMOUNT);
    for (const bad of [1.5, -1, NaN, Infinity, 2 ** 53, Number(w.MAX_AMOUNT) + 1, "1.5", "-1", "1e3", " 1", "1 ", "", "0x10", "١٢٣", null, undefined, true, {}, [], "9".repeat(16)])
      expect(w.parseMinorUnits(bad), String(bad)).toBeUndefined();
  });
  it("inline parseMinor rejects the same family and is exact up to the safe integer range", () => {
    expect(parseMinor("9007199254740991")).toBe(MAX_SDK_MINOR);
    expect(parseMinor("0009")).toBe(9n);
    for (const bad of [1.5, -1, NaN, 2 ** 53, "9007199254740992", "1.0", "1e3", "-0", "", " 5", null, undefined, true, "9".repeat(40)])
      expect(() => parseMinor(bad as never), String(bad)).toThrow(MoneyInputError);
  });
  it("SDK conversion round trips exactly and refuses what a double cannot hold", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX_SDK_MINOR }), (v) => {
        expect(BigInt(inlineSdk(v))).toBe(v);
      }),
    );
    expect(() => inlineSdk(MAX_SDK_MINOR + 1n)).toThrow();
    expect(() => inlineSdk(-1n)).toThrow();
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: w.MAX_AMOUNT }), (v) => {
        expect(BigInt(w.sdkMinor(v))).toBe(v);
      }),
    );
    expect(() => w.sdkMinor(w.MAX_AMOUNT + 1n)).toThrow();
    expect(w.providerMinor(5)).toBe(5n);
    for (const bad of [5.5, "5", -1, Number.MAX_SAFE_INTEGER, null]) expect(() => w.providerMinor(bad)).toThrow();
  });
});

describe("state machines", () => {
  const statuses = w.REFUND_STATUSES;
  it("refund status: exactly pending, requires_action and succeeded hold money (both apps agree)", () => {
    for (const s of statuses) expect(w.refundHoldsMoney(s)).toBe(["pending", "requires_action", "succeeded"].includes(s));
    for (const s of statuses) expect(inlineHolds(s)).toBe(w.refundHoldsMoney(s));
    expect(w.isRefundStatus("processed")).toBe(false);
    expect(() => stripeRefundStatus("processed")).toThrow();
    expect(() => stripeRefundStatus(undefined)).toThrow();
  });
  it("payment status only moves forward; success and cancel are terminal; failed may retry", () => {
    const all = w.PAYMENT_STATUSES;
    for (const a of all) for (const b of all) {
      const ok = w.paymentMayMove(a, b);
      if (a === b) expect(ok).toBe(false);
      if (a === "succeeded" || a === "canceled") expect(ok, `${a}->${b}`).toBe(false);
      if (a === "requires_capture" && (b === "pending" || b === "failed")) expect(ok, `${a}->${b}`).toBe(false);
    }
    expect(w.paymentMayMove("failed", "pending")).toBe(true);
    expect(w.paymentMayMove("pending", "succeeded")).toBe(true);
    expect(w.paymentMayMove("requires_capture", "succeeded")).toBe(true);
  });
  it("line headroom = line - live refunds - reservations, and never counts failed or canceled refunds", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000n }),
        fc.array(fc.record({ amount: fc.bigInt({ min: 1n, max: 500n }), status: fc.constantFrom(...statuses) }), { maxLength: 6 }),
        fc.array(fc.bigInt({ min: 1n, max: 500n }), { maxLength: 4 }),
        (line, refunds, reserved) => {
          const live = refunds.filter((r) => w.refundHoldsMoney(r.status)).reduce((s, r) => s + r.amount, 0n);
          const res = reserved.reduce((s, x) => s + x, 0n);
          expect(w.lineHeadroom(line, refunds, reserved)).toBe(line - live - res);
        },
      ),
    );
  });
  it("order status derives from money facts only", () => {
    const d = w.deriveOrderStatus;
    expect(d({ captured: 0n, refunded: 0n, payments: [] })).toBe("pending_payment");
    expect(d({ captured: 0n, refunded: 0n, payments: ["failed", "pending"] })).toBe("pending_payment");
    expect(d({ captured: 0n, refunded: 0n, payments: ["requires_capture"] })).toBe("authorized");
    expect(d({ captured: 0n, refunded: 0n, payments: ["canceled", "canceled"] })).toBe("canceled");
    expect(d({ captured: 100n, refunded: 0n, payments: ["succeeded"] })).toBe("paid");
    expect(d({ captured: 100n, refunded: 1n, payments: ["succeeded"] })).toBe("partially_refunded");
    expect(d({ captured: 100n, refunded: 100n, payments: ["succeeded"] })).toBe("refunded");
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 1000n }), fc.bigInt({ min: 0n, max: 1000n }), (c, r) => {
        const s = d({ captured: c, refunded: r, payments: ["succeeded"] });
        expect(s).toBe(r === 0n ? "paid" : r >= c ? "refunded" : "partially_refunded");
      }),
    );
  });
});
