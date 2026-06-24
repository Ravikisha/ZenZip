// P7.15: payload encryption at rest. With an encryptionKey set, the engine
// hands handlers plaintext, but the secret must not appear anywhere in the
// on-disk SQLite files.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Concatenate every file in a dir (db + -wal + -shm) and search for `needle`. */
function diskContains(dir: string, needle: string): boolean {
  for (const name of readdirSync(dir)) {
    const buf = readFileSync(join(dir, name));
    if (buf.includes(Buffer.from(needle))) return true;
  }
  return false;
}

describe("payload encryption at rest (P7.15)", () => {
  it("hands handlers plaintext but never writes the secret to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zenzip-enc-"));
    const app: ZenzipApp = zenzip({
      dataDir: dir,
      handleSignals: false,
      encryptionKey: "test-passphrase",
    });

    const secret = "SSN-987-65-4321";
    let received: string | undefined;
    const q = app.queue<{ ssn: string }>("secure", { poll: 20 });
    q.process(async (job) => {
      received = job.data.ssn; // engine must deliver plaintext
    });
    await app.start();
    await q.push({ ssn: secret });

    const deadline = Date.now() + 4000;
    while (received === undefined && Date.now() < deadline) await wait(25);
    expect(received).toBe(secret);

    // Flush + release the file handle so the WAL is checkpointed into the db.
    await app.stop({ timeout: "5s" });

    expect(diskContains(dir, secret)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("without a key, payloads are plaintext on disk (default)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zenzip-plain-"));
    const app: ZenzipApp = zenzip({ dataDir: dir, handleSignals: false });
    const secret = "PLAINTEXT-MARKER-42";
    const q = app.queue<{ v: string }>("plain", { poll: 20 });
    let seen = false;
    q.process(async () => {
      seen = true;
    });
    await app.start();
    await q.push({ v: secret });
    const deadline = Date.now() + 4000;
    while (!seen && Date.now() < deadline) await wait(25);
    await app.stop({ timeout: "5s" });

    // Sanity: the harness can actually find a plaintext payload on disk —
    // proves the encrypted case above isn't a false negative.
    expect(diskContains(dir, secret)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
