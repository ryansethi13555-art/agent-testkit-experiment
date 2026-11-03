import type pg from "pg";

export async function httpPost(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: res.status, body: parsed };
}

export async function httpGet(
  baseUrl: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(baseUrl + path, {
    method: "GET",
    headers: { ...headers },
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: res.status, body: parsed };
}

export async function getLedgerTotal(db: pg.Client | pg.Pool): Promise<bigint> {
  const res = await db.query("SELECT coalesce(sum(amount), 0)::text AS s FROM ledger_entries");
  return BigInt(res.rows[0].s);
}

export async function getLedgerAccountBalance(db: pg.Client | pg.Pool, account: string): Promise<bigint> {
  const res = await db.query("SELECT coalesce(sum(amount), 0)::text AS s FROM ledger_entries WHERE account = $1", [account]);
  return BigInt(res.rows[0].s);
}

export async function areAllLedgerTransactionsBalanced(db: pg.Client | pg.Pool): Promise<boolean> {
  const res = await db.query(
    "SELECT txn_id, currency, sum(amount) AS sum FROM ledger_entries GROUP BY txn_id, currency HAVING sum(amount) <> 0",
  );
  return res.rowCount === 0;
}
