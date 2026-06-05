import type { Server } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { HttpRouter, serveRouter, type HttpContext } from "./http.js";
import type { ZenzipApp } from "./app.js";

export interface DashboardOptions {
  port?: number;
  host?: string;
  /**
   * When set, every request must carry the token (`Authorization: Bearer …`
   * or `?token=`). Without it the dashboard is open — keep it on 127.0.0.1.
   */
  token?: string;
}

function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Embedded observability dashboard (P3.13–P3.16). */
export async function startDashboard(
  app: ZenzipApp,
  options: DashboardOptions = {},
): Promise<Server> {
  const router = new HttpRouter();
  const native = () => app._native;
  const token = options.token;

  const authorized = (ctx: HttpContext): boolean => {
    if (!token) return true;
    const header = ctx.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const provided = bearer ?? ctx.query.get("token") ?? undefined;
    if (tokenMatches(token, provided)) return true;
    ctx.status(401).json({ error: "unauthorized" });
    return false;
  };

  const overview = async () => {
    const [queues, schedules, runs, events] = await Promise.all([
      native().dashboardQueues(),
      native().dashboardSchedules(),
      native().dashboardRuns(undefined, undefined, 25),
      native().dashboardEvents(25),
    ]);
    return {
      queues: JSON.parse(queues),
      schedules: JSON.parse(schedules),
      runs: JSON.parse(runs),
      events: JSON.parse(events),
      metrics: JSON.parse(native().metricsSnapshot()),
    };
  };

  router.add("GET", "/", (ctx) => {
    if (!authorized(ctx)) return;
    ctx.res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    ctx.res.end(DASHBOARD_HTML);
  });

  router.add("GET", "/api/overview", async (ctx) => {
    if (!authorized(ctx)) return;
    return overview();
  });

  // SSE live updates (P3.14): one overview frame every 1.5s per client.
  router.add("GET", "/api/stream", async (ctx) => {
    if (!authorized(ctx)) return;
    ctx.res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    let closed = false;
    const send = async () => {
      if (closed) return;
      try {
        ctx.res.write(`data: ${JSON.stringify(await overview())}\n\n`);
      } catch {
        /* native runtime stopping — the close handler cleans up */
      }
    };
    await send();
    const timer = setInterval(send, 1_500);
    ctx.req.on("close", () => {
      closed = true;
      clearInterval(timer);
    });
  });

  router.add("GET", "/api/metrics", (ctx) => {
    if (!authorized(ctx)) return;
    return JSON.parse(native().metricsSnapshot());
  });

  router.add("GET", "/api/runs", async (ctx) => {
    if (!authorized(ctx)) return;
    const workflow = ctx.query.get("workflow") ?? undefined;
    const statusParam = ctx.query.get("status");
    const status = statusParam !== null ? Number(statusParam) : undefined;
    return JSON.parse(await native().dashboardRuns(workflow, status, 100));
  });

  router.add("GET", "/api/runs/:id", async (ctx) => {
    if (!authorized(ctx)) return;
    const raw = native().getRun(ctx.params.id);
    if (!raw) {
      ctx.status(404).json({ error: "run not found" });
      return;
    }
    const steps = JSON.parse(await native().dashboardRunSteps(ctx.params.id));
    return { run: JSON.parse(raw), steps };
  });

  router.add("POST", "/api/queues/:name/requeue-dead", async (ctx) => {
    if (!authorized(ctx)) return;
    const dead = JSON.parse(await native().deadJobs(ctx.params.name, 1000)) as Array<{
      id: string;
    }>;
    if (dead.length === 0) return { requeued: 0 };
    const requeued = await native().requeueDead(dead.map((d) => d.id));
    return { requeued };
  });

  return serveRouter(router, options.port ?? 4100, options.host ?? "127.0.0.1");
}

