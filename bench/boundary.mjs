// P0.4 — JS -> Rust boundary round-trip cost.
// Run: pnpm bench:boundary
import { bench, group, run } from "mitata";
import native from "@zenzip/core-native";

const {
  syncNoop,
  syncAdd,
  syncEchoBuffer,
  syncJsonParseStringify,
  asyncAdd,
  asyncEchoBuffer,
} = native;

const buf1k = Buffer.alloc(1024, 7);
const buf64k = Buffer.alloc(64 * 1024, 7);

// ~1KB JSON document, representative of a queue/workflow payload.
const json1k = JSON.stringify({
  orderId: "ord_8231",
  customer: { id: "cus_991", email: "user@example.com", tier: "pro" },
  items: Array.from({ length: 12 }, (_, i) => ({
    sku: `SKU-${1000 + i}`,
    qty: (i % 3) + 1,
    price: 19.99 + i,
    meta: { warehouse: "EU-1", batch: `B-${i}` },
  })),
  flags: { gift: false, express: true },
});
console.log(`json payload size: ${Buffer.byteLength(json1k)} bytes\n`);

const jsAdd = (a, b) => a + b;

group("call overhead", () => {
  bench("js baseline: jsAdd(1,2)", () => jsAdd(1, 2));
  bench("napi: syncNoop()", () => syncNoop());
  bench("napi: syncAdd(1,2)", () => syncAdd(1, 2));
});

group("buffer passing", () => {
  bench("napi: syncEchoBuffer 1KB", () => syncEchoBuffer(buf1k));
  bench("napi: syncEchoBuffer 64KB", () => syncEchoBuffer(buf64k));
});

group("json 1KB parse+stringify", () => {
  bench("js: JSON.parse + JSON.stringify", () =>
    JSON.stringify(JSON.parse(json1k)),
  );
  bench("napi: serde parse + stringify", () => syncJsonParseStringify(json1k));
});

group("async (tokio task + promise)", () => {
  bench("napi: asyncAdd(1,2)", async () => {
    await asyncAdd(1, 2);
  });
  bench("napi: asyncEchoBuffer 1KB", async () => {
    await asyncEchoBuffer(buf1k);
  });
});

await run();
