// The job queue: a Postgres table drained by one in-process worker.
// Webhook handlers (and recovery paths) only enqueue; the worker claims one job at a time with
// FOR UPDATE SKIP LOCKED, runs its handler (which does its money work in its own transactions, idempotently) and
// marks it done. A failing job is retried with backoff; a crash leaves it 'running' and startup re-queues it.
import type { Db } from "./db.ts";

interface Queryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export type JobType = "payment" | "refund" | "resolve_refund_request" | "reconcile_payment";

/**
 * Queue a job. `key` deduplicates (provider event id, or a recovery key): a second job with the same key is dropped,
 * unless the first one has failed for good, in which case it is queued again (e.g. the provider redelivered).
 */
export async function enqueue(
  q: Queryable,
  type: JobType,
  payload: Record<string, string>,
  key: string | null,
): Promise<void> {
  await q.query(
    `INSERT INTO jobs (provider_event_id, type, payload) VALUES ($1, $2, $3)
     ON CONFLICT (provider_event_id) DO UPDATE SET state = 'queued', attempts = 0, run_after = now(), updated_at = now()
     WHERE jobs.state = 'failed'`,
    [key, type, JSON.stringify(payload)],
  );
}

export type Handler = (payload: Record<string, string>) => Promise<void>;

/** Backoff before the n-th retry: 100 ms doubling, capped at 2 s. */
export const backoffMs = (attempts: number): number => Math.min(100 * 2 ** Math.max(0, attempts - 1), 2000);

/**
 * Attempts before a job is parked as 'failed' (a dead letter for an operator). Reconciling a provider object is
 * retried for longer (fetches fail transiently). Waiting for exact identity of an unknown refund is bounded more tightly:
 * after a few checks it leaves the request 'unknown', its amount still reserved on the line. It never resends the
 * possibly committed POST; a later exact webhook is still linked and can retire the dead letter.
 */
export const DEFAULT_MAX_ATTEMPTS = { default: 25, resolve_refund_request: 6 } as const;

export class Worker {
  readonly #db: Db;
  readonly #handlers: Record<JobType, Handler>;
  readonly #pollMs: number;
  readonly #maxAttempts: Partial<Record<JobType, number>> & { default: number };
  #running = false;
  #loop: Promise<void> | undefined;
  #wake: (() => void) | undefined;

  constructor(
    db: Db,
    handlers: Record<JobType, Handler>,
    opts: { pollMs?: number; maxAttempts?: Partial<Record<JobType, number>> & { default: number } } = {},
  ) {
    this.#db = db;
    this.#handlers = handlers;
    this.#pollMs = opts.pollMs ?? 200;
    this.#maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  /** Re-queue jobs a previous process left running (this app runs exactly one worker process). */
  async recover(): Promise<number> {
    const r = await this.#db.query(
      "UPDATE jobs SET state = 'queued', run_after = now(), updated_at = now() WHERE state = 'running'",
    );
    return r.rowCount ?? 0;
  }

  /** Claim and run one ready job. Returns false when none was ready. */
  async runOnce(): Promise<boolean> {
    const claimed = await this.#db.query(
      `UPDATE jobs SET state = 'running', attempts = attempts + 1, updated_at = now()
       WHERE id = (SELECT id FROM jobs WHERE state = 'queued' AND run_after <= now()
                   ORDER BY run_after, id FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id, type, payload, attempts`,
    );
    const job = claimed.rows[0] as
      | { id: bigint; type: JobType; payload: Record<string, string>; attempts: number }
      | undefined;
    if (!job) return false;
    try {
      const handler = this.#handlers[job.type];
      if (!handler) throw new Error(`no handler for job type ${job.type}`);
      await handler(job.payload);
      await this.#db.query(
        "UPDATE jobs SET state = 'done', last_error = NULL, updated_at = now() WHERE id = $1",
        [job.id],
      );
    } catch (e) {
      const message = String((e as Error)?.message ?? e).slice(0, 500);
      const final = job.attempts >= (this.#maxAttempts[job.type] ?? this.#maxAttempts.default);
      if (final) console.error(`job ${job.id} (${job.type}) failed for good: ${message}`);
      await this.#db.query(
        `UPDATE jobs SET state = $2, last_error = $3, run_after = now() + ($4::int * interval '1 millisecond'),
                updated_at = now() WHERE id = $1`,
        [job.id, final ? "failed" : "queued", message, backoffMs(job.attempts)],
      );
    }
    return true;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#loop = (async () => {
      while (this.#running) {
        let worked = false;
        try {
          worked = await this.runOnce();
        } catch (e) {
          console.error("worker:", (e as Error).message);
        }
        if (!worked && this.#running)
          await new Promise<void>((r) => {
            const t = setTimeout(r, this.#pollMs);
            this.#wake = () => {
              clearTimeout(t);
              r();
            };
          });
      }
    })();
  }

  /** Poll now instead of waiting for the next tick (after enqueueing). */
  nudge(): void {
    this.#wake?.();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.nudge();
    await this.#loop;
  }
}
