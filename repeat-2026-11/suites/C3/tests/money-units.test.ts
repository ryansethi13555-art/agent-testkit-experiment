// Pure money rules of both applications: property tests on the arithmetic that decides how money is split,
// bounded and converted. No database, no provider. Both apps' own modules are exercised as black boxes.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as inlineMoney from "../inline-marketplace/src/money.ts";
import * as workerMoney from "../worker-marketplace/src/money.ts";

const amount = fc.bigInt({ min: 1n, max: 999_999_999_999n });
const refundStatus = fc.constantFrom("pending", "requires_action", "succeeded", "failed", "canceled" as const);

// Independent reference: exact rational 10% rounded half to even, written differently from the app's code.
function reference(a: bigint): bigint {
  const twice = a * 2n; // a/10 = twice/20
  const floor = a / 10n;
  const rem = a - floor * 10n;
  if (rem < 5n) return floor;
  if (rem > 5n) return floor + 1n;
  return floor % 2n === 0n ? floor : floor + 1n;
}

describe("worker app money rules", () => {
  it("commission is exactly 10% rounded half to even, never more than the line", () => {
    fc.assert(
      fc.property(amount, (a) => {
        const c = workerMoney.commissionOf(a);
        expect(c).toBe(reference(a));
        expect(c >= 0n && c <= a).toBe(true);
        // within half a minor unit of the true 10%
        expect(Math.abs(Number(c * 10n - a))).toBeLessThanOrEqual(5);
      }),
      { numRuns: 500 },
    );
  });

  it("half way amounts round to the even neighbour", () => {
    expect(workerMoney.commissionOf(5n)).toBe(0n);
    expect(workerMoney.commissionOf(15n)).toBe(2n);
    expect(workerMoney.commissionOf(25n)).toBe(2n);
    expect(workerMoney.commissionOf(35n)).toBe(4n);
    expect(workerMoney.commissionOf(1n)).toBe(0n);
    expect(workerMoney.commissionOf(0n)).toBe(0n);
  });

  it("sale legs net to zero, never lose a minor unit and never credit a negative amount", () => {
    fc.assert(
      fc.property(fc.array(amount, { minLength: 1, maxLength: 12 }), (parts) => {
        const lines = parts.map((a, i) => ({ id: `l${i}`, seller: i % 2 ? "seller_a" : "seller_b", amount: a }));
        const total = parts.reduce((x, y) => x + y, 0n);
        const legs = workerMoney.saleLegs(total, lines);
        expect(workerMoney.sumLegs(legs)).toBe(0n);
        expect(legs.filter((l) => l.account === "provider:clearing").reduce((x, l) => x + l.amount, 0n)).toBe(total);
        const credited = legs.filter((l) => l.account !== "provider:clearing").reduce((x, l) => x - l.amount, 0n);
        expect(credited).toBe(total);
        for (const l of legs) if (l.account !== "provider:clearing") expect(l.amount < 0n).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("line headroom is the line minus live refunds minus reservations, never counting failed or canceled refunds", () => {
    fc.assert(
      fc.property(
        amount,
        fc.array(fc.record({ amount: fc.bigInt({ min: 1n, max: 1000n }), status: refundStatus }), { maxLength: 8 }),
        fc.array(fc.bigInt({ min: 1n, max: 1000n }), { maxLength: 4 }),
        (line, refunds, reserved) => {
          const h = workerMoney.lineHeadroom(line, refunds as never, reserved);
          const live = refunds.filter((r) => !["failed", "canceled"].includes(r.status)).reduce((x, r) => x + r.amount, 0n);
          expect(h).toBe(line - live - reserved.reduce((x, y) => x + y, 0n));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("parseMinorUnits accepts only exact non negative integers within range", () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 999_999_999_999n }), (n) => {
      expect(workerMoney.parseMinorUnits(String(n))).toBe(n);
      if (n <= BigInt(Number.MAX_SAFE_INTEGER)) expect(workerMoney.parseMinorUnits(Number(n))).toBe(n);
    }));
    for (const bad of [-1, 1.5, NaN, Infinity, "1.5", "-1", "1e3", "", " 1", "0x1", "١٢٣", null, undefined, true, {}, [], 1e21, 9007199254740993, "1000000000000", "9".repeat(16)])
      expect(workerMoney.parseMinorUnits(bad), String(bad)).toBeUndefined();
    expect(() => workerMoney.providerMinor(1.5)).toThrow();
    expect(() => workerMoney.providerMinor("5")).toThrow();
    expect(() => workerMoney.sdkMinor(1_000_000_000_000n)).toThrow();
    expect(() => workerMoney.sdkMinor(-1n)).toThrow();
    expect(workerMoney.sdkMinor(999_999_999_999n)).toBe(999_999_999_999);
  });

  it("order status follows money facts only", () => {
    const f = workerMoney.deriveOrderStatus;
    expect(f({ captured: 100n, refunded: 0n, payments: ["succeeded"] })).toBe("paid");
    expect(f({ captured: 100n, refunded: 1n, payments: ["succeeded"] })).toBe("partially_refunded");
    expect(f({ captured: 100n, refunded: 100n, payments: ["succeeded"] })).toBe("refunded");
    expect(f({ captured: 0n, refunded: 0n, payments: ["failed"] })).toBe("pending_payment");
    expect(f({ captured: 0n, refunded: 0n, payments: ["requires_capture"] })).toBe("authorized");
    expect(f({ captured: 0n, refunded: 0n, payments: ["canceled"] })).toBe("canceled");
  });

  it("a stored payment only moves forward; succeeded and canceled are terminal", () => {
    const all = ["pending", "failed", "requires_capture", "succeeded", "canceled"] as const;
    for (const a of all) for (const b of all) {
      const ok = workerMoney.paymentMayMove(a, b);
      if (a === "succeeded" || a === "canceled") expect(ok, `${a}->${b}`).toBe(false);
      if (a === b) expect(ok).toBe(false);
    }
    expect(workerMoney.paymentMayMove("succeeded", "failed")).toBe(false);
    expect(workerMoney.paymentMayMove("pending", "succeeded")).toBe(true);
    expect(workerMoney.paymentMayMove("requires_capture", "pending")).toBe(false);
  });

  it("only pending, requires_action and succeeded refunds hold money", () => {
    for (const s of ["pending", "requires_action", "succeeded"] as const) expect(workerMoney.refundHoldsMoney(s)).toBe(true);
    for (const s of ["failed", "canceled"] as const) expect(workerMoney.refundHoldsMoney(s)).toBe(false);
  });
});

describe("inline app money rules", () => {
  it("parseMinor is exact for every safe integer and rejects everything else", () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: BigInt(Number.MAX_SAFE_INTEGER) }), (n) => {
      expect(inlineMoney.parseMinor(String(n))).toBe(n);
      expect(inlineMoney.parseMinor(Number(n))).toBe(n);
      expect(inlineMoney.sdkMinor(n)).toBe(Number(n));
    }));
    for (const bad of [-1, 1.5, NaN, Infinity, "1.5", "-1", "1e3", "", " 1", "0x1", null, undefined, true, {}, [], 1e21, 9007199254740993, "9007199254740993", "9".repeat(17)])
      expect(() => inlineMoney.parseMinor(bad), String(bad)).toThrow();
    expect(() => inlineMoney.sdkMinor(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow();
    expect(() => inlineMoney.sdkMinor(-1n)).toThrow();
  });

  it("leading zeros do not change the value", () => {
    expect(inlineMoney.parseMinor("000123")).toBe(123n);
    expect(inlineMoney.parseMinor("0")).toBe(0n);
  });

  it("only pending, requires_action and succeeded refunds hold money", () => {
    for (const s of ["pending", "requires_action", "succeeded"]) expect(inlineMoney.refundHoldsMoney(s)).toBe(true);
    for (const s of ["failed", "canceled", "weird", ""]) expect(inlineMoney.refundHoldsMoney(s)).toBe(false);
  });

  it("unknown provider refund statuses are refused, not guessed", () => {
    expect(() => inlineMoney.stripeRefundStatus("settled")).toThrow();
    expect(inlineMoney.stripeRefundStatus("succeeded")).toBe("succeeded");
  });
});
