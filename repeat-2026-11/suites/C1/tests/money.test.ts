// Pure money rules of both apps: integer minor units only, half-even commission, conservation, bounds.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_SDK_MINOR, MoneyInputError, parseMinor, refundHoldsMoney as inlineHolds, sdkMinor as inlineSdk } from "../inline-marketplace/src/money.ts";
import * as w from "../worker-marketplace/src/money.ts";
import { feeOf } from "./helpers/harness.ts";

const amount = fc.bigInt({ min: 1n, max: 999_999_999_999n });

describe("commission (worker money.ts, independently re-stated oracle)", () => {
  it("matches an independent half-even oracle and never exceeds the amount", () => {
    fc.assert(
      fc.property(amount, (a) => {
        const fee = w.commissionOf(a);
        expect(fee).toBe(feeOf(a));
        expect(fee >= 0n && fee <= a).toBe(true);
        // within half a minor unit of the exact 10%
        expect((a * 1000n - fee * 10000n) ** 2n <= 25_000_000n).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
  it("rounds exact ties to even", () => {
    expect([5n, 15n, 25n, 35n, 45n, 55n].map(w.commissionOf)).toEqual([0n, 2n, 2n, 4n, 4n, 6n]);
    expect(w.divHalfEven(7n, 2n)).toBe(4n);
    expect(w.divHalfEven(5n, 2n)).toBe(2n);
    expect(() => w.divHalfEven(-1n, 2n)).toThrow();
    expect(() => w.divHalfEven(1n, 0n)).toThrow();
  });
  it("sale legs conserve money: they sum to zero and the clearing leg equals the order total", () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 1n, max: 1_000_000n }), { minLength: 1, maxLength: 20 }), (amts) => {
        const lines = amts.map((a, i) => ({ id: `l${i}`, seller: i % 2 ? "b" : "a", amount: a }));
        const total = amts.reduce((s, a) => s + a, 0n);
        const legs = w.saleLegs(total, lines);
        expect(w.sumLegs(legs)).toBe(0n);
        expect(legs[0]).toMatchObject({ account: "provider:clearing", amount: total });
        const seller = legs.filter((l) => l.account.startsWith("seller:")).reduce((s, l) => s - l.amount, 0n);
        const fees = legs.filter((l) => l.account === "platform:commission").reduce((s, l) => s - l.amount, 0n);
        expect(seller + fees).toBe(total);
        expect(fees).toBe(lines.reduce((s, l) => s + feeOf(l.amount), 0n));
        expect(legs.every((l) => l.amount !== 0n)).toBe(true);
      }),
    );
  });
});

describe("amount parsing is exact and refuses anything ambiguous", () => {
  const bad = [-1, 1.5, NaN, Infinity, 2 ** 53, 9007199254740993, "-1", "1.0", "1e3", "0x10", " 5", "", "9".repeat(40), null, undefined, {}, [], true];
  it("inline parseMinor", () => {
    for (const b of bad) if (b !== "") expect(() => parseMinor(b), String(b)).toThrow(MoneyInputError);
    expect(parseMinor(0)).toBe(0n);
    expect(parseMinor("000123")).toBe(123n);
    expect(parseMinor(Number.MAX_SAFE_INTEGER)).toBe(MAX_SDK_MINOR);
    expect(() => parseMinor((MAX_SDK_MINOR + 1n).toString())).toThrow(MoneyInputError);
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: MAX_SDK_MINOR }), (v) => parseMinor(v.toString()) === v && parseMinor(Number(v)) === v));
  });
  it("worker parseMinorUnits", () => {
    for (const b of bad) expect(w.parseMinorUnits(b), String(b)).toBeUndefined();
    expect(w.parseMinorUnits(0)).toBe(0n);
    expect(w.parseMinorUnits("999999999999")).toBe(999_999_999_999n);
    expect(w.parseMinorUnits("1000000000000")).toBeUndefined();
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: w.MAX_AMOUNT }), (v) => w.parseMinorUnits(v.toString()) === v && w.parseMinorUnits(Number(v)) === v));
  });
  it("SDK conversion round-trips exactly and refuses out-of-range money", () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: MAX_SDK_MINOR }), (v) => BigInt(inlineSdk(v)) === v));
    expect(() => inlineSdk(MAX_SDK_MINOR + 1n)).toThrow();
    expect(() => inlineSdk(-1n)).toThrow();
    expect(() => w.sdkMinor(w.MAX_AMOUNT + 1n)).toThrow();
    expect(() => w.providerMinor(1.5)).toThrow();
    expect(() => w.providerMinor("5")).toThrow();
    expect(w.providerMinor(250)).toBe(250n);
  });
});

describe("refund accounting rules", () => {
  const statuses = ["pending", "requires_action", "succeeded", "failed", "canceled"] as const;
  it("exactly pending, requires_action and succeeded hold money (both apps agree)", () => {
    for (const s of statuses) {
      expect(w.refundHoldsMoney(s)).toBe(inlineHolds(s));
      expect(w.refundHoldsMoney(s)).toBe(s === "pending" || s === "requires_action" || s === "succeeded");
    }
  });
  it("line headroom subtracts live refunds and reservations, never counts failed ones, can reach zero but is exact", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        fc.array(fc.record({ amount: fc.bigInt({ min: 1n, max: 1000n }), status: fc.constantFrom(...statuses) }), { maxLength: 8 }),
        fc.array(fc.bigInt({ min: 1n, max: 1000n }), { maxLength: 4 }),
        (line, refunds, reserved) => {
          const live = refunds.filter((r) => w.refundHoldsMoney(r.status)).reduce((s, r) => s + r.amount, 0n);
          const res = reserved.reduce((s, r) => s + r, 0n);
          expect(w.lineHeadroom(line, refunds, reserved)).toBe(line - live - res);
        },
      ),
    );
  });
  it("order status follows money facts only", () => {
    expect(w.deriveOrderStatus({ captured: 100n, refunded: 0n, payments: ["succeeded"] })).toBe("paid");
    expect(w.deriveOrderStatus({ captured: 100n, refunded: 1n, payments: ["succeeded"] })).toBe("partially_refunded");
    expect(w.deriveOrderStatus({ captured: 100n, refunded: 100n, payments: ["succeeded"] })).toBe("refunded");
    expect(w.deriveOrderStatus({ captured: 0n, refunded: 0n, payments: ["pending"] })).toBe("pending_payment");
    expect(w.deriveOrderStatus({ captured: 0n, refunded: 0n, payments: ["requires_capture"] })).toBe("authorized");
  });
  it("a stored payment only moves forward; succeeded and canceled are terminal", () => {
    const st = ["pending", "failed", "requires_capture", "succeeded", "canceled"] as const;
    for (const a of st) for (const b of st) {
      if (a === "succeeded" || a === "canceled") expect(w.paymentMayMove(a, b), `${a}->${b}`).toBe(false);
      if (a === "requires_capture" && (b === "pending" || b === "failed")) expect(w.paymentMayMove(a, b)).toBe(false);
    }
    expect(w.paymentMayMove("pending", "succeeded")).toBe(true);
    expect(w.paymentMayMove("requires_capture", "succeeded")).toBe(true);
  });
});
