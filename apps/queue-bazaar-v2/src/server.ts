// QueueBazaar: a small multi-seller marketplace on Stripe or Razorpay + Postgres, with a job queue.
// Webhook handlers verify the signature, store a job and answer 200; an in-process worker applies the jobs.
import http from "node:http";
import { createPool, type Db, migrate } from "./db.ts";
import { enqueue, Worker } from "./jobs.ts";
import { type PaymentProvider, ProviderError, providerFromEnv, SignatureError } from "./provider.ts";
import { HttpError, Shop } from "./shop.ts";

type Json = Record<string, unknown>;
const MAX_BODY = 1_000_000;

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const send = (res: http.ServerResponse, status: number, body: Json) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
};

export function createApp(db: Db, provider: PaymentProvider) {
  const shop = new Shop(db, provider);
  const worker = new Worker(db, {
    payment: (p) => shop.onPaymentJob(String(p.ref)),
    reconcile_payment: (p) => shop.onPaymentJob(String(p.ref)),
    refund: (p) => shop.onRefundJob(String(p.ref)),
    resolve_refund_request: (p) => shop.resolveRefundRequest(String(p.request_id)),
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const raw = await readBody(req);
      if (req.method === "GET" && url.pathname === "/healthz") {
        await db.query("SELECT 1"); // ready once the database answers
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === `/webhooks/${provider.name}`) {
        let notice: ReturnType<PaymentProvider["parseWebhook"]>;
        try {
          notice = provider.parseWebhook(raw, req.headers);
        } catch (e) {
          if (e instanceof SignatureError || e instanceof SyntaxError)
            return send(res, 400, { error: "invalid webhook" });
          throw e;
        }
        if (notice.object !== "none")
          await enqueue(
            db,
            notice.object,
            { ref: notice.ref, ...(notice.paymentRef ? { payment_ref: notice.paymentRef } : {}) },
            `${provider.name}:${notice.eventId}`,
          );
        return send(res, 200, { received: true });
      }
      let body: Json = {};
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Json;
          else throw new HttpError(400, "body must be a JSON object");
        } catch (e) {
          if (e instanceof HttpError) throw e;
          throw new HttpError(400, "invalid JSON");
        }
      }
      if (req.method === "POST" && url.pathname === "/orders")
        return send(res, 201, await shop.createOrder(body));
      const m = /^\/orders\/([A-Za-z0-9_-]{1,64})(?:\/(checkout|confirm|capture|refunds))?$/.exec(
        url.pathname,
      );
      if (m) {
        const id = m[1] ?? "";
        const action = m[2];
        if (req.method === "GET" && !action) return send(res, 200, await shop.getOrder(id));
        if (req.method === "POST" && action === "checkout") return send(res, 200, await shop.checkout(id));
        if (req.method === "POST" && action === "confirm") return send(res, 200, await shop.confirm(id));
        if (req.method === "POST" && action === "capture") return send(res, 200, await shop.capture(id));
        if (req.method === "POST" && action === "refunds") {
          const out = await shop.refundLine(id, body);
          return send(res, out.status, out.body);
        }
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      if (e instanceof ProviderError) return send(res, 502, { error: `payment provider: ${e.message}` });
      console.error(e);
      send(res, 500, { error: "internal error" });
    }
  });

  return {
    shop,
    worker,
    server,
    /** Recover from a previous crash, then start the worker. */
    async start(): Promise<void> {
      const jobs = await worker.recover();
      const requests = await shop.recoverRefundRequests();
      if (jobs || requests)
        console.log(`recovered ${jobs} running job(s) and ${requests} in-flight refund request(s)`);
      worker.start();
    },
    async stop(): Promise<void> {
      await worker.stop();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  const db = createPool(process.env.DATABASE_URL);
  await migrate(db);
  const app = createApp(db, providerFromEnv());
  await app.start();
  const port = Number(process.env.PORT ?? 3000);
  app.server.listen(port, "127.0.0.1", () => console.log(`queue-bazaar listening on ${port}`));
  const shutdown = async () => {
    await app.stop();
    await db.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
