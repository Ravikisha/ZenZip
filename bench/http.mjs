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
import express from "express";
import Fastify from "fastify";
import native from "@zenzipjs/core-native";

const execFileAsync = promisify(execFile);
const shooter = join(dirname(fileURLToPath(import.meta.url)), "http-shoot.mjs");

const DURATION = 5; // seconds per target per round
const ROUNDS = 3; // interleaved rounds; best-of reported (laptop thermal throttling skews sequential runs)
const CONNECTIONS = 64;

const PORT_EXPRESS = 3100;
const PORT_FASTIFY = 3101;
const PORT_HYPER_STATIC = 3102;
const PORT_HYPER_JS = 3103;

// 0. Express baseline (what most people migrate FROM).
const app = express();
app.get("/", (_req, res) => res.send("hello world"));
await new Promise((r) => app.listen(PORT_EXPRESS, "127.0.0.1", r));

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

async function shoot(port) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [shooter, `http://127.0.0.1:${port}/`, String(DURATION), String(CONNECTIONS)],
    { timeout: (DURATION + 30) * 1000 },
  );
  return JSON.parse(stdout.trim().split("\n").pop());
}

const targets = [
  { name: "express (node)", port: PORT_EXPRESS },
  { name: "fastify (node)", port: PORT_FASTIFY },
  { name: "hyper static (rust only)", port: PORT_HYPER_STATIC },
  { name: "hyper -> JS handler (TSFN)", port: PORT_HYPER_JS },
];

console.log(
  `${ROUNDS} interleaved rounds x ${DURATION}s, ${CONNECTIONS} connections, load gen in child process, best-of reported\n`,
);

const best = new Map(); // name -> best round result
for (let round = 1; round <= ROUNDS; round++) {
  for (const t of targets) {
    const r = await shoot(t.port);
    const prev = best.get(t.name);
    if (!prev || r.rps > prev.rps) best.set(t.name, r);
  }
  console.log(`round ${round}/${ROUNDS} done`);
}
console.log("");

for (const t of targets) {
  const r = best.get(t.name);
  console.log(
    `${t.name.padEnd(28)}: ${Math.round(r.rps).toLocaleString().padStart(10)} req/s avg   p50 ${String(r.p50).padStart(4)} ms   p99 ${String(r.p99).padStart(4)} ms`,
  );
}

const expressRps = best.get("express (node)").rps;
const fastifyRps = best.get("fastify (node)").rps;
const hyperRps = best.get("hyper static (rust only)").rps;
const hyperJsRps = best.get("hyper -> JS handler (TSFN)").rps;

console.log(`\nhyper static vs fastify : ${(hyperRps / fastifyRps).toFixed(2)}x`);
console.log(`hyper->JS    vs fastify : ${(hyperJsRps / fastifyRps).toFixed(2)}x`);
console.log(`hyper->JS    vs express : ${(hyperJsRps / expressRps).toFixed(2)}x`);
console.log(
  `\nD5 read: hyper->JS must beat fastify meaningfully (>1.3x) to justify a Rust HTTP layer.`,
);

process.exit(0);
