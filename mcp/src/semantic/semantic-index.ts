// Keeps a meaning vector for every searchable screenshot, made by the local
// embedding model. Vectors are derived data: any change to a screenshot's
// details changes its document hash, and refresh() re-embeds it.

import type { Config } from "../config.ts";
import { type Db, getMeta, now, transaction } from "../db.ts";
import { searchGeneration } from "../search-index.ts";
import { type EmbeddingDocument, embeddingDocuments } from "./documents.ts";
import { type Embedder, ProcessEmbedder } from "./embedder.ts";
import { type InstallProgress, installSemantic } from "./install.ts";
import { DISK_BYTES, DOWNLOAD_BYTES, MODEL, isInstalled, platformSupport } from "./model.ts";
import { toBlob, toVector } from "./vectors.ts";

const BATCH = 8;
const DEBOUNCE_MS = 1500;
const MB = 1_000_000;

export type SemanticState = "unsupported" | "not_set_up" | "downloading" | "ready" | "error";

export interface SemanticStatus {
  state: SemanticState;
  model: string;
  license: string;
  /** Screenshots whose meaning vector is current. */
  indexed: number;
  /** Screenshots that are new or changed since they were last embedded. */
  waiting: number;
  indexing_now?: boolean;
  download?: { total_mb: number; received_mb?: number; disk_mb: number };
  /** The user said no to setting it up; don't offer again unless they ask. */
  declined?: true;
  error?: string;
}

export interface RefreshResult {
  embedded: number;
  remaining: number;
}

export class SemanticIndex {
  /** Re-embed automatically after changes (the MCP server turns this on; the CLI doesn't). */
  autoRefresh = false;
  private embedder?: Embedder;
  private readonly injected: boolean;
  private downloading?: InstallProgress;
  private failure?: string;
  private refreshing?: Promise<RefreshResult>;
  private rerun = false;
  private timer?: NodeJS.Timeout;
  private seenGeneration = -1;
  private cache?: { key: string; vectors: Map<string, Float32Array> };
  private closed = false;
  private readonly db: Db;
  private readonly config: Config;

  constructor(db: Db, config: Config, embedder?: Embedder) {
    this.db = db;
    this.config = config;
    this.embedder = embedder;
    this.injected = embedder !== undefined;
  }

  /** True when the model is installed (or injected) and can run here. */
  get ready(): boolean {
    return this.injected || (platformSupport().supported && isInstalled(this.config));
  }

  private get model(): string {
    return this.embedder?.model ?? MODEL.id;
  }

  status(): SemanticStatus {
    const support = platformSupport();
    const base = {
      model: `${MODEL.name} by ${MODEL.publisher}, running on this Mac`,
      license: `${MODEL.license} (${MODEL.termsUrl})`,
    };
    if (!this.injected && !support.supported) {
      return { state: "unsupported", ...base, indexed: 0, waiting: 0, error: support.reason };
    }
    const download = { total_mb: Math.round(DOWNLOAD_BYTES / MB), disk_mb: Math.round(DISK_BYTES / MB) };
    if (this.downloading) {
      return {
        state: "downloading",
        ...base,
        indexed: 0,
        waiting: 0,
        download: { ...download, received_mb: Math.round(this.downloading.received / MB) },
      };
    }
    if (!this.ready) {
      return {
        state: this.failure ? "error" : "not_set_up",
        ...base,
        indexed: 0,
        waiting: 0,
        download,
        declined: getMeta(this.db, "semantic_declined_at") ? true : undefined,
        error: this.failure,
      };
    }
    const docs = embeddingDocuments(this.db, this.model);
    const stale = this.staleAmong(docs).length;
    return {
      state: this.failure ? "error" : "ready",
      ...base,
      indexed: docs.length - stale,
      waiting: stale,
      indexing_now: this.refreshing !== undefined || undefined,
      error: this.failure,
    };
  }

