import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_SDK_MINOR as INLINE_MAX_SDK_MINOR,
  MoneyInputError,
  parseMinor as inlineParseMinor,
  refundHoldsMoney as inlineRefundHoldsMoney,
  sdkMinor as inlineSdkMinor,
} from "../inline-marketplace/src/money.ts";
import {
  commissionOf as workerCommissionOf,
  deriveOrderStatus,
  divHalfEven,
  lineHeadroom,
  MAX_AMOUNT as WORKER_MAX_AMOUNT,
  parseMinorUnits as workerParseMinor,
  paymentMayMove,
  paymentRank,
  refundHoldsMoney as workerRefundHoldsMoney,
  saleLegs,
  sdkMinor as workerSdkMinor,
  sumLegs,
} from "../worker-marketplace/src/money.ts";

describe("Cross-Cutting Money Invariants & Property-Based Tests", () => {
  describe("Banker's Half-Even Rounding & Commission Split", () => {
    it("satisfies half-even rounding at exact .5 boundaries", () => {
      // Half-even rounds to nearest even integer when tie:
      // 5 * 10% = 0.5 -> 0 (even)
      // 15 * 10% = 1.5 -> 2 (even)
      // 25 * 10% = 2.5 -> 2 (even)
      // 35 * 10% = 3.5 -> 4 (even)
      // 45 * 10% = 4.5 -> 4 (even)
      // 55 * 10% = 5.5 -> 6 (even)
      expect(workerCommissionOf(5n)).toBe(0n);
      expect(workerCommissionOf(15n)).toBe(2n);
      expect(workerCommissionOf(25n)).toBe(2n);
      expect(workerCommissionOf(35n)).toBe(4n);
      expect(workerCommissionOf(45n)).toBe(4n);
      expect(workerCommissionOf(55n)).toBe(6n);
    });

    it("guarantees seller_amount + commission_amount === line_amount for all non-negative amounts", () => {
      fc.assert(
        fc.property(fc.bigInt({ min: 0n, max: 100_000_000_000n }), (amount) => {
          const fee = workerCommissionOf(amount);
          const seller = amount - fee;

          // Invariants:
          // 1. Fee is non-negative
          expect(fee >= 0n).toBe(true);
          // 2. Seller amount is non-negative
          expect(seller >= 0n).toBe(true);
          // 3. Fee never exceeds total
          expect(fee <= amount).toBe(true);
          // 4. Exact conservation of money (no penny lost or created)
          expect(seller + fee).toBe(amount);
        }),
        { numRuns: 1000 },
      );
    });

    it("verifies divHalfEven rejects negative numbers or non-positive denominators", () => {
      expect(() => divHalfEven(-1n, 10n)).toThrow(RangeError);
      expect(() => divHalfEven(10n, 0n)).toThrow(RangeError);
      expect(() => divHalfEven(10n, -5n)).toThrow(RangeError);
    });
  });

  describe("Double-Entry Ledger Balancing Properties", () => {
    it("guarantees saleLegs always sums to exactly 0n for any combination of order lines", () => {
      const lineArb = fc.record({
        id: fc.string({ minLength: 1, maxLength: 8 }),
        seller: fc.constantFrom("seller_a", "seller_b", "seller_c"),
        amount: fc.bigInt({ min: 1n, max: 50_000_000n }),
      });

      fc.assert(
        fc.property(fc.array(lineArb, { minLength: 1, maxLength: 10 }), (lines) => {
          const total = lines.reduce((acc, l) => acc + l.amount, 0n);
          const legs = saleLegs(total, lines);

          // Total sum of all legs must be exactly 0
          const sum = sumLegs(legs);
          expect(sum).toBe(0n);

          // Clearing leg must equal total
          const clearingLeg = legs.find((l) => l.account === "provider:clearing");
          expect(clearingLeg?.amount).toBe(total);
        }),
        { numRuns: 500 },
      );
    });
  });

  describe("Headroom Calculation & Over-Refund Prevention", () => {
    it("correctly computes headroom with arbitrary mixes of refund statuses and reservations", () => {
      const refundArb = fc.record({
        amount: fc.bigInt({ min: 1n, max: 1000n }),
        status: fc.constantFrom("pending", "requires_action", "succeeded", "failed", "canceled" as const),
      });

      fc.assert(
        fc.property(
          fc.bigInt({ min: 10_000n, max: 50_000n }),
          fc.array(refundArb, { minLength: 0, maxLength: 10 }),
          fc.array(fc.bigInt({ min: 1n, max: 500n }), { minLength: 0, maxLength: 5 }),
          (lineAmount, refunds, reserved) => {
            const headroom = lineHeadroom(lineAmount, refunds, reserved);

            // Calculate expected manually
            let expected = lineAmount;
            for (const r of refunds) {
              if (workerRefundHoldsMoney(r.status)) expected -= r.amount;
            }
            for (const res of reserved) {
              expected -= res;
            }

            expect(headroom).toBe(expected);
          },
        ),
      );
    });

    it("verifies refundHoldsMoney agreement across both applications", () => {
      const statuses = ["pending", "requires_action", "succeeded", "failed", "canceled", "unknown"];
      for (const s of statuses) {
        expect(inlineRefundHoldsMoney(s)).toBe(workerRefundHoldsMoney(s as any));
      }
    });
  });

  describe("Money Input Parsing & Strict Validation", () => {
    it("rejects non-integers, floats, negative numbers, scientific notation and overflow", () => {
      const invalidInputs = [
        -1,
        -100,
        0.5,
        1.99,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
        "-10",
        "10.5",
        "1e5",
        "1.0",
        "",
        " ",
        "abc",
        "0x10",
        null,
        undefined,
        {},
        [],
      ];

      for (const input of invalidInputs) {
        // worker parser returns undefined for invalid inputs
        expect(workerParseMinor(input)).toBeUndefined();
        // inline parser throws MoneyInputError
        expect(() => inlineParseMinor(input)).toThrow(MoneyInputError);
      }
    });

    it("accepts valid safe integer numbers and clean digit strings", () => {
      const validInputs = [
        { in: 0, out: 0n },
        { in: 100, out: 100n },
        { in: 1000000, out: 1000000n },
        { in: "0", out: 0n },
        { in: "100", out: 100n },
        { in: "999999999999", out: 999999999999n },
      ];

      for (const { in: val, out: expected } of validInputs) {
        expect(workerParseMinor(val)).toBe(expected);
        expect(inlineParseMinor(val)).toBe(expected);
      }
    });

    it("verifies sdkMinor limits and conversions", () => {
      expect(workerSdkMinor(100n)).toBe(100);
      expect(inlineSdkMinor(100n)).toBe(100);

      expect(() => workerSdkMinor(-1n)).toThrow(RangeError);
      expect(() => inlineSdkMinor(-1n)).toThrow(MoneyInputError);

      expect(() => workerSdkMinor(WORKER_MAX_AMOUNT + 1n)).toThrow(RangeError);
      expect(() => inlineSdkMinor(INLINE_MAX_SDK_MINOR + 1n)).toThrow(MoneyInputError);
    });
  });

  describe("Payment State Machine Monotonicity", () => {
    it("ensures terminal payment states (succeeded, canceled) can never move backwards or change", () => {
      expect(paymentRank("pending")).toBe(0);
      expect(paymentRank("failed")).toBe(0);
      expect(paymentRank("requires_capture")).toBe(1);
      expect(paymentRank("succeeded")).toBe(2);
      expect(paymentRank("canceled")).toBe(2);

      // Succeeded is terminal: cannot move to any other state
      expect(paymentMayMove("succeeded", "pending")).toBe(false);
      expect(paymentMayMove("succeeded", "failed")).toBe(false);
      expect(paymentMayMove("succeeded", "requires_capture")).toBe(false);
      expect(paymentMayMove("succeeded", "canceled")).toBe(false);
      expect(paymentMayMove("succeeded", "succeeded")).toBe(false);

      // Canceled is terminal
      expect(paymentMayMove("canceled", "succeeded")).toBe(false);
      expect(paymentMayMove("canceled", "pending")).toBe(false);

      // Valid forward progressions:
      expect(paymentMayMove("pending", "requires_capture")).toBe(true);
      expect(paymentMayMove("pending", "succeeded")).toBe(true);
      expect(paymentMayMove("requires_capture", "succeeded")).toBe(true);
      expect(paymentMayMove("requires_capture", "canceled")).toBe(true);
    });

    it("derives order status consistently from captured and refunded money facts", () => {
      // 1. Captured > 0, refunded == 0 -> paid
      expect(deriveOrderStatus({ captured: 1000n, refunded: 0n, payments: ["succeeded"] })).toBe("paid");

      // 2. Captured > 0, 0 < refunded < captured -> partially_refunded
      expect(deriveOrderStatus({ captured: 1000n, refunded: 500n, payments: ["succeeded"] })).toBe("partially_refunded");

      // 3. Captured > 0, refunded >= captured -> refunded
      expect(deriveOrderStatus({ captured: 1000n, refunded: 1000n, payments: ["succeeded"] })).toBe("refunded");
      expect(deriveOrderStatus({ captured: 1000n, refunded: 1200n, payments: ["succeeded"] })).toBe("refunded");

      // 4. No captured, requires_capture -> authorized
      expect(deriveOrderStatus({ captured: 0n, refunded: 0n, payments: ["requires_capture"] })).toBe("authorized");

      // 5. No captured, all canceled -> canceled
      expect(deriveOrderStatus({ captured: 0n, refunded: 0n, payments: ["canceled"] })).toBe("canceled");

      // 6. Default -> pending_payment
      expect(deriveOrderStatus({ captured: 0n, refunded: 0n, payments: ["pending"] })).toBe("pending_payment");
      expect(deriveOrderStatus({ captured: 0n, refunded: 0n, payments: [] })).toBe("pending_payment");
    });
  });
});
