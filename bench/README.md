# ZenZip benchmarks

Spike-derived numbers that shaped (and killed) design decisions, plus the
framework comparison. **Same-machine, relative signals — not marketing claims.**

| script | what it measures | run |
| --- | --- | --- |
| `boundary.mjs` | JS↔Rust NAPI call cost (sync vs async) | `pnpm bench:boundary` |
| `tsfn.mjs` | Rust→JS handler dispatch under pipelining | `pnpm bench:tsfn` |
| `sqlite.mjs` | SQLite insert / claim+ack throughput | `pnpm bench:sqlite` |
| `http.mjs` | hello-world: Express vs Fastify vs hyper (the Rust-HTTP no-go) | `pnpm bench:http` |
| `compare.mjs` | **ZenZip vs Express vs Fastify, identical handlers** | `pnpm bench:compare` |

## compare.mjs (P10.5)

Boots all three frameworks in one process with identical routes; the load
generator (`compare-shoot.mjs`, autocannon) runs in a **child process** so it
never competes with the server event loop. Only one target is hit at a time,
rounds are interleaved, and best-of is reported (laptop thermal throttling
penalizes whichever target runs last).

Scenarios (same handler on every framework):

| key | route | tests |
| --- | --- | --- |
| `text` | `GET /` | plain-text response |
| `json` | `GET /json` | small JSON object |
| `param` | `GET /users/:id` | route-param extraction |
| `echo` | `POST /echo` | request-body parse + echo |
| `mw` | `GET /mw` | 2-layer middleware chain + CORS |

```bash
cd bench
node compare.mjs                                  # defaults: 5s, 3 rounds, 64 conns
DURATION=5 ROUNDS=3 CONNECTIONS=64 node compare.mjs
```

### Sample result (i5-1135G7, Win10, Node 22, best-of 3)

| scenario | Express 5 | Fastify | ZenZip | vs Express | vs Fastify |
| --- | ---: | ---: | ---: | ---: | ---: |
| `GET /` | 6,344 | 17,554 | 15,749 | 2.48× | 0.90× |
| `GET /json` | 6,144 | 16,527 | 15,002 | 2.44× | 0.91× |
| `GET /users/:id` | 5,977 | 16,600 | 16,216 | 2.71× | 0.98× |
| `POST /echo` | 4,724 | 8,787 | 8,441 | 1.79× | 0.96× |
| `GET /mw + CORS` | 6,266 | 16,615 | 13,932 | 2.22× | 0.84× |

(req/s, best-of)

**Read-out:** ZenZip is 1.8–2.7× Express on every scenario and within
0.84–1.02× of Fastify — effectively even on routing/params, a hair behind on
the middleware chain.

**What closed the early gap** (P10.7, was ~0.5× Fastify on GETs): the adapter
used to `await readJsonBody()` on *every* request — a body-less GET paid for an
async iteration over the request stream (an extra event-loop turn). It now skips
the read for GET/HEAD/OPTIONS and `content-length: 0`, and reuses the
already-parsed URL for `ctx.query` instead of constructing a second `URL`. That
lifted GET throughput 50–130%.

**Radix router** (P10.8): route match is a per-method radix trie — O(path
depth), no per-request route-array allocation — replacing the linear scan.
Neutral within noise at 5 routes; the win scales with route count.

**What was reverted** (P10.8): a prototype-swap of req/res (Fastify's trick) to
remove per-request closure allocation. Measured — it *halved* GET throughput.
Per-request `Object.setPrototypeOf` is a V8 deopt costing more than the closures
it removes. Plain closures stay.

The HTTP layer is a thin `node:http` adapter (Phase 0 killed the Rust HTTP
server) — you adopt ZenZip for durable queues / workflows / agents, and the
adapter being on par with Fastify means migration costs nothing on the request
path.

> Prerequisite: build the native addon + the `zenzip` package first
> (`pnpm build`). `compare.mjs` imports `../packages/zenzip/dist/index.js`.
