// P10.5 — feature-for-feature HTTP throughput: ZenZip vs Express vs Fastify.
//
// All three frameworks run in THIS process; the load generator runs in a child
// (compare-shoot.mjs) so it never competes with the server event loop. Only one
// target is hit at a time, rounds are interleaved, and best-of is reported
// (laptop thermal throttling skews sequential runs). Same-machine numbers —
// READ THEM AS RELATIVE, not absolute.
//
// Scenarios are identical handlers across the three frameworks so the only
// variable is framework overhead:
//   text   GET  /            -> "hello world" (text/plain)
//   json   GET  /json        -> {hello:"world"}
//   param  GET  /users/:id   -> {id} (route param extraction)
//   echo   POST /echo        -> echoes the parsed JSON body
//   mw     GET  /mw          -> json after a 2-layer middleware chain + CORS
//
// Run: node compare.mjs            (defaults below)
//      DURATION=5 ROUNDS=3 CONNECTIONS=64 node compare.mjs
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import express from "express";
import Fastify from "fastify";

import { zenzip, cors } from "../packages/zenzip/dist/index.js";

const execFileAsync = promisify(execFile);
const shooter = join(dirname(fileURLToPath(import.meta.url)), "compare-shoot.mjs");

const DURATION = Number(process.env.DURATION ?? 5); // seconds per target per round
const ROUNDS = Number(process.env.ROUNDS ?? 3); // interleaved; best-of reported
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 64);

const PORTS = { express: 3200, fastify: 3201, zenzip: 3202 };
const ECHO_BODY = JSON.stringify({ name: "ada", n: 42, tags: ["a", "b", "c"] });

const SCENARIOS = [
  { key: "text", method: "GET", path: "/", body: "" },
  { key: "json", method: "GET", path: "/json", body: "" },
  { key: "param", method: "GET", path: "/users/123", body: "" },
  { key: "echo", method: "POST", path: "/echo", body: ECHO_BODY },
  { key: "mw", method: "GET", path: "/mw", body: "" },
];

// ── Express ────────────────────────────────────────────────────────────────
const ex = express();
ex.disable("x-powered-by");
ex.disable("etag");
ex.get("/", (_req, res) => res.type("text/plain").send("hello world"));
ex.get("/json", (_req, res) => res.json({ hello: "world" }));
ex.get("/users/:id", (req, res) => res.json({ id: req.params.id }));
ex.post("/echo", express.json(), (req, res) => res.json(req.body));
const exCors = (_req, res, next) => {
  res.setHeader("access-control-allow-origin", "*");
  next();
};
const exNoop = (_req, _res, next) => next();
ex.get("/mw", exCors, exNoop, (_req, res) => res.json({ ok: true }));
await new Promise((r) => ex.listen(PORTS.express, "127.0.0.1", r));

// ── Fastify ────────────────────────────────────────────────────────────────
const fy = Fastify({ logger: false });
fy.get("/", (_req, reply) => reply.type("text/plain").send("hello world"));
fy.get("/json", async () => ({ hello: "world" }));
fy.get("/users/:id", async (req) => ({ id: req.params.id }));
fy.post("/echo", async (req) => req.body);
fy.get(
  "/mw",
  {
    onRequest: [
      (_req, reply, done) => {
        reply.header("access-control-allow-origin", "*");
        done();
      },
      (_req, _reply, done) => done(),
    ],
  },
  async () => ({ ok: true }),
);
await fy.listen({ port: PORTS.fastify, host: "127.0.0.1" });

// ── ZenZip ─────────────────────────────────────────────────────────────────
const dataDir = mkdtempSync(join(tmpdir(), "zenzip-bench-"));
const app = zenzip({ dataDir, handleSignals: false });
app.get("/", (ctx) => ctx.text("hello world"));
app.get("/json", () => ({ hello: "world" }));
app.get("/users/:id", (ctx) => ({ id: ctx.params.id }));
app.post("/echo", (ctx) => ctx.body);
// ZenZip applies middleware via app.use (path-scoped), not per-route varargs.
const zNoop = (_req, _res, next) => next();
app.use("/mw", cors({ origin: "*" }));
app.use("/mw", zNoop);
app.get("/mw", (_req, res) => res.json({ ok: true }));
await app.start();
const zserver = await app.listen({ port: PORTS.zenzip, host: "127.0.0.1" });

await new Promise((r) => setTimeout(r, 400)); // let everything settle

async function shoot(port, sc) {
  const url = `http://127.0.0.1:${port}${sc.path}`;
  const { stdout } = await execFileAsync(
    process.execPath,
    [shooter, url, String(DURATION), String(CONNECTIONS), sc.method, sc.body],
    { timeout: (DURATION + 30) * 1000, maxBuffer: 1 << 20 },
  );
  return JSON.parse(stdout.trim().split("\n").pop());
}

const FRAMEWORKS = ["express", "fastify", "zenzip"];
console.log(
  `ZenZip vs Express vs Fastify — ${ROUNDS} interleaved rounds x ${DURATION}s, ` +
    `${CONNECTIONS} connections, load gen in child process, best-of reported.\n` +
    `node ${process.version}\n`,
);

// best[scenario][framework] = best round result (highest rps)
const best = {};
for (const sc of SCENARIOS) best[sc.key] = {};

for (let round = 1; round <= ROUNDS; round++) {
  for (const sc of SCENARIOS) {
    for (const fw of FRAMEWORKS) {
      const r = await shoot(PORTS[fw], sc);
      const prev = best[sc.key][fw];
      if (!prev || r.rps > prev.rps) best[sc.key][fw] = r;
    }
  }
  console.log(`round ${round}/${ROUNDS} done`);
}
console.log("");

const fmt = (n) => Math.round(n).toLocaleString().padStart(10);
for (const sc of SCENARIOS) {
  console.log(`── ${sc.key.toUpperCase()}  (${sc.method} ${sc.path}) ───────────────`);
  const fastifyRps = best[sc.key].fastify.rps;
  for (const fw of FRAMEWORKS) {
    const r = best[sc.key][fw];
    const rel = (r.rps / fastifyRps).toFixed(2);
    const bad = r.errors + r.non2xx;
    console.log(
      `  ${fw.padEnd(8)} ${fmt(r.rps)} req/s   p50 ${String(r.p50).padStart(4)}ms  ` +
        `p99 ${String(r.p99).padStart(4)}ms   ${rel.padStart(5)}x fastify` +
        (bad ? `   ⚠ ${bad} bad responses` : ""),
    );
  }
  console.log("");
}

// Compact matrix for the docs table.
console.log("req/s matrix (best-of):");
console.log("scenario".padEnd(10) + FRAMEWORKS.map((f) => f.padStart(12)).join(""));
for (const sc of SCENARIOS) {
  console.log(
    sc.key.padEnd(10) +
      FRAMEWORKS.map((f) => Math.round(best[sc.key][f].rps).toLocaleString().padStart(12)).join(""),
  );
}

await zserver.close();
await app.stop({ timeout: "5s" });
await fy.close();
rmSync(dataDir, { recursive: true, force: true });
process.exit(0);
