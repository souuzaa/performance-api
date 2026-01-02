import postgres from "postgres";

const port = Number(Bun.env.PORT ?? 3000);
const basePath = "/api";
const databaseUrl = Bun.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required to start the API.");
  process.exit(1);
}

const sql = postgres(databaseUrl, {
  max: Number(Bun.env.DB_POOL_SIZE ?? 20),
  idle_timeout: Number(Bun.env.DB_IDLE_TIMEOUT ?? 20)
});

const batchSize = Number(Bun.env.BATCH_SIZE ?? 1000);
const flushIntervalMs = Number(Bun.env.FLUSH_INTERVAL_MS ?? 25);
const maxQueueSize = Number(Bun.env.MAX_QUEUE_SIZE ?? 200000);
const deadFlushIntervalMs = Number(Bun.env.DEAD_FLUSH_INTERVAL_MS ?? 250);
const maxDeadQueueSize = Number(Bun.env.MAX_DEAD_QUEUE_SIZE ?? 100000);

type RequestRecord = {
  trace_id: string;
  received_at: Date;
  method: string;
  path: string;
  payload: string | null;
};

type DeadLetterRecord = RequestRecord & {
  error: string;
};

const pending: RequestRecord[] = [];
const deadLetters: DeadLetterRecord[] = [];
let flushing = false;
let deadFlushing = false;
const startedAt = Date.now();
let totalReceived = 0;
let totalAccepted = 0;
let totalRejected = 0;
let totalDeadLetters = 0;
let totalDbErrors = 0;
let lastFlushAt: number | null = null;
let lastDeadFlushAt: number | null = null;
let lastFlushError: string | null = null;
let lastDeadFlushError: string | null = null;
const latencyBucketsMs = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
const latencyHistogram = new Array(latencyBucketsMs.length + 1).fill(0);
let latencySumMs = 0;
let latencyCount = 0;

await initDb();

const server = Bun.serve({
  port,
  fetch: handleRequest
});

setInterval(() => {
  void flushQueue();
}, flushIntervalMs);

setInterval(() => {
  void flushDeadLetters();
}, deadFlushIntervalMs);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`Bun server listening on http://localhost:${server.port}${basePath}`);

