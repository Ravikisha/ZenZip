#!/usr/bin/env node
// zenzip CLI (P6.2):
//   zenzip dev <file> [...args]   restart-on-change dev loop (node --watch)
//   zenzip doctor [dataDir]       inspect a store: health, queues, runs, DLQ
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const [command, ...rest] = process.argv.slice(2);

function help(code: number): never {
  console.log(`
  zenzip — durable workflows, queues, schedules, and agents for Node.js

  Commands:
    zenzip dev <file> [...args]   run with restart-on-change (node --watch)
    zenzip doctor [dataDir]       health-check a store (default: .zenzip)
`);
  process.exit(code);
}

async function doctor(dataDirArg?: string): Promise<void> {
  const dataDir = resolve(dataDirArg ?? ".zenzip");
  const ok = (msg: string) => console.log(`  ✔ ${msg}`);
  const warn = (msg: string) => console.log(`  ⚠ ${msg}`);
  const bad = (msg: string) => console.log(`  ✘ ${msg}`);

  console.log(`\nzenzip doctor — ${dataDir}\n`);

  const [major] = process.versions.node.split(".").map(Number);
  if (major >= 18) ok(`node ${process.versions.node}`);
  else bad(`node ${process.versions.node} — zenzip needs >= 18`);

  let native: typeof import("@zenzip/core-native");
  try {
    native = await import("@zenzip/core-native");
    ok("native binding loads");
  } catch (e) {
    bad(`native binding failed to load: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  if (!existsSync(join(dataDir, "zenzip.db"))) {
    warn(`no store at ${join(dataDir, "zenzip.db")} — run your app once first`);
    process.exit(0);
  }

  const runtime = new native.ZenRuntime({ dataDir });
  try {
    ok("store opens (schema is current)");

    const queues = JSON.parse(await runtime.dashboardQueues()) as Array<{
      queue: string;
      pending: number;
      running: number;
      dead: number;
    }>;
    const dead = queues.reduce((a, q) => a + q.dead, 0);
    const pending = queues.reduce((a, q) => a + q.pending, 0);
    ok(`${queues.length} queue(s) — ${pending} pending`);
    if (dead > 0) {
      warn(`${dead} dead-lettered job(s):`);
      for (const q of queues.filter((q) => q.dead > 0)) {
        console.log(`      ${q.queue}: ${q.dead} (requeue via the dashboard or queue.requeueDead())`);
      }
    } else {
      ok("dead-letter queues empty");
    }

    const runs = JSON.parse(await runtime.dashboardRuns(undefined, undefined, 1000)) as Array<{
      status: number;
      workflow: string;
      version: string | null;
    }>;
    const byStatus = [0, 0, 0, 0, 0, 0, 0];
    for (const run of runs) byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;
    const names = ["running", "sleeping", "waitingEvent", "waitingChild", "completed", "failed", "cancelled"];
    ok(
      `${runs.length} recent run(s) — ` +
        names
          .map((n, i) => (byStatus[i] ? `${byStatus[i]} ${n}` : null))
          .filter(Boolean)
          .join(", "),
    );
    if (byStatus[5] > 0) warn(`${byStatus[5]} failed run(s) — inspect them in the dashboard`);

    // Version drift (D6): in-flight runs pinned to definitions that may have
    // changed. Multiple versions of one workflow in non-terminal runs = a
    // deploy with live runs from an older definition.
    const inflight = runs.filter((run) => run.status < 4);
    const versionsByWorkflow = new Map<string, Set<string>>();
    for (const run of inflight) {
      const set = versionsByWorkflow.get(run.workflow) ?? new Set();
      set.add(run.version ?? "unversioned");
      versionsByWorkflow.set(run.workflow, set);
    }
    const drifted = [...versionsByWorkflow].filter(([, v]) => v.size > 1);
    if (drifted.length > 0) {
      for (const [workflow, versions] of drifted) {
        warn(
          `workflow "${workflow}" has in-flight runs across ${versions.size} definition versions — keep step ids stable (see workflow versioning docs)`,
        );
      }
    } else {
      ok("no workflow version drift among in-flight runs");
    }

    const schedules = JSON.parse(await runtime.dashboardSchedules()) as Array<{
      name: string;
      nextRunAt: number;
    }>;
    const overdue = schedules.filter((s) => s.nextRunAt < Date.now() - 60_000);
    if (schedules.length > 0) {
      ok(`${schedules.length} schedule(s)`);
      if (overdue.length > 0) {
        warn(
          `${overdue.length} schedule(s) overdue by >1m (${overdue.map((s) => s.name).join(", ")}) — is the app running?`,
        );
      }
    }
    console.log("");
  } finally {
    await runtime.stop(1_000);
  }
}

if (!command || command === "--help" || command === "-h") help(command ? 0 : 1);

if (command === "dev") {
  const [file, ...fileArgs] = rest;
  if (!file) {
    console.error("usage: zenzip dev <file> [...args]");
    process.exit(1);
  }
  const child = spawn(process.execPath, ["--watch", file, ...fileArgs], {
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
} else if (command === "doctor") {
  doctor(rest[0]).catch((e) => {
    console.error(`  ✘ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
} else {
  console.error(`unknown command "${command}"`);
  help(1);
}
