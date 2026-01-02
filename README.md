# Performance API

High-throughput ingest API built for Bun.js with fast queueing, batched inserts, and lightweight observability.

## Highlights

- Bun-native HTTP server with minimal overhead.
- Batched Postgres writes with backpressure and dead-letter handling.
- Built-in health endpoint and Prometheus metrics.
- Load testing scripts included.

## Architecture Snapshot

- **Ingest path**: `POST /api/v1/events` -> in-memory queue -> batched insert into `requests`.
- **Dead letters**: failures or overloads go to a dead-letter queue -> batched insert into `dead_letters`.
- **Observability**: `/api/health` for live stats, `/metrics` for Prometheus-compatible metrics.

## Endpoints

- `POST /api/v1/events` accepts any payload body, returns `202` with `x-trace-id`.
- `GET /api/health` returns service stats, queue depth, and memory usage.
- `GET /metrics` returns Prometheus metrics.

## Requirements

- Bun.js
- Postgres (local or dockerized)

## Getting Started

1) Install dependencies

```bash
bun install
```

2) Set environment variables

```bash
export DATABASE_URL="postgres://user:pass@localhost:5432/perf"
export PORT=3000
```

3) Run the API

```bash
bun run dev
```

## Configuration

Environment variables (defaults shown):

- `PORT` (3000)
- `DATABASE_URL` (required)
- `DB_POOL_SIZE` (20)
- `DB_IDLE_TIMEOUT` (20)
- `BATCH_SIZE` (1000)
- `FLUSH_INTERVAL_MS` (25)
- `MAX_QUEUE_SIZE` (200000)
- `DEAD_FLUSH_INTERVAL_MS` (250)
- `MAX_DEAD_QUEUE_SIZE` (100000)

## Usage

```bash
curl -X POST "http://localhost:3000/api/v1/events" \
  -H "Content-Type: application/json" \
  -H "x-trace-id: demo-123" \
  -d '{"event":"signup","userId":"u_42"}'
```

Health check:

```bash
curl "http://localhost:3000/api/health"
```

Metrics:

```bash
curl "http://localhost:3000/metrics"
```

## Scripts

- `bun run dev` start with hot reload
- `bun run start` start without hot reload
- `bun run test` run tests
- `bun run loadtest` run load test runner
- `bun run loadtest:worker` run a single load test worker

## Database

Tables created at startup:

- `requests` stores accepted events.
- `dead_letters` stores failures and overloads with error details.

## Notes

- The API rejects requests when the queue is full and returns `503`.
- Dead letters are retried in batches and dropped only on dead-letter queue overflow.
