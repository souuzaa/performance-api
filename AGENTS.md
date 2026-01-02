# Architecture Context

This project emphasizes high performance, maintainability, and clear separation of concerns. Use proven patterns, minimize shared mutable state, and prefer explicit boundaries between components. The runtime target is Bun.js, so prefer Bun-native APIs and patterns.

## Core Principles
- Prioritize predictable performance: low latency, bounded memory, and efficient IO.
- Keep modules cohesive and loosely coupled; avoid hidden cross-module dependencies.
- Favor composition over inheritance; prefer interfaces over concrete types.
- Make data flow explicit; avoid global state.
- Optimize after measurement; bake observability into the design.

## Design Patterns (Preferred)
- Hexagonal architecture (ports and adapters) to isolate domain logic.
- CQRS for read-heavy or write-heavy workloads with differing access patterns.
- Repository pattern for persistence access behind interfaces.
- Dependency injection for testability and substitutability.
- Circuit breaker and bulkhead for resilience under load.

## Performance-Oriented Architecture
- Use async or non-blocking IO at the edges.
- Apply caching where it reduces repeated expensive work.
- Use batching for IO-bound operations.
- Prefer immutable data structures where feasible to reduce contention.
- Avoid N+1 queries; use prefetching or joins as appropriate.
- Favor Bun-native primitives (`Bun.serve`, `Bun.file`, `Bun.spawn`) over heavier abstractions when it keeps code simpler and faster.
- Prefer `fetch`-based HTTP clients and streaming responses; avoid unnecessary buffering.

## Module Boundaries
- `domain/`: business rules, pure logic, no IO.
- `application/`: orchestration, use-cases, transactions.
- `infrastructure/`: database, network, cache, messaging implementations.
- `interfaces/`: API handlers, CLI, or other adapters.

## Bun.js Guidance
- Prefer ESM modules; keep TypeScript strict and use `tsconfig.json` tuned for Bun.
- Keep hot paths in Bun server handlers lean; move heavy work into application services.
- Use Bun's built-in test runner (`bun test`) for unit and integration tests.
- Use `Bun.env` with schema validation at startup; fail fast on misconfiguration.
- Avoid Node-only polyfills; use Bun APIs to reduce overhead.

## Observability
- Structured logging with trace IDs.
- Metrics for latency, throughput, error rates.
- Tracing across boundaries to find hotspots.

## Testing Guidance
- Unit tests for domain and application layers.
- Integration tests for adapters and external IO.
- Load tests for hot paths and critical endpoints.

## Security and Safety
- Validate all inputs at boundaries.
- Use least-privilege credentials for infrastructure access.
- Prefer idempotent operations for retries.
