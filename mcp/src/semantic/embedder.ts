import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Config } from "../config.ts";
import { MODEL, documentPrompt, modelDir, queryPrompt, runtimeDir } from "./model.ts";
import { toVector } from "./vectors.ts";

/** Turns text into unit-length meaning vectors. Swappable for tests. */
export interface Embedder {
  /** Recorded with every vector, so a model change re-embeds everything. */
  readonly model: string;
  embedQueries(queries: string[]): Promise<Float32Array[]>;
  embedDocuments(docs: Array<{ title: string | null; text: string }>): Promise<Float32Array[]>;
  close(): void;
}

export interface ProcessEmbedderOptions {
  /** Stop the model process after this long without requests (default 3 minutes). */
  idleMs?: number;
  threads?: number;
  /** The embedder script (default: the bundled mcp/dist/embedder.mjs). */
  entry?: string;
}

interface Pending {
  resolve: (vectors: Float32Array[]) => void;
  reject: (err: Error) => void;
}

/** Runs the model in a child process (see bin/embedder.ts) that starts on demand and exits when idle. */
export class ProcessEmbedder implements Embedder {
  readonly model = MODEL.id;
  private child?: ChildProcess;
  private starting?: Promise<ChildProcess>;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private idleTimer?: NodeJS.Timeout;
  private readonly config: Config;
  private readonly options: ProcessEmbedderOptions;

  constructor(config: Config, options: ProcessEmbedderOptions = {}) {
    this.config = config;
    this.options = options;
  }

  embedQueries(queries: string[]): Promise<Float32Array[]> {
    return this.run(queries.map(queryPrompt));
  }

  embedDocuments(docs: Array<{ title: string | null; text: string }>): Promise<Float32Array[]> {
    return this.run(docs.map((d) => documentPrompt(d.title, d.text)));
  }

  close(): void {
    clearTimeout(this.idleTimer);
    this.child?.kill();
    this.child = undefined;
    this.starting = undefined;
  }

  private async run(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const child = await this.start();
    clearTimeout(this.idleTimer);
    const id = this.nextId++;
    const result = new Promise<Float32Array[]>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    child.stdin!.write(JSON.stringify({ id, texts }) + "\n");
    try {
      return await result;
    } finally {
      this.idleTimer = setTimeout(() => this.close(), this.options.idleMs ?? 180_000);
      this.idleTimer.unref();
    }
  }

  private start(): Promise<ChildProcess> {
    if (this.child) return Promise.resolve(this.child);
    if (this.starting) return this.starting;
    const entry = this.options.entry ?? join(this.config.pluginRoot, "mcp", "dist", "embedder.mjs");
    const starting = new Promise<ChildProcess>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          entry,
          "--model-dir", modelDir(this.config),
          "--runtime-dir", runtimeDir(this.config),
          "--onnx", MODEL.onnx,
          "--threads", String(this.options.threads ?? 2),
          "--max-tokens", String(MODEL.maxTokens),
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let ready = false;
      let stderr = "";
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4000);
      });
      child.stdin!.on("error", () => {}); // reported through "exit"
      createInterface({ input: child.stdout!, crlfDelay: Infinity }).on("line", (line) => {
        let msg: { ready?: boolean; id?: number; ok?: boolean; vectors?: string[]; error?: string };
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (!ready) {
          if (msg.ready) {
            ready = true;
            this.child = child;
            resolve(child);
          } else {
            reject(new Error(`The embedding model failed to load: ${msg.error ?? "unknown error"}`));
          }
          return;
        }
        const pending = msg.id === undefined ? undefined : this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id!);
        if (msg.ok && msg.vectors) pending.resolve(msg.vectors.map((b64) => toVector(Buffer.from(b64, "base64"))));
        else pending.reject(new Error(msg.error ?? "embedding failed"));
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        const err = new Error(`The embedding process stopped (${signal ?? `exit ${code}`}). ${stderr.trim()}`.trim());
        if (!ready) reject(err);
        for (const pending of this.pending.values()) pending.reject(err);
        this.pending.clear();
        if (this.child === child) this.child = undefined;
        if (this.starting === starting) this.starting = undefined;
      });
    });
    this.starting = starting;
    starting.catch(() => {
      if (this.starting === starting) this.starting = undefined;
    });
    return starting;
  }
}
