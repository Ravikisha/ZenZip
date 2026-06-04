# ZenZip

> The agent-native backend framework for Node.js. Durable workflows, queues,
> agents, scheduling, and observability on a single Rust-powered runtime —
> with zero infrastructure.

**Status: Phase 0 (validation spike).** See [docs/plan.md](docs/plan.md) for
the full plan and [docs/tasks.md](docs/tasks.md) for the roadmap.

## Layout

```text
crates/zenzip-core      Rust runtime core (storage, queue, workflow engine)
packages/core-native    NAPI bridge crate + npm package (@zenzip/core-native)
packages/zenzip         Public TypeScript API (npm: zenzip)
bench/                  Phase 0 boundary/throughput benchmarks
docs/                   Plan, tasks, spike results
```

## Development

Requires Rust stable + Node 18+ + pnpm.

```sh
pnpm install
pnpm build:native        # cargo build + napi bindings (release)

pnpm bench:boundary      # P0.4  JS -> Rust call cost
pnpm bench:tsfn          # P0.5  Rust -> JS threadsafe-fn throughput
pnpm bench:sqlite        # P0.7  SQLite WAL queue throughput
pnpm bench:http          # P0.6  hyper vs fastify (D5 go/no-go)
```