  /**
   * Starts the one-time download in the background (if needed) and returns at
   * once. With `declined`, records that the user said no instead.
   */
  setup(options: { declined?: boolean } = {}): SemanticStatus {
    if (options.declined) {
      this.db
        .prepare(
          "INSERT INTO meta (key, value) VALUES ('semantic_declined_at', ?) " +
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .run(now());
      return this.status();
    }
    this.db.prepare("DELETE FROM meta WHERE key = 'semantic_declined_at'").run();
    if (!this.ready && !this.downloading && platformSupport().supported) {
      this.failure = undefined;
      this.downloading = { file: "", received: 0, total: DOWNLOAD_BYTES };
      installSemantic(this.config, (p) => {
        this.downloading = p;
      })
        .then(() => {
          this.downloading = undefined;
          this.schedule();
        })
        .catch((err: unknown) => {
          this.downloading = undefined;
          this.failure = `Setup failed: ${err instanceof Error ? err.message : String(err)}`;
        });
    } else if (this.ready) {
      this.schedule();
    }
    return this.status();
  }

  /** Downloads in the foreground (for the CLI). */
  async install(onProgress?: (p: InstallProgress) => void): Promise<void> {
    const support = platformSupport();
    if (!support.supported) throw new Error(support.reason);
    await installSemantic(this.config, onProgress);
  }

  /** Queues a background refresh when something may have changed (server mode only). */
  schedule(): void {
    if (!this.autoRefresh || !this.ready || this.closed) return;
    if (searchGeneration(this.db) === this.seenGeneration && !this.rerun) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.refresh().catch(() => {}); // recorded in this.failure, shown by status()
    }, DEBOUNCE_MS);
    this.timer.unref();
  }

  /** Embeds every new or changed screenshot. Concurrent calls share one run. */
  refresh(onProgress?: (done: number, total: number) => void): Promise<RefreshResult> {
    if (this.refreshing) {
      this.rerun = true;
      return this.refreshing;
    }
    const run = (async (): Promise<RefreshResult> => {
      let embedded = 0;
      try {
        do {
          this.rerun = false;
          const generation = searchGeneration(this.db);
          const stale = this.staleAmong(embeddingDocuments(this.db, this.model));
          for (let i = 0; i < stale.length && !this.closed; i += BATCH) {
            const batch = stale.slice(i, i + BATCH);
            this.save(batch, await this.getEmbedder().embedDocuments(batch));
            embedded += batch.length;
            onProgress?.(embedded, stale.length);
          }
          this.seenGeneration = generation;
        } while (this.rerun && !this.closed);
        this.failure = undefined;
      } catch (err) {
        this.failure = `Indexing failed: ${err instanceof Error ? err.message : String(err)}`;
        throw err;
      } finally {
        this.refreshing = undefined;
      }
      return { embedded, remaining: this.staleAmong(embeddingDocuments(this.db, this.model)).length };
    })();
    this.refreshing = run;
    return run;
  }

  /** Throws away every vector and re-embeds (in the background in server mode). */
  async rebuild(): Promise<void> {
    transaction(this.db, () => {
      this.db.exec("DELETE FROM embeddings");
      this.bumpGeneration();
    });
    this.seenGeneration = -1;
    if (this.autoRefresh) this.schedule();
  }

  /** The query's meaning vector, or undefined when semantic search can't run. */
  async queryVector(text: string): Promise<Float32Array | undefined> {
    if (!this.ready || this.closed) return undefined;
    try {
      const [vector] = await this.getEmbedder().embedQueries([text]);
      return vector;
    } catch (err) {
      this.failure = `The embedding model failed: ${err instanceof Error ? err.message : String(err)}`;
      return undefined;
    }
  }

  /** Why queryVector returned nothing, in words for the user. */
  unavailableReason(): string | undefined {
    const status = this.status();
    if (status.state === "ready") return undefined;
    if (status.state === "not_set_up") {
      return "Semantic search isn't set up, so this used keyword search only. Offer setup_semantic_search.";
    }
    if (status.state === "downloading") return "Semantic search is still downloading; this used keyword search only.";
    return status.error ?? "Semantic search is unavailable; this used keyword search only.";
  }

  /** Every stored vector for the current model, by screenshot id (cached until vectors change). */
  vectors(): Map<string, Float32Array> {
    const key = `${this.model}:${this.generation()}`;
    if (this.cache?.key === key) return this.cache.vectors;
    const rows = this.db
      .prepare("SELECT screenshot_id, vector FROM embeddings WHERE model = ?")
      .all(this.model) as Array<{ screenshot_id: string; vector: Uint8Array }>;
    const vectors = new Map(rows.map((r) => [r.screenshot_id, toVector(r.vector)]));
    this.cache = { key, vectors };
    return vectors;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.embedder?.close();
  }

  private getEmbedder(): Embedder {
    return (this.embedder ??= new ProcessEmbedder(this.config));
  }

  private staleAmong(docs: EmbeddingDocument[]): EmbeddingDocument[] {
    const current = new Map(
      (this.db.prepare("SELECT screenshot_id, text_hash FROM embeddings").all() as Array<{
        screenshot_id: string;
        text_hash: string;
      }>).map((r) => [r.screenshot_id, r.text_hash]),
    );
    return docs.filter((doc) => current.get(doc.id) !== doc.hash);
  }

  private save(docs: EmbeddingDocument[], vectors: Float32Array[]): void {
    // A screenshot can vanish mid-run (a moved file is merged into its old record).
    const upsert = this.db.prepare(`
      INSERT INTO embeddings (screenshot_id, model, text_hash, vector, embedded_at)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM screenshots WHERE id = ?)
      ON CONFLICT (screenshot_id) DO UPDATE SET
        model = excluded.model, text_hash = excluded.text_hash, vector = excluded.vector,
        embedded_at = excluded.embedded_at
    `);
    const stamp = now();
    transaction(this.db, () => {
      docs.forEach((doc, i) => upsert.run(doc.id, this.model, doc.hash, toBlob(vectors[i]!), stamp, doc.id));
      this.bumpGeneration();
    });
  }

  private generation(): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'embeddings_generation'").get() as
      | { value: string }
      | undefined;
    return row?.value ?? "0";
  }

  private bumpGeneration(): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('embeddings_generation', '1') " +
          "ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1",
      )
      .run();
  }
}
