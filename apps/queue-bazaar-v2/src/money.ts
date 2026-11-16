// Pure money rules of QueueBazaar: integer minor units only (bigint), explicit rounding, no I/O.
// Everything that decides an amount or a derived status lives here so it can be unit-tested in isolation.

/** Platform commission per order line: 10 %, rounded half-even to the minor unit. */
export const COMMISSION = { num: 1000n, den: 10000n, rounding: "half_even" } as const;

/** n / d rounded half-to-even, for n ≥ 0 and d > 0 (integers only). */
export function divHalfEven(n: bigint, d: bigint): bigint {
  if (n < 0n || d <= 0n) throw new RangeError("divHalfEven expects n >= 0 and d > 0");
  const q = n / d;
  const r = n % d;
  if (r * 2n > d) return q + 1n;
  if (r * 2n === d && q % 2n === 1n) return q + 1n;
  return q;
}

/** The commission part of a line amount; the seller receives the remainder (amount - commission). */
export function commissionOf(amount: bigint): bigint {
  return divHalfEven(amount * COMMISSION.num, COMMISSION.den);
}

/** Largest amount accepted from the API (12 digits of minor units; also below 2^53 for SDKs that take numbers). */
export const MAX_AMOUNT = 999_999_999_999n;

/**
 * Parse an amount in minor units from untrusted JSON: a non-negative safe integer number, or a string of digits.
 * Returns undefined for anything else (fractions, negatives, exponents, empty, too large). Zero is returned as 0n so
 * callers can reject it with a precise message.
 */
export function parseMinorUnits(v: unknown): bigint | undefined {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) return undefined;
    const b = BigInt(v);
    return b <= MAX_AMOUNT ? b : undefined;
  }
  if (typeof v === "string" && /^[0-9]{1,15}$/.test(v)) {
    const b = BigInt(v);
    return b <= MAX_AMOUNT ? b : undefined;
  }
  return undefined;
}

// --------------------------------------------------------------------------------------------- refunds
export const REFUND_STATUSES = ["pending", "requires_action", "succeeded", "failed", "canceled"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export function isRefundStatus(s: unknown): s is RefundStatus {
  return typeof s === "string" && (REFUND_STATUSES as readonly string[]).includes(s);
}

/**
 * Does a refund in this provider status hold money against the payment? pending / requires_action / succeeded: yes
 * (the provider has accepted it and counts it against the refundable amount; the money is out or owed to the buyer).
 * failed / canceled: no (no money left, or it came back). The ledger recognises a refund exactly while this is true.
 */
export function refundHoldsMoney(status: RefundStatus): boolean {
  return status === "pending" || status === "requires_action" || status === "succeeded";
}

/**
 * How much more may be refunded on a line: its amount minus refunds that hold money minus refund requests whose
 * outcome is not known yet (reserved, so a lost response can never let a second request over-refund the line).
 */
export function lineHeadroom(
  lineAmount: bigint,
  refunds: readonly { amount: bigint; status: RefundStatus }[],
  reserved: readonly bigint[],
): bigint {
  let left = lineAmount;
  for (const r of refunds) if (refundHoldsMoney(r.status)) left -= r.amount;
  for (const x of reserved) left -= x;
  return left;
}

// --------------------------------------------------------------------------------------------- payments
export const PAYMENT_STATUSES = ["pending", "failed", "requires_capture", "succeeded", "canceled"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Progress rank of a payment status. A snapshot may only move a stored payment forward (or sideways among the
 * non-money states pending/failed: a failed attempt can be retried). succeeded and canceled are terminal.
 */
export function paymentRank(s: PaymentStatus): number {
  switch (s) {
    case "pending":
    case "failed":
      return 0;
    case "requires_capture":
      return 1;
    case "succeeded":
    case "canceled":
      return 2;
  }
}

/** May a stored payment status be replaced by an observed one? */
export function paymentMayMove(from: PaymentStatus, to: PaymentStatus): boolean {
  if (from === to) return false;
  const a = paymentRank(from);
  const b = paymentRank(to);
  if (a === 2) return false; // terminal
  return b >= a;
}

export type OrderStatus =
  | "pending_payment"
  | "authorized"
  | "paid"
  | "partially_refunded"
  | "refunded"
  | "canceled";

/**
 * The order status follows from money facts only, never from the last event seen:
 * captured money → paid / partially_refunded / refunded (by refunds that hold money);
 * otherwise an open authorisation → authorized; every payment canceled → canceled; else pending_payment.
 */
export function deriveOrderStatus(f: {
  captured: bigint;
  refunded: bigint;
  payments: readonly PaymentStatus[];
}): OrderStatus {
  if (f.captured > 0n) {
    if (f.refunded >= f.captured) return "refunded";
    if (f.refunded > 0n) return "partially_refunded";
    return "paid";
  }
  if (f.payments.includes("requires_capture")) return "authorized";
  if (f.payments.length > 0 && f.payments.every((s) => s === "canceled")) return "canceled";
  return "pending_payment";
}

// --------------------------------------------------------------------------------------------- ledger
export interface Leg {
  readonly account: string;
  readonly amount: bigint; // debit-positive
  readonly kind: string;
  readonly effectRef: string;
}

/**
 * The legs of a sale whose captured amount equals the order total: the provider clearing account is debited with
 * the whole capture; each line credits its seller (line minus commission) and the platform commission account.
 * Zero legs are omitted. The legs always sum to zero.
 */
export function saleLegs(
  total: bigint,
  lines: readonly { id: string; seller: string; amount: bigint }[],
): Leg[] {
  const legs: Leg[] = [{ account: "provider:clearing", amount: total, kind: "sale", effectRef: "capture" }];
  for (const l of lines) {
    const fee = commissionOf(l.amount);
    const net = l.amount - fee;
    if (net !== 0n)
      legs.push({
        account: `seller:${l.seller}`,
        amount: -net,
        kind: "sale",
        effectRef: `allocation:${l.id}`,
      });
    if (fee !== 0n)
      legs.push({
        account: "platform:commission",
        amount: -fee,
        kind: "commission",
        effectRef: `allocation:${l.id}`,
      });
  }
  return legs;
}

export const sumLegs = (legs: readonly Leg[]): bigint => legs.reduce((s, l) => s + l.amount, 0n);

/** Exact SDK conversion within this app's declared minor-unit domain. */
export function sdkMinor(value: bigint): number {
  if (value < 0n || value > MAX_AMOUNT) throw new RangeError("money outside exact QueueBazaar SDK domain");
  return Number(value);
}

/** Provider JSON money must be an exact integer, never a rounded or fractional number. */
export function providerMinor(value: unknown): bigint {
  if (typeof value !== "number") throw new RangeError("provider money must be an exact JSON integer");
  const amount = parseMinorUnits(value);
  if (amount === undefined) throw new RangeError("provider money outside exact QueueBazaar SDK domain");
  return amount;
}
