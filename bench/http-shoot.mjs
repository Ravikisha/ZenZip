// Child-process load generator for http.mjs — keeps autocannon off the
// server process's event loop. Prints a JSON result line to stdout.
import autocannon from "autocannon";

const [url, duration, connections] = process.argv.slice(2);

const res = await autocannon({
  url,
  connections: Number(connections),
  duration: Number(duration),
  pipelining: 1,
});

console.log(
  JSON.stringify({
    rps: res.requests.average,
    p50: res.latency.p50,
    p99: res.latency.p99,
  }),
);
