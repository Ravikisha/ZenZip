// P0.6 — hyper (Rust) vs Fastify (Node) hello-world throughput.
// Settles plan.md D5: is a Rust HTTP layer calling JS handlers worth it?
//
// Servers run in THIS process; autocannon runs in a child process so the
// load generator never competes with fastify / the TSFN handler for the
// server event loop. Same-machine numbers — relative, not absolute.
// Run: pnpm bench:http
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import Fastify from "fastify";
import native from "@zenzip/core-native";

const execFileAsync = promisify(execFile);
const shooter = join(dirname(fileURLToPath(import.meta.url)), "http-shoot.mjs");

const DURATION = 10; // seconds per target
const CONNECTIONS = 64;

const PORT_FASTIFY = 3101;
const PORT_HYPER_STATIC = 3102;
const PORT_HYPER_JS = 3103;

// 1. Fastify baseline (the bar to beat).
const fastify = Fastify({ logger: false });
fastify.get("/", async () => "hello world");
await fastify.listen({ port: PORT_FASTIFY, host: "127.0.0.1" });

// 2. Pure-Rust hyper (upper bound, no JS in the request path).
native.startHyperStatic(PORT_HYPER_STATIC);

// 3. hyper accepting, JS handler producing the body via TSFN (the D5 shape).
native.startHyperJs(PORT_HYPER_JS, (err, _path) => {
  if (err) throw err;
  return "hello world";
});

// Let the Rust server threads bind.
await new Promise((r) => setTimeout(r, 500));

async function shoot(name, port) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [shooter, `http://127.0.0.1:${port}/`, String(DURATION), String(CONNECTIONS)],
    { timeout: (DURATION + 30) * 1000 },
  );
  const r = JSON.parse(stdout.trim().split("\n").pop());
  console.log(
    `${name.padEnd(28)}: ${Math.round(r.rps).toLocaleString().padStart(10)} req/s avg   p50 ${String(r.p50).padStart(4)} ms   p99 ${String(r.p99).padStart(4)} ms`,
  );
  return r.rps;
}

console.log(
  `duration ${DURATION}s, ${CONNECTIONS} connections, load gen in child process\n`,
);

const fastifyRps = await shoot("fastify (node)", PORT_FASTIFY);
const hyperRps = await shoot("hyper static (rust only)", PORT_HYPER_STATIC);
const hyperJsRps = await shoot("hyper -> JS handler (TSFN)", PORT_HYPER_JS);

console.log(`\nhyper static vs fastify : ${(hyperRps / fastifyRps).toFixed(2)}x`);
console.log(`hyper->JS    vs fastify : ${(hyperJsRps / fastifyRps).toFixed(2)}x`);
console.log(
  `\nD5 read: hyper->JS must beat fastify meaningfully (>1.3x) to justify a Rust HTTP layer.`,
);

process.exit(0);
