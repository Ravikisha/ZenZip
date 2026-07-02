// P0.5 — Rust -> JS ThreadsafeFunction dispatch throughput.
// Models "Rust engine invokes JS step handler, awaits result".
// Run: pnpm bench:tsfn
import native from "@zenzipjs/core-native";

const { benchTsfnRoundtrip, benchTsfnConcurrent } = native;

const N = 100_000;
// CalleeHandled TSFN: callback receives (err, value); return value resolves
// the Rust-side call_async.
const handler = (err, v) => {
  if (err) throw err;
  return v;
};

console.log(`iterations: ${N.toLocaleString()}\n`);

// Warmup.
await benchTsfnRoundtrip(handler, 5_000);

const seqMs = await benchTsfnRoundtrip(handler, N);
console.log(
  `sequential          : ${seqMs.toFixed(1).padStart(9)} ms  →  ${Math.round(N / (seqMs / 1000)).toLocaleString().padStart(12)} round-trips/s`,
);

for (const c of [16, 64, 256]) {
  const ms = await benchTsfnConcurrent(handler, N, c);
  console.log(
    `concurrent x${String(c).padEnd(3)}     : ${ms.toFixed(1).padStart(9)} ms  →  ${Math.round(N / (ms / 1000)).toLocaleString().padStart(12)} round-trips/s`,
  );
}
