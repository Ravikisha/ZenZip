# Phase 0 Spike Results (P0.8)

**Date:** 2026-06-04
**Machine:** 11th Gen Intel i5-1135G7 @ 2.40GHz (4C/8T laptop), Windows 10 Pro, Node 23.6.0, Rust 1.95.0, napi-rs v3.9 / napi-derive 3.5.6
**Caveat:** low-power laptop, same-machine load gen. Numbers are *relative* signals for architecture decisions, not absolute claims. Re-run on a Linux server box before publishing anything.

---

## P0.4 — JS → Rust call round-trip (mitata, bench/boundary.mjs)

| Benchmark | avg |
|---|---|
| JS baseline `jsAdd(1,2)` | ~0.08 ns (inlined/DCE) |
| napi `syncNoop()` | **13.9 ns** |
| napi `syncAdd(1,2)` | **33.7 ns** |
| napi `syncEchoBuffer` 1KB | 151 ns |
| napi `syncEchoBuffer` 64KB | 165 ns (no copy — external buffer ref) |
| JS `JSON.parse+stringify` 1.1KB | 124 µs |
| napi serde parse+stringify 1.1KB | 113 µs (≈ parity with JS) |
| napi `asyncAdd(1,2)` | **85.6 µs** |
| napi `asyncEchoBuffer` 1KB | 101 µs |

### Findings

1. **Sync boundary is effectively free**: 14–34 ns/call. Budget thousands of sync crossings per request without caring.
2. **Async boundary is ~2,500× more expensive than sync** (~85–100 µs: tokio dispatch + promise resolution + event-loop wakeup). NEVER design per-operation `async fn` NAPI calls on hot paths. Hot-path rule: sync calls for queries/enqueues, TSFN for Rust→JS dispatch, batching for everything async.
3. Buffer passing is near-zero-cost and size-independent (external buffers). JSON strings at ~1KB cross the boundary at parity with native JS JSON — serialization format is not the bottleneck at this size.

---

## P0.5 — Rust → JS ThreadsafeFunction round-trip (bench/tsfn.mjs)

100,000 round-trips (Rust calls JS callback, awaits returned value):

| Mode | Throughput |
|---|---|
| Sequential (1 in flight) | **27,400 round-trips/s** (~36 µs each) |
| Concurrent ×16 | 291,600/s |
| Concurrent ×64 | 351,200/s |
| Concurrent ×256 | **408,600/s** (~2.4 µs amortized) |

### Findings

1. Single TSFN round-trip costs ~36 µs (event-loop wakeup dominated) — but **pipelining hides it almost entirely**: 15× throughput at 256 in-flight.
2. **The engine architecture must keep many handler invocations in flight** (natural for a workflow/queue runtime running many concurrent runs). At 400k dispatches/s, TSFN will never be the bottleneck — SQLite (10–200k ops/s) and user code saturate far earlier.
3. GO for the planned D3 design (Rust engine dispatching JS handlers via TSFN).

---

## P0.6 — hyper vs Fastify HTTP (bench/http.mjs, load gen in child process)

10s × 64 connections, hello-world:

| Server | req/s | p50 | p99 |
|---|---|---|---|
| Fastify (Node) | 19,800 | 2 ms | 14 ms |
| hyper static (pure Rust) | 26,800 | 1 ms | 10 ms |
| hyper → JS handler (TSFN) | 23,100 | 2 ms | 9 ms |

- hyper static vs Fastify: **1.35×**
- hyper → JS handler vs Fastify: **1.17×**

### Findings

1. **D5 verdict: NO-GO on "Rust HTTP for speed."** With real JS handlers in the path, the Rust front-end is only ~17% faster than Fastify — far below the >1.3× bar, nowhere near a migration motivator. The plan's prediction ("a naive Rust router calling JS handlers can fail to beat Fastify meaningfully") is confirmed by data.
2. Methodology note: the first (naive) run had autocannon sharing the server's event loop and showed 2.55× — wrong by 2× on the Fastify baseline. Keep the child-process load-gen pattern for all future HTTP benches.
3. **Decision: HTTP stays an adapter over Node servers (plan.md M9) for 1.0.** Latency tail (p99 14→9 ms) is the only real win; revisit post-1.0 only if tail latency becomes a user demand. Marketing must never lead with router benchmarks — durability is the story (as planned).

---

## P0.7 — SQLite WAL queue throughput (bench/sqlite.mjs)

100,000 jobs, 256-byte payloads, WAL + synchronous=NORMAL:

| Phase | Throughput |
|---|---|
| Insert (1,000/tx batches) | **209,600 jobs/s** |
| Claim+ack loop (1 job/claim, 2 commits/job — worst case) | **9,800 jobs/s** |

### Findings

1. Insert side is a non-issue: 200k+/s batched.
2. Worst-case claim+ack lands at 9.8k/s on a laptop — a hair under the 10k target, with zero optimization. Obvious wins not yet applied: batch claiming (claim N jobs per UPDATE), combining claim+ack journaling, prepared-statement transactions. Expect 3–10× headroom; target comfortably reachable.
3. GO for D2 (SQLite embedded default). **Open item:** 4-process writer contention bench not yet run (P0.7 partial) — needed before freezing the multi-process story (D8).

---

## Decisions recorded

| ID | Decision | Status |
|---|---|---|
| D2 | SQLite WAL embedded default | **GO** (single-process; multi-process bench pending) |
| D3 | Coarse boundary: sync calls + pipelined TSFN dispatch; no per-op async NAPI fns | **GO**, with new hard rule: async NAPI fns banned on hot paths (~85 µs each) |
| D5 | Rust HTTP layer | **NO-GO for 1.0** — HTTP stays a Node adapter (M9); hyper code kept in repo for benchmarks only |

## Follow-ups

- [ ] P0.7b: 4-process SQLite writer-contention bench (spawn workers via child_process)
- [ ] Re-run all benches on a Linux server box; add results column here
- [ ] Push to GitHub → validate CI matrix (P0.3) on all three OSes
- [ ] Engine design note for Phase 1/2: batch step-journal prefetch at run start (avoids per-step boundary chatter), keep ≥64 handler dispatches in flight
