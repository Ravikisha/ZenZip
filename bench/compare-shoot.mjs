// Method-aware child load generator for compare.mjs. Keeps autocannon off the
// server process's event loop. Prints one JSON result line to stdout.
import autocannon from "autocannon";

const [url, duration, connections, method = "GET", body = ""] = process.argv.slice(2);

const opts = {
  url,
  connections: Number(connections),
  duration: Number(duration),
  pipelining: 1,
};
if (method !== "GET") {
  opts.method = method;
  opts.headers = { "content-type": "application/json" };
  if (body) opts.body = body;
}

const res = await autocannon(opts);

console.log(
  JSON.stringify({
    rps: res.requests.average,
    p50: res.latency.p50,
    p99: res.latency.p99,
    bytesPerSec: res.throughput.average,
    errors: res.errors,
    non2xx: res.non2xx,
  }),
);
