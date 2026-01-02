const workers = Number(Bun.env.WORKERS ?? 4);

if (!Number.isFinite(workers) || workers <= 0) {
  throw new Error("WORKERS must be a positive number.");
}

const childProcesses: Bun.Subprocess[] = [];

for (let i = 0; i < workers; i += 1) {
  const metricsUrl =
    process.env.METRICS_PUSHGATEWAY_URL ??
    `http://localhost:9091/metrics/job/loadtest/instance/worker-${i}`;
  const env = {
    ...process.env,
    WORKER_ID: String(i),
    WORKER_COUNT: String(workers),
    METRICS_PUSHGATEWAY_URL: metricsUrl
  };

  const child = Bun.spawn(["bun", "scripts/load-test.ts"], {
    env,
    stdout: "inherit",
    stderr: "inherit"
  });

  childProcesses.push(child);
}

const exitCodes = await Promise.all(childProcesses.map((child) => child.exited));
const failed = exitCodes.find((code) => code !== 0);

process.exit(failed ?? 0);
