// SDK wire formats use numbers. Convert only at that boundary, within the exact integer domain.
export class MoneyInputError extends Error {}
export const MAX_SDK_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
export function parseMinor(value: unknown): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new MoneyInputError("money must be a non-negative safe integer or decimal integer string");
    return BigInt(value);
  }
  if (typeof value !== "string" || !/^[0-9]+$/.test(value))
    throw new MoneyInputError("money must be a non-negative decimal integer string");
  const digits = value.replace(/^0+/, "") || "0";
  if (digits.length > 16) throw new MoneyInputError("money exceeds this control's exact SDK integer range");
  const minor = BigInt(digits);
  if (minor > MAX_SDK_MINOR)
    throw new MoneyInputError("money exceeds this control's exact SDK integer range");
  return minor;
}
export function sdkMinor(value: bigint): number {
  if (value < 0n || value > MAX_SDK_MINOR)
    throw new MoneyInputError("money exceeds this control's exact SDK integer range");
  return Number(value);
}

export type RefundStatus = "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
export function refundHoldsMoney(status: string): boolean {
  return status === "pending" || status === "requires_action" || status === "succeeded";
}
export function stripeRefundStatus(status: unknown): RefundStatus {
  if (
    status === "pending" ||
    status === "requires_action" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "canceled"
  )
    return status;
  throw new Error("unsupported provider refund status");
}
