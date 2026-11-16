// Pure money rules of both apps: integer parsing, commission rounding, ledger leg construction, state machines.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as inl from "../inline-marketplace/src/money.ts";
import { backoffMs } from "../worker-marketplace/src/jobs.ts";
import * as wk from "../worker-marketplace/src/money.ts";

/** Independent oracle: round-half-even of a/10 using the last digit only. */
function oracleFee(a: bigint): bigint {
  const last = a % 10n;
  const base = (a - last) / 10n;
  if (last < 5n) return base;
  if (last > 5n) return base + 1n;
  return base % 2n === 0n ? base : base + 1n;
}

describe("worker money: commission and ledger legs", () => {
  it("commission is round-half-even 10%, matches an independent oracle, and never exceeds the line", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: wk.MAX_AMOUNT }), (a) => {
        const fee = wk.commissionOf(a);
        expect(fee).toBe(oracleFee(a));
        expect(fee >= 0n && fee <= a).toBe(true);
        expect(a - fee >= 0n).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it.each([
    [1n, 0n], [4n, 0n], [5n, 0n], [6n, 1n], [14n, 1n], [15n, 2n], [16n, 2n], [25n, 2n], [35n, 4n], [10n, 1n], [100n, 10n], [99n, 10n],
  ])("commission of %s is %s", (a, fee) => {
    expect(wk.commissionOf(a)).toBe(fee);
  });

  it("sale legs always sum to zero, debit clearing with the whole capture and omit no money", () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 1n, max: 10_000_000_000n }), { minLength: 1, maxLength: 20 }), (amounts) => {
        const lines = amounts.map((amount, i) => ({ id: `l${i}`, seller: i % 2 ? "s1" : "s2", amount }));
        const total = amounts.reduce((s, a) => s + a, 0n);
        const legs = wk.saleLegs(total, lines);
        expect(wk.sumLegs(legs)).toBe(0n);
        expect(legs[0]).toMatchObject({ account: "provider:clearing", amount: total });
        for (const l of lines) {
          const mine = legs.filter((g) => g.effectRef === `allocation:${l.id}`);
          expect(-mine.reduce((s, g) => s + g.amount, 0n)).toBe(l.amount);
        }
        expect(legs.every((g) => g.amount !== 0n || g === legs[0])).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("divHalfEven rejects negative numerators and non-positive denominators", () => {
    expect(() => wk.divHalfEven(-1n, 10n)).toThrow();
    expect(() => wk.divHalfEven(1n, 0n)).toThrow();
  });
});

describe("worker money: parsing", () => {
  it.each([
    [0, 0n], [1, 1n], ["0", 0n], ["000123", 123n], ["999999999999", 999_999_999_999n], [999_999_999_999, 999_999_999_999n],
  ])("accepts %j", (v, out) => expect(wk.parseMinorUnits(v)).toBe(out));
  it.each([
    [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], [1e21], ["1.0"], ["1e3"], ["-1"], ["+1"], [" 1"], ["1 "], [""], ["0x10"],
    ["1000000000000"], [1_000_000_000_000], [9007199254740993], [null], [undefined], [true], [{}], [[]], ["١٢٣"], ["1_000"],
    ["1234567890123456"],
  ])("rejects %j", (v) => expect(wk.parseMinorUnits(v)).toBeUndefined());

  it("provider money must be an exact JSON integer", () => {
    expect(wk.providerMinor(100)).toBe(100n);
    for (const bad of ["100", 1.5, -1, null, undefined, 1e15, Number.NaN]) expect(() => wk.providerMinor(bad)).toThrow();
  });
  it("SDK conversion is bounded to the exact domain", () => {
    expect(wk.sdkMinor(wk.MAX_AMOUNT)).toBe(999_999_999_999);
    expect(() => wk.sdkMinor(wk.MAX_AMOUNT + 1n)).toThrow();
    expect(() => wk.sdkMinor(-1n)).toThrow();
  });
});

