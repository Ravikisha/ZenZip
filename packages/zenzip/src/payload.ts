import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Large payload offloading (P9.1). Step results over a size threshold are
 * written to a blob store and replaced in the journal by a small reference,
 * keeping the run/step tables lean even when an LLM returns a huge response.
 * Rehydration on replay is transparent — the workflow sees the real value.
 */

/** Pluggable blob backend. The default is the local filesystem; supply your
 * own (e.g. S3) for multi-node deployments — a node must be able to read a
 * blob another node wrote. */
export interface BlobStore {
  /** Store `data` under a logical key; return an opaque reference. */
  put(key: string, data: string): Promise<string>;
  /** Fetch the data for a reference returned by put(). */
  get(ref: string): Promise<string>;
  /** Best-effort delete (optional). */
  delete?(ref: string): Promise<void>;
}

/** Filesystem blob store rooted at a directory (default: <dataDir>/blobs). */
export class FilesystemBlobStore implements BlobStore {
  constructor(private readonly dir: string) {}

  async put(key: string, data: string): Promise<string> {
    const ref = key.replace(/[^a-zA-Z0-9_/-]/g, "_") + ".json";
    const file = join(this.dir, ref);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data, "utf8");
    return ref;
  }

  async get(ref: string): Promise<string> {
    return readFile(join(this.dir, ref), "utf8");
  }

  async delete(ref: string): Promise<void> {
    await rm(join(this.dir, ref), { force: true });
  }
}

const MARKER_PREFIX = '{"$zenzipBlob"';

/** Offloads/rehydrates journal values against a blob store + size threshold. */
export interface PayloadCodec {
  /** Returns what to persist for a step result: a blob marker if it exceeded
   * the threshold, otherwise the value unchanged. */
  offload(runId: string, stepId: string, json: string): Promise<string>;
  /** Returns the real value, fetching from the blob store if `stored` is a
   * marker; a passthrough otherwise. */
  rehydrate(stored: string | null): Promise<string | null>;
}

export function createPayloadCodec(store: BlobStore, thresholdBytes: number): PayloadCodec {
  return {
    async offload(runId, stepId, json) {
      if (Buffer.byteLength(json, "utf8") <= thresholdBytes) return json;
      const ref = await store.put(`${runId}/${stepId}`, json);
      return JSON.stringify({ $zenzipBlob: ref });
    },
    async rehydrate(stored) {
      if (stored === null || !stored.startsWith(MARKER_PREFIX)) return stored;
      try {
        const marker = JSON.parse(stored) as { $zenzipBlob?: string };
        if (typeof marker.$zenzipBlob === "string") {
          return await store.get(marker.$zenzipBlob);
        }
      } catch {
        /* not a real marker — fall through to the literal value */
      }
      return stored;
    },
  };
}