const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>zenzip dashboard</title>
<style>
  :root { --bg:#09090b; --surface:#0e0e12; --edge:#26262e; --edge2:#1c1c22;
          --ink:#fafafa; --mid:#a1a1aa; --dim:#71717a; --accent:#a78bfa; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--mid); font:14px/1.6 ui-sans-serif,system-ui,sans-serif; }
  code, .mono { font-family:ui-monospace,Consolas,monospace; font-size:12.5px; }
  header { display:flex; align-items:center; gap:14px; padding:14px 22px;
           border-bottom:1px solid var(--edge2); position:sticky; top:0; background:rgba(9,9,11,.9); backdrop-filter:blur(6px); }
  .logo { display:flex; align-items:center; gap:9px; color:var(--ink); font-weight:600; }
  .logo .mark { width:24px; height:24px; border-radius:7px; display:grid; place-items:center;
                background:linear-gradient(135deg,#8b5cf6,#c026d3); color:#fff; font-size:13px; }
  .pill { font-size:11px; padding:2px 9px; border:1px solid rgba(139,92,246,.35);
          border-radius:999px; color:var(--accent); background:rgba(139,92,246,.1); }
  .live { width:7px; height:7px; border-radius:99px; background:#34d399; display:inline-block;
          margin-right:6px; animation:pulse 2s infinite; }
  @keyframes pulse { 50% { opacity:.35; } }
  main { max-width:1180px; margin:0 auto; padding:24px 22px 60px; display:grid; gap:22px; }
  h2 { color:var(--ink); font-size:15px; margin-bottom:10px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }
  .card { background:var(--surface); border:1px solid var(--edge); border-radius:12px; padding:14px 16px; }
  .card .v { color:var(--ink); font-size:22px; font-weight:600; font-family:ui-monospace,monospace; }
  .card .l { font-size:12px; color:var(--dim); margin-top:2px; }
  table { width:100%; border-collapse:collapse; background:var(--surface);
          border:1px solid var(--edge); border-radius:12px; overflow:hidden; }
  th, td { text-align:left; padding:9px 14px; border-bottom:1px solid var(--edge2); }
  th { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
  tr:last-child td { border-bottom:none; }
  tbody tr.click:hover { background:#15151b; cursor:pointer; }
  .chip { font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid; }
  .s-completed { color:#34d399; border-color:rgba(52,211,153,.4); }
  .s-failed, .s-dead { color:#f87171; border-color:rgba(248,113,113,.4); }
  .s-running, .s-pending { color:#a78bfa; border-color:rgba(167,139,250,.4); }
  .s-sleeping, .s-waitingEvent, .s-waitingChild { color:#fbbf24; border-color:rgba(251,191,36,.4); }
  .s-cancelled { color:#71717a; border-color:#3f3f46; }
  button { background:#1b1b22; color:var(--mid); border:1px solid var(--edge);
           padding:4px 12px; border-radius:8px; font-size:12px; cursor:pointer; }
  button:hover { color:var(--ink); border-color:#52525b; }
  #detail { background:var(--surface); border:1px solid var(--edge); border-radius:12px; padding:18px; display:none; }
  .muted { color:var(--dim); font-size:12px; }
  .grid2 { display:grid; gap:22px; grid-template-columns:1fr; }
  @media (min-width: 980px) { .grid2 { grid-template-columns:1.2fr .8fr; } }
  /* step graph (P3.15): vertical chain with connectors */
  .graph { margin-top:12px; }
  .gnode { position:relative; padding:10px 14px 10px 34px; }
  .gnode::before { content:""; position:absolute; left:14px; top:0; bottom:0; width:2px; background:var(--edge); }
  .gnode:first-child::before { top:50%; }
  .gnode:last-child::before { bottom:50%; }
  .gnode::after { content:""; position:absolute; left:9px; top:calc(50% - 6px); width:12px; height:12px;
                  border-radius:99px; border:2px solid var(--accent); background:var(--bg); }
  .gnode.failed::after { border-color:#f87171; }
  .gnode .box { background:#13131a; border:1px solid var(--edge); border-radius:10px;
                padding:8px 12px; display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; }
</style>
</head>
<body>
<header>
  <span class="logo"><span class="mark">⚡</span>zenzip</span>
  <span class="pill">dashboard</span>
  <span class="muted" id="status" style="margin-left:auto"></span>
</header>
<main>
  <section><div class="cards" id="cards"></div></section>
  <section><h2>Engine metrics</h2><div class="cards" id="metricCards"></div></section>
  <section id="detail"></section>
  <div class="grid2">
    <section>
      <h2>Workflow runs</h2>
      <table><thead><tr><th>Workflow</th><th>Status</th><th>Run</th><th>Updated</th></tr></thead>
      <tbody id="runs"></tbody></table>
    </section>
    <section>
      <h2>Events</h2>
      <table><thead><tr><th>Event</th><th>Payload</th><th>At</th></tr></thead>
      <tbody id="events"></tbody></table>
    </section>
  </div>
  <section>
    <h2>Queues</h2>
    <table><thead><tr><th>Queue</th><th>Pending</th><th>Running</th><th>Dead</th><th></th></tr></thead>
    <tbody id="queues"></tbody></table>
  </section>
  <section>
    <h2>Schedules</h2>
    <table><thead><tr><th>Name</th><th>Spec</th><th>Overlap</th><th>Catchup</th><th>Next fire</th></tr></thead>
    <tbody id="schedules"></tbody></table>
  </section>
</main>
<script>
const RUN_STATUS = ["running","sleeping","waitingEvent","waitingChild","completed","failed","cancelled"];
const TOKEN = new URLSearchParams(location.search).get("token");
const withToken = (url) => TOKEN ? url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(TOKEN) : url;
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const ago = (ms) => { const d = Date.now() - ms; if (d < 2000) return "now";
  if (d < 60000) return Math.round(d/1000) + "s ago"; if (d < 3600000) return Math.round(d/60000) + "m ago";
  return new Date(ms).toLocaleTimeString(); };
const until = (ms) => { const d = ms - Date.now(); if (d <= 0) return "due";
  if (d < 60000) return "in " + Math.round(d/1000) + "s"; if (d < 3600000) return "in " + Math.round(d/60000) + "m";
  return new Date(ms).toLocaleString(); };
const chip = (name) => '<span class="chip s-' + esc(name) + '">' + esc(name) + "</span>";

function render(data) {
  const totals = data.queues.reduce((a,q)=>({p:a.p+q.pending,r:a.r+q.running,d:a.d+q.dead}),{p:0,r:0,d:0});
  const active = data.runs.filter(x=>x.status<4).length;
  document.getElementById("cards").innerHTML = [
    ["Active runs", active], ["Pending jobs", totals.p], ["Running jobs", totals.r],
    ["Dead letters", totals.d], ["Schedules", data.schedules.length],
  ].map(([l,v])=>'<div class="card"><div class="v">'+v+'</div><div class="l">'+l+"</div></div>").join("");

  const m = data.metrics || {};
  document.getElementById("metricCards").innerHTML = [
    ["Jobs completed", m.jobsCompleted], ["Job retries", m.jobsRetried],
    ["Runs completed", m.runsCompleted], ["Step retries", m.stepRetries],
    ["Steps recorded", m.stepsRecorded], ["Events emitted", m.eventsEmitted],
    ["Schedule fires", m.scheduleFires],
    ["Handler avg", (m.handlerAvgMs||0).toFixed(1) + "ms"],
  ].map(([l,v])=>'<div class="card"><div class="v">'+(v??0)+'</div><div class="l">'+l+"</div></div>").join("");

  document.getElementById("runs").innerHTML = data.runs.map(run =>
    '<tr class="click" onclick="showRun(\\''+run.id+'\\')"><td>'+esc(run.workflow)+"</td><td>"+
    chip(RUN_STATUS[run.status]||run.status)+'</td><td class="mono">'+run.id.slice(-12)+
    "</td><td class='muted'>"+ago(run.updatedAt)+"</td></tr>").join("") ||
    '<tr><td colspan="4" class="muted">no runs yet</td></tr>';

  document.getElementById("events").innerHTML = data.events.map(ev =>
    "<tr><td class='mono'>"+esc(ev.name)+"</td><td class='mono muted'>"+esc(ev.payload.slice(0,48))+
    "</td><td class='muted'>"+ago(ev.emittedAt)+"</td></tr>").join("") ||
    '<tr><td colspan="3" class="muted">no events yet</td></tr>';

  document.getElementById("queues").innerHTML = data.queues.map(q =>
    "<tr><td class='mono'>"+esc(q.queue)+"</td><td>"+q.pending+"</td><td>"+q.running+"</td><td>"+
    (q.dead>0?'<span class="chip s-dead">'+q.dead+"</span>":"0")+"</td><td>"+
    (q.dead>0?'<button onclick="requeue(\\''+esc(q.queue)+'\\')">requeue dead</button>':"")+"</td></tr>").join("") ||
    '<tr><td colspan="5" class="muted">no queues yet</td></tr>';

  document.getElementById("schedules").innerHTML = data.schedules.map(s =>
    "<tr><td class='mono'>"+esc(s.name)+"</td><td class='mono muted'>"+esc(s.spec)+"</td><td>"+esc(s.overlap)+
    "</td><td>"+esc(s.catchup)+"</td><td class='muted'>"+until(s.nextRunAt)+"</td></tr>").join("") ||
    '<tr><td colspan="5" class="muted">no schedules</td></tr>';
}

async function showRun(id) {
  const r = await fetch(withToken("/api/runs/" + id)); if (!r.ok) return;
  const { run, steps } = await r.json();
  const el = document.getElementById("detail");
  el.style.display = "block";
  el.innerHTML = "<h2>Run <span class='mono'>" + esc(run.id) + "</span> · " + esc(run.workflow) + " · " +
    chip(RUN_STATUS[run.status]||run.status) + "</h2>" +
    (run.error ? "<p class='muted' style='color:#f87171'>" + esc(run.error) + "</p>" : "") +
    (run.output ? "<p class='mono muted'>output: " + esc(run.output) + "</p>" : "") +
    "<div class='graph'>" + (steps.map((s, i) => {
      const prev = i > 0 ? steps[i-1].updatedAt : run.createdAt;
      const delta = Math.max(0, s.updatedAt - prev);
      return "<div class='gnode" + (s.error && s.status !== 1 ? " failed" : "") + "'><div class='box'>" +
        "<span class='mono' style='color:var(--ink)'>" + esc(s.stepId) + "</span>" +
        "<span class='muted'>" + esc(s.kind) + "</span>" +
        (s.status === 1 ? chip("completed") : chip("running") + " <span class='muted'>attempts " + s.attempts + "</span>") +
        "<span class='muted'>+" + (delta < 1000 ? delta + "ms" : (delta/1000).toFixed(1) + "s") + "</span>" +
        (s.error ? "<span class='muted' style='color:#f87171'>" + esc(s.error) + "</span>" : "") +
        "</div></div>";
    }).join("") || "<p class='muted'>no steps recorded yet</p>") + "</div>" +
    "<div style='margin-top:12px'><button onclick=\\"this.closest('#detail').style.display='none'\\">close</button></div>";
}

async function requeue(queue) {
  await fetch(withToken("/api/queues/" + encodeURIComponent(queue) + "/requeue-dead"), { method: "POST" });
  poll();
}

async function poll() {
  try {
    const r = await fetch(withToken("/api/overview"));
    if (r.ok) render(await r.json());
  } catch { /* retry next tick */ }
}

// Live via SSE; polling fallback if the stream can't connect.
let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  document.getElementById("status").innerHTML = "polling";
  poll();
  pollTimer = setInterval(poll, 2000);
}
try {
  const es = new EventSource(withToken("/api/stream"));
  es.onmessage = (e) => {
    document.getElementById("status").innerHTML = '<span class="live"></span>live';
    render(JSON.parse(e.data));
  };
  es.onerror = () => { es.close(); startPolling(); };
} catch { startPolling(); }
</script>
</body>
</html>`;