describe("inline money: parsing and refund state", () => {
  it.each([[0, 0n], ["0", 0n], ["0009", 9n], [9007199254740991, 9007199254740991n], ["9007199254740991", 9007199254740991n]])("accepts %j", (v, out) =>
    expect(inl.parseMinor(v)).toBe(out));
  it.each([[-1], [1.5], [9007199254740992], ["9007199254740992"], ["12345678901234567"], ["1.0"], ["1e2"], [""], ["-0"], [null], [undefined], [true], [[]]])(
    "rejects %j",
    (v) => expect(() => inl.parseMinor(v)).toThrow(inl.MoneyInputError),
  );
  it("SDK conversion round trips inside the exact domain only", () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: inl.MAX_SDK_MINOR }), (v) => BigInt(inl.sdkMinor(v)) === v));
    expect(() => inl.sdkMinor(inl.MAX_SDK_MINOR + 1n)).toThrow();
    expect(() => inl.sdkMinor(-1n)).toThrow();
  });
  it("only pending, requires_action and succeeded refunds hold money", () => {
    for (const s of ["pending", "requires_action", "succeeded"]) expect(inl.refundHoldsMoney(s)).toBe(true);
    for (const s of ["failed", "canceled", "weird", ""]) expect(inl.refundHoldsMoney(s)).toBe(false);
    expect(() => inl.stripeRefundStatus("weird")).toThrow();
    expect(inl.stripeRefundStatus("canceled")).toBe("canceled");
  });
});

describe("worker money: state machines", () => {
  const holds = ["pending", "requires_action", "succeeded"] as const;
  it("refund holds money exactly while pending/requires_action/succeeded", () => {
    for (const s of holds) expect(wk.refundHoldsMoney(s)).toBe(true);
    expect(wk.refundHoldsMoney("failed")).toBe(false);
    expect(wk.refundHoldsMoney("canceled")).toBe(false);
    expect(wk.isRefundStatus("processed")).toBe(false);
  });

  it("line headroom subtracts live refunds and reservations, ignores failed/canceled", () => {
    expect(wk.lineHeadroom(1000n, [], [])).toBe(1000n);
    expect(
      wk.lineHeadroom(
        1000n,
        [
          { amount: 100n, status: "succeeded" },
          { amount: 200n, status: "pending" },
          { amount: 300n, status: "requires_action" },
          { amount: 400n, status: "failed" },
          { amount: 500n, status: "canceled" },
        ],
        [50n, 25n],
      ),
    ).toBe(325n);
  });

  it("payment status only moves forward; succeeded and canceled are terminal", () => {
    const all = wk.PAYMENT_STATUSES;
    for (const from of all)
      for (const to of all) {
        const may = wk.paymentMayMove(from, to);
        if (from === to) expect(may).toBe(false);
        if (from === "succeeded" || from === "canceled") expect(may).toBe(false);
        if (from === "requires_capture" && (to === "pending" || to === "failed")) expect(may).toBe(false);
      }
    expect(wk.paymentMayMove("pending", "succeeded")).toBe(true);
    expect(wk.paymentMayMove("failed", "pending")).toBe(true);
    expect(wk.paymentMayMove("pending", "requires_capture")).toBe(true);
    expect(wk.paymentMayMove("requires_capture", "succeeded")).toBe(true);
    expect(wk.paymentMayMove("requires_capture", "canceled")).toBe(true);
  });

  it("order status follows money facts", () => {
    expect(wk.deriveOrderStatus({ captured: 0n, refunded: 0n, payments: [] })).toBe("pending_payment");
    expect(wk.deriveOrderStatus({ captured: 0n, refunded: 0n, payments: ["failed"] })).toBe("pending_payment");
    expect(wk.deriveOrderStatus({ captured: 0n, refunded: 0n, payments: ["requires_capture"] })).toBe("authorized");
    expect(wk.deriveOrderStatus({ captured: 0n, refunded: 0n, payments: ["canceled", "canceled"] })).toBe("canceled");
    expect(wk.deriveOrderStatus({ captured: 0n, refunded: 0n, payments: ["canceled", "pending"] })).toBe("pending_payment");
    expect(wk.deriveOrderStatus({ captured: 100n, refunded: 0n, payments: ["succeeded"] })).toBe("paid");
    expect(wk.deriveOrderStatus({ captured: 100n, refunded: 1n, payments: ["succeeded"] })).toBe("partially_refunded");
    expect(wk.deriveOrderStatus({ captured: 100n, refunded: 99n, payments: ["succeeded"] })).toBe("partially_refunded");
    expect(wk.deriveOrderStatus({ captured: 100n, refunded: 100n, payments: ["succeeded"] })).toBe("refunded");
    expect(wk.deriveOrderStatus({ captured: 100n, refunded: 0n, payments: ["succeeded", "requires_capture"] })).toBe("paid");
  });

  it("job retry backoff doubles from 100ms and is capped at 2s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map(backoffMs)).toEqual([100, 200, 400, 800, 1600, 2000, 2000, 2000]);
    expect(backoffMs(0)).toBe(100);
  });
});
