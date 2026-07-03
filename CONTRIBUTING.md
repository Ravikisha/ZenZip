# Contributing to ZenZip

Thanks for looking under the hood. This project runs on a few hard rules —
they're what keep a Rust-core framework trustworthy.

## Setup

Rust stable, Node 18+, pnpm. Optional: PostgreSQL for the multi-node tests.

```sh
pnpm install
pnpm build                  # native (cargo + napi, release) + TypeScript
cargo test --workspace      # Rust suite (PG tests skip without a server)
pnpm --filter zenzipjs test   # TypeScript suite

# Postgres tests (optional locally; CI always runs them):
#   ZENZIP_PG_TEST_URL=postgres://user:pass@127.0.0.1:5432/zenzip_test
```

## The standing rules

1. **CI green on Windows/macOS/Linux before merge.** The native build is
   never "fix later".
2. **Every feature lands with tests** — including a crash-safety test when
   the feature touches durability. We SIGKILL processes in CI on purpose;
   match that bar.
3. **Docs land with the feature**: the relevant guide page in `docs/` and a
   ledger update in `docs/content/tasks.md`.
4. **Benchmark regressions >10% block merge** (`bench/`).
5. **`docs/content/plan.md` follows the code.** If you change a D1–D8
   decision, change the document in the same PR — never silently diverge.
6. **No silent caps.** If your code bounds work (top-N, retries, replay
   caps), log what was dropped.

## Architecture ground rules (read before touching the boundary)

- **No async NAPI functions on hot paths** (~85µs each, measured). Hot paths
  use sync calls; Rust→JS dispatch uses pipelined ThreadsafeFunctions. See
  `docs/content/spike-results.md`.
- **One engine.** Schedules fire onto hidden queues; workflow runs are jobs;
  agents are workflows with dynamic steps. If your feature needs new
  recovery machinery, first ask why the queue engine can't carry it.
- **Store trait discipline:** every backend method exists in both SQLite and
  Postgres; `*_blocking` methods are only ever called from the JS thread
  (Postgres bridges via `block_anywhere` — read it before adding one).
- **Completed journal entries are never overwritten.** Effectively-once step
  recording is the contract everything durable sits on.

## Working on the test suites

- TS test files run serially (`vitest.config.ts`) — chaos harnesses spawn
  child processes with tight leases and starve under parallel workers.
- In crash/chaos tests, attach child `exit` listeners **before** any
  sleep/kill — a child dying early otherwise hangs the suite forever
  (we learned this over a 24-minute hang).
- PG tests share one schema: take the test mutex (`pg_guard`) and namespace
  ids in JS tests — the schema persists between runs.

## PRs

- Small and focused beats large and sweeping.
- After a freeze (the step API is frozen), API changes need an RFC note in
  `docs/rfcs/`.
- Commit messages: conventional-ish, subject ≤72 chars, body explains *why*.

## License

MIT — by contributing you agree your contributions are MIT-licensed.