async function initDb() {
  await sql`
    create table if not exists requests (
      id bigserial primary key,
      trace_id text not null,
      received_at timestamptz not null,
      method text not null,
      path text not null,
      payload text
    )
  `;

  await sql`
    create table if not exists dead_letters (
      id bigserial primary key,
      trace_id text not null,
      received_at timestamptz not null,
      method text not null,
      path text not null,
      payload text,
      error text not null
    )
  `;

  await sql`
    create index if not exists requests_trace_id_idx on requests (trace_id)
  `;
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === `${basePath}/health`) {
    const uptimeMs = Math.round(process.uptime() * 1000);
    const uptimeSeconds = Math.max(1, Math.floor(uptimeMs / 1000));
    const memory = process.memoryUsage();

    return Response.json(
      {
        status: "ok",
        now: new Date().toISOString(),
        uptimeMs,
        queueDepth: pending.length,
        deadLetterDepth: deadLetters.length,
        flushing,
        deadFlushing,
        lastFlushAt: lastFlushAt ? new Date(lastFlushAt).toISOString() : null,
        lastDeadFlushAt: lastDeadFlushAt ? new Date(lastDeadFlushAt).toISOString() : null,
        lastFlushError,
        lastDeadFlushError,
        totals: {
          received: totalReceived,
          accepted: totalAccepted,
          rejected: totalRejected,
          deadLetters: totalDeadLetters,
          dbErrors: totalDbErrors,
          avgAcceptedRps: Number((totalAccepted / uptimeSeconds).toFixed(2))
        },
        memory: {
          rss: memory.rss,
          heapTotal: memory.heapTotal,
          heapUsed: memory.heapUsed,
          external: memory.external
        }
      },
      {
        headers: {
          "Cache-Control": "no-store"
        }
      }
    );
  }

  if (req.method === "GET" && url.pathname === "/metrics") {
    return new Response(renderMetrics(), {
      headers: {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }

  if (req.method === "POST" && url.pathname === `${basePath}/v1/events`) {
    const start = performance.now();
    try {
      totalReceived += 1;
      const traceId = req.headers.get("x-trace-id") ?? crypto.randomUUID();
      let payload: string | null = null;

      try {
        payload = await req.text();
        if (payload.length === 0) {
          payload = null;
        }
      } catch (error) {
        enqueueDeadLetter(
          {
            trace_id: traceId,
            received_at: new Date(),
            method: req.method,
            path: url.pathname,
            payload: null
          },
          `body_read_failed: ${formatError(error)}`
        );

        totalRejected += 1;
        return new Response("Invalid request body", {
          status: 400,
          headers: {
            "x-trace-id": traceId
          }
        });
      }

      const record: RequestRecord = {
        trace_id: traceId,
        received_at: new Date(),
        method: req.method,
        path: url.pathname,
        payload
      };

      if (pending.length >= maxQueueSize) {
        enqueueDeadLetter(record, "queue_overflow");
        totalRejected += 1;

        return new Response("Overloaded", {
          status: 503,
          headers: {
            "x-trace-id": traceId
          }
        });
      }

      pending.push(record);
      totalAccepted += 1;

      return Response.json(
        {
          status: "accepted",
          traceId
        },
        {
          status: 202,
          headers: {
            "x-trace-id": traceId
          }
        }
      );
    } finally {
      recordLatency(performance.now() - start);
    }
  }

  return new Response("Not Found", { status: 404 });
}

async function flushQueue() {
  if (flushing || pending.length === 0) {
    return;
  }

  flushing = true;
  const batch = pending.splice(0, batchSize);

  try {
    await sql`insert into requests ${sql(batch, "trace_id", "received_at", "method", "path", "payload")}`;
    lastFlushError = null;
  } catch (error) {
    const errorMessage = formatError(error);
    totalDbErrors += 1;
    lastFlushError = errorMessage;
    deadLetters.push(
      ...batch.map((record) => ({
        ...record,
        error: `insert_failed: ${errorMessage}`
      }))
    );
  } finally {
    lastFlushAt = Date.now();
    flushing = false;
  }
}

async function flushDeadLetters() {
  if (deadFlushing || deadLetters.length === 0) {
    return;
  }

  deadFlushing = true;
  const batch = deadLetters.splice(0, batchSize);

  try {
    await sql`
      insert into dead_letters ${sql(
        batch,
        "trace_id",
        "received_at",
        "method",
        "path",
        "payload",
        "error"
      )}
    `;
    lastDeadFlushError = null;
  } catch (error) {
    const errorMessage = formatError(error);
    totalDbErrors += 1;
    lastDeadFlushError = errorMessage;
    const requeue = batch.map((record) => ({
      ...record,
      error: `${record.error}; dead_letter_insert_failed: ${errorMessage}`.slice(0, 1000)
    }));

    if (deadLetters.length + requeue.length <= maxDeadQueueSize) {
      deadLetters.unshift(...requeue);
    } else {
      console.error("Dead letter queue overflow, dropping records.");
    }
  } finally {
    lastDeadFlushAt = Date.now();
    deadFlushing = false;
  }
}

function enqueueDeadLetter(record: RequestRecord, error: string) {
  if (deadLetters.length >= maxDeadQueueSize) {
    console.error("Dead letter queue overflow, dropping record.");
    return;
  }

  totalDeadLetters += 1;
  deadLetters.push({
    ...record,
    error: error.slice(0, 1000)
  });
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function recordLatency(valueMs: number) {
  const bucketIndex = latencyBucketsMs.findIndex((limit) => valueMs <= limit);
  if (bucketIndex === -1) {
    latencyHistogram[latencyHistogram.length - 1] += 1;
  } else {
    latencyHistogram[bucketIndex] += 1;
  }
  latencySumMs += valueMs;
  latencyCount += 1;
}

function percentile(targetPercentile: number) {
  if (latencyCount === 0) {
    return 0;
  }
  const threshold = latencyCount * targetPercentile;
  let cumulative = 0;
  for (let i = 0; i < latencyHistogram.length; i += 1) {
    cumulative += latencyHistogram[i];
    if (cumulative >= threshold) {
      return i < latencyBucketsMs.length ? latencyBucketsMs[i] : latencyBucketsMs[latencyBucketsMs.length - 1];
    }
  }
  return latencyBucketsMs[latencyBucketsMs.length - 1];
}

function renderMetrics() {
  const lines = [
    "# HELP api_requests_received_total Total requests received by the API.",
    "# TYPE api_requests_received_total counter",
    `api_requests_received_total ${totalReceived}`,
    "# HELP api_requests_accepted_total Total requests accepted by the API.",
    "# TYPE api_requests_accepted_total counter",
    `api_requests_accepted_total ${totalAccepted}`,
    "# HELP api_requests_rejected_total Total requests rejected by the API.",
    "# TYPE api_requests_rejected_total counter",
    `api_requests_rejected_total ${totalRejected}`,
    "# HELP api_dead_letters_total Total requests sent to the dead letter queue.",
    "# TYPE api_dead_letters_total counter",
    `api_dead_letters_total ${totalDeadLetters}`,
    "# HELP api_db_errors_total Total database errors encountered.",
    "# TYPE api_db_errors_total counter",
    `api_db_errors_total ${totalDbErrors}`,
    "# HELP api_queue_depth Current depth of the ingest queue.",
    "# TYPE api_queue_depth gauge",
    `api_queue_depth ${pending.length}`,
    "# HELP api_dead_letter_depth Current depth of the dead letter queue.",
    "# TYPE api_dead_letter_depth gauge",
    `api_dead_letter_depth ${deadLetters.length}`,
    "# HELP api_flushing Whether the main queue is flushing (1=true).",
    "# TYPE api_flushing gauge",
    `api_flushing ${flushing ? 1 : 0}`,
    "# HELP api_dead_flushing Whether the dead letter queue is flushing (1=true).",
    "# TYPE api_dead_flushing gauge",
    `api_dead_flushing ${deadFlushing ? 1 : 0}`,
    "# HELP api_last_flush_timestamp_seconds Unix timestamp of the last flush.",
    "# TYPE api_last_flush_timestamp_seconds gauge",
    `api_last_flush_timestamp_seconds ${lastFlushAt ? Math.floor(lastFlushAt / 1000) : 0}`,
    "# HELP api_last_dead_flush_timestamp_seconds Unix timestamp of the last dead letter flush.",
    "# TYPE api_last_dead_flush_timestamp_seconds gauge",
    `api_last_dead_flush_timestamp_seconds ${lastDeadFlushAt ? Math.floor(lastDeadFlushAt / 1000) : 0}`,
    "# HELP api_request_latency_ms Request latency in milliseconds.",
    "# TYPE api_request_latency_ms histogram"
  ];

  let cumulative = 0;
  for (let i = 0; i < latencyHistogram.length; i += 1) {
    cumulative += latencyHistogram[i];
    const upperBound = i < latencyBucketsMs.length ? latencyBucketsMs[i] : "+Inf";
    lines.push(`api_request_latency_ms_bucket{le="${upperBound}"} ${cumulative}`);
  }
  lines.push(`api_request_latency_ms_sum ${latencySumMs.toFixed(2)}`);
  lines.push(`api_request_latency_ms_count ${latencyCount}`);
  lines.push("# HELP api_request_latency_p50 p50 request latency in milliseconds.");
  lines.push("# TYPE api_request_latency_p50 gauge");
  lines.push(`api_request_latency_p50 ${percentile(0.5)}`);
  lines.push("# HELP api_request_latency_p95 p95 request latency in milliseconds.");
  lines.push("# TYPE api_request_latency_p95 gauge");
  lines.push(`api_request_latency_p95 ${percentile(0.95)}`);
  lines.push("# HELP api_request_latency_p99 p99 request latency in milliseconds.");
  lines.push("# TYPE api_request_latency_p99 gauge");
  lines.push(`api_request_latency_p99 ${percentile(0.99)}`);

  return lines.join("\n");
}

async function shutdown() {
  console.log("Shutting down, flushing queues...");
  await flushQueue();
  await flushDeadLetters();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
