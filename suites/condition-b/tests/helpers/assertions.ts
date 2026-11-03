import type pg from "pg";
import { expect } from "vitest";

export interface LedgerVerificationClient {
  query(sql: string, params?: unknown[]): Promise<pg.QueryResult>;
}

/**
 * Money Law: ledger.txn-balanced
 * Every ledger transaction balances, per currency.
 */
export async function assertLedgerBalanced(db: LedgerVerificationClient): Promise<void> {
  const res = await db.query(
    "SELECT txn_id, currency, sum(amount)::text AS balance FROM ledger_entries GROUP BY txn_id, currency HAVING sum(amount) <> 0",
  );
  expect(res.rows, `Unbalanced ledger transactions found: ${JSON.stringify(res.rows)}`).toEqual([]);
}

/**
 * Money Law: effect.once-per-provider-event
 * Each intended economic posting slot is realised at most once per account and currency.
 */
export async function assertEffectOnce(db: LedgerVerificationClient): Promise<void> {
  const res = await db.query(
    `SELECT cause_ref, effect_ref, account, currency, count(*) AS count
     FROM ledger_entries
     WHERE effect_ref IS NOT NULL
     GROUP BY cause_ref, effect_ref, account, currency
     HAVING count(*) > 1`,
  );
  expect(res.rows, `Duplicate effect postings found: ${JSON.stringify(res.rows)}`).toEqual([]);
}

/**
 * Money Law: refund.line-bounded
 * Refunds on an order line never exceed the line amount.
 */
export async function assertRefundLineBounded(db: LedgerVerificationClient): Promise<void> {
  const res = await db.query(
    `SELECT ol.id, ol.order_id, ol.amount, coalesce(sum(r.amount), 0)::bigint AS refunded
     FROM order_lines ol
     LEFT JOIN refunds r ON r.line_id = ol.id AND r.status NOT IN ('failed', 'canceled')
     GROUP BY ol.id, ol.order_id, ol.amount
     HAVING coalesce(sum(r.amount), 0)::bigint > ol.amount`,
  );
  expect(res.rows, `Over-refunded lines found: ${JSON.stringify(res.rows)}`).toEqual([]);
}

/**
 * Money Law: alloc.refund-line-same-order & alloc.part-same-order
 * A refund allocated to an order line is a refund of a payment for that line's order.
 */
export async function assertAllocationsMatchOrder(db: LedgerVerificationClient): Promise<void> {
  const refundLineMismatch = await db.query(
    `SELECT r.id AS refund_id, r.order_id AS refund_order_id, r.line_id, ol.order_id AS line_order_id
     FROM refunds r
     JOIN order_lines ol ON r.line_id = ol.id
     WHERE r.order_id <> ol.order_id`,
  );
  expect(refundLineMismatch.rows, `Refund allocated to line of different order: ${JSON.stringify(refundLineMismatch.rows)}`).toEqual([]);

  // Check allocations table if it exists (worker app)
  const hasAllocations = (await db.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'allocations'")).rowCount;
  if (hasAllocations) {
    const allocMismatch = await db.query(
      `SELECT a.id, a.order_id, ol.order_id AS line_order_id
       FROM allocations a
       JOIN order_lines ol ON a.line_id = ol.id
       WHERE a.order_id <> ol.order_id`,
    );
    expect(allocMismatch.rows, `Allocation mismatched order: ${JSON.stringify(allocMismatch.rows)}`).toEqual([]);
  }
}

/**
 * Money Law: alloc.declared-parts-sum-to-whole
 * The parts of a declared split sum exactly to the whole, per currency.
 */
export async function assertAllocationsSumToWhole(db: LedgerVerificationClient): Promise<void> {
  const hasAllocations = (await db.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'allocations'")).rowCount;
  if (hasAllocations) {
    const res = await db.query(
      "SELECT id, amount, seller_amount, commission_amount FROM allocations WHERE seller_amount + commission_amount <> amount",
    );
    expect(res.rows, `Allocations that do not sum to whole: ${JSON.stringify(res.rows)}`).toEqual([]);
  }
}

/**
 * Money Law: ledger.failed-operation-no-residue
 * A provider operation that failed leaves no net effect on any ledger account.
 */
export async function assertFailedOperationNoResidue(db: LedgerVerificationClient, failedCauseRefs: string[] = []): Promise<void> {
  // If failed causes not provided, find them from refunds with status 'failed' or 'canceled'
  const causes = [...failedCauseRefs];
  const failedRefunds = await db.query("SELECT provider_ref FROM refunds WHERE status IN ('failed', 'canceled')");
  for (const r of failedRefunds.rows) causes.push(r.provider_ref);

  if (causes.length === 0) return;

  const res = await db.query(
    `SELECT cause_ref, account, sum(amount)::text AS net_amount
     FROM ledger_entries
     WHERE cause_ref = ANY($1)
     GROUP BY cause_ref, account
     HAVING sum(amount) <> 0`,
    [causes],
  );
  expect(res.rows, `Failed operations left residue in ledger: ${JSON.stringify(res.rows)}`).toEqual([]);
}

/**
 * Money Law: order.paid-iff-captured
 * Order status is 'paid' or 'partially_refunded' or 'refunded' if and only if money was captured at the provider.
 */
export async function assertOrderPaidIffCaptured(
  db: LedgerVerificationClient,
  orderId: string,
  wasCaptured: boolean,
): Promise<void> {
  const res = await db.query("SELECT status FROM orders WHERE id = $1", [orderId]);
  const status = res.rows[0]?.status;
  if (wasCaptured) {
    expect(["paid", "partially_refunded", "refunded"]).toContain(status);
  } else {
    expect(["pending_payment", "capture_pending"]).toContain(status);
  }
}

/**
 * Assert all foundational money laws simultaneously on the current database state.
 */
export async function assertAllMoneyLaws(db: LedgerVerificationClient): Promise<void> {
  await assertLedgerBalanced(db);
  await assertEffectOnce(db);
  await assertRefundLineBounded(db);
  await assertAllocationsMatchOrder(db);
  await assertAllocationsSumToWhole(db);
  await assertFailedOperationNoResidue(db);
}
