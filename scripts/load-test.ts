const target = Bun.env.TARGET_URL ?? "http://localhost:3001/api/v1/events";
const durationSeconds = Number(Bun.env.DURATION_SECONDS ?? 10);
const concurrency = Number(Bun.env.CONCURRENCY ?? 200);
const payloadBytes = Number(Bun.env.PAYLOAD_BYTES ?? 128);
const reportIntervalMs = Number(Bun.env.REPORT_INTERVAL_MS ?? 1000);
const rpsTarget = Number(Bun.env.RPS ?? 0);
const workerId = Number(Bun.env.WORKER_ID ?? 0);
const workerCount = Number(Bun.env.WORKER_COUNT ?? 1);
const pushGatewayUrl = Bun.env.METRICS_PUSHGATEWAY_URL;

if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
  throw new Error("DURATION_SECONDS must be a positive number.");
}

if (!Number.isFinite(concurrency) || concurrency <= 0) {
  throw new Error("CONCURRENCY must be a positive number.");
}

if (!Number.isFinite(workerCount) || workerCount <= 0) {
  throw new Error("WORKER_COUNT must be a positive number.");
}

const payload = "x".repeat(payloadBytes);
const endAt = Date.now() + durationSeconds * 1000;

const histogramBuckets = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
const histogram = new Array(histogramBuckets.length + 1).fill(0);

let sent = 0;
let ok = 0;
let failed = 0;
let inflight = 0;
let lastReportSent = 0;
let lastReportOk = 0;
let lastReportFailed = 0;
let lastReportAt = Date.now();

const reportTimer = setInterval(() => {
  const now = Date.now();
  const intervalSeconds = Math.max(1, (now - lastReportAt) / 1000);
  const sentDelta = sent - lastReportSent;
  const okDelta = ok - lastReportOk;
  const failedDelta = failed - lastReportFailed;

  const payload = {
    time: new Date().toISOString(),
    workerId,
    sent,
    ok,
    failed,
    inflight,
    rps: Math.round(sentDelta / intervalSeconds),
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99)
  };

  console.log(JSON.stringify(payload));

  if (pushGatewayUrl) {
    void pushMetrics(pushGatewayUrl, payload);
  }

  lastReportSent = sent;
  lastReportOk = ok;
  lastReportFailed = failed;
  lastReportAt = now;
}, reportIntervalMs);

await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index)));

clearInterval(reportTimer);
const summary = {
  summary: true,
  durationSeconds,
  sent,
  ok,
  failed,
  rps: Math.round(sent / durationSeconds),
  p50: percentile(0.5),
  p95: percentile(0.95),
  p99: percentile(0.99)
};

console.log(JSON.stringify(summary));
if (pushGatewayUrl) {
  await pushMetrics(pushGatewayUrl, summary);
}

async function worker(localWorkerId: number) {
  const headers = {
    "content-type": "text/plain",
    "x-trace-id": `load-${workerId}-${localWorkerId}-${crypto.randomUUID()}`
  };

  const perWorkerRps = rpsTarget > 0 ? rpsTarget / workerCount : 0;
  const intervalMs = perWorkerRps > 0 ? 1000 / perWorkerRps : 0;
  let nextSendAt = performance.now();

  while (Date.now() < endAt) {
    if (perWorkerRps > 0) {
      const now = performance.now();
      if (now < nextSendAt) {
        await Bun.sleep(Math.max(0, nextSendAt - now));
      }
      nextSendAt = Math.max(nextSendAt + intervalMs, performance.now());
    }

    inflight += 1;
    sent += 1;
    const start = performance.now();

    try {
      const response = await fetch(target, {
        method: "POST",
        headers,
        body: payload
      });

      const elapsed = performance.now() - start;
      recordLatency(elapsed);

      if (response.ok) {
        ok += 1;
      } else {
        failed += 1;
      }
    } catch {
      const elapsed = performance.now() - start;
      recordLatency(elapsed);
      failed += 1;
    } finally {
      inflight = Math.max(0, inflight - 1);
    }
  }
}

function recordLatency(valueMs: number) {
  const bucketIndex = histogramBuckets.findIndex((limit) => valueMs <= limit);
  if (bucketIndex === -1) {
    histogram[histogram.length - 1] += 1;
  } else {
    histogram[bucketIndex] += 1;
  }
}

function percentile(targetPercentile: number) {
  const total = histogram.reduce((sum, count) => sum + count, 0);
  if (total === 0) {
    return 0;
  }
  const threshold = total * targetPercentile;
  let cumulative = 0;
  for (let i = 0; i < histogram.length; i += 1) {
    cumulative += histogram[i];
    if (cumulative >= threshold) {
      return i < histogramBuckets.length ? histogramBuckets[i] : histogramBuckets[histogramBuckets.length - 1];
    }
  }
  return histogramBuckets[histogramBuckets.length - 1];
}

async function pushMetrics(url: string, payload: Record<string, number | string | boolean>) {
  const lines = [
    `loadtest_sent_total ${payload.sent}`,
    `loadtest_ok_total ${payload.ok}`,
    `loadtest_failed_total ${payload.failed}`,
    `loadtest_inflight ${payload.inflight ?? 0}`,
    `loadtest_rps ${payload.rps ?? 0}`,
    `loadtest_latency_p50 ${payload.p50 ?? 0}`,
    `loadtest_latency_p95 ${payload.p95 ?? 0}`,
    `loadtest_latency_p99 ${payload.p99 ?? 0}`
  ].join("\n");

  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "text/plain"
      },
      body: lines
    });
  } catch {
    // Ignore push failures to keep load test running.
  }
}
