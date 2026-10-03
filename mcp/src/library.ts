import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { type Config, dbPath, defaultConfig, expandHome, helperCandidates, resolveHelper } from "./config.ts";
import { type Db, getMeta, openDb, schemaVersion } from "./db.ts";
import { type ExtractSummary, absoluteThumbPath, extractPending, pendingCount } from "./extract.ts";
import { helperVersion } from "./helper.ts";
import {
  type ReconcileResult,
  type Source,
  discoverFolder,
  ensureFolderSource,
  listSources,
  reconcileFolder,
} from "./scanner.ts";

const execFileAsync = promisify(execFile);

export const STATUSES = ["pending", "extracted", "analyzed", "error"] as const;
export type Status = (typeof STATUSES)[number];

export interface ScanOptions {
  folder?: string;
  extractLimit?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface ScanSummary {
  sources: Array<{ location: string; unavailable?: true } & ReconcileResult>;
  extraction: ExtractSummary | { skipped: string };
  remaining_pending: number;
  next?: string;
}

export interface ListOptions {
  status?: Status;
  limit?: number;
  offset?: number;
  order?: "newest" | "oldest";
  includeMissing?: boolean;
}

export interface ScreenshotSummary {
  id: string;
  captured_at: string | null;
  status: Status;
  file: string;
  width: number | null;
  height: number | null;
  missing: boolean;
  ocr_snippet: string | null;
}

export interface ScreenshotDetail {
  id: string;
  source: { id: string; kind: string; location: string };
  source_key: string;
  file_path: string | null;
  photo_asset_id: string | null;
  captured_at: string | null;
  captured_at_source: string | null;
  source_device: string | null;
  width: number | null;
  height: number | null;
  format: string | null;
  file_size: number | null;
  content_hash: string | null;
  status: Status;
  error: string | null;
  ignored: boolean;
  missing_since: string | null;
  discovered_at: string;
  indexed_at: string | null;
  ocr: { text: string; confidence: number | null; truncated: boolean } | null;
  labels: Array<{ label: string; confidence: number }>;
  metadata: Record<string, string>;
  thumb_path: string | null;
}

export class Library {
  readonly config: Config;
  readonly db: Db;

  constructor(config: Config, db: Db) {
    this.config = config;
    this.db = db;
  }

  static open(config: Config = defaultConfig()): Library {
    return new Library(config, openDb(dbPath(config)));
  }

  close(): void {
    this.db.close();
  }

  helperPath(): string | undefined {
    return resolveHelper(this.config);
  }

  async status() {
    const helper = this.helperPath();
    let helperInfo: Record<string, unknown>;
    if (helper) {
      try {
        const v = await helperVersion(helper);
        helperInfo = { available: true, path: helper, version: v.version, ocr_revision: v.ocrRevision };
      } catch (err) {
        helperInfo = { available: false, path: helper, error: String(err) };
      }
    } else {
      helperInfo = {
        available: false,
        looked_in: helperCandidates(this.config),
        fix: `Build it: swift build -c release --package-path "${join(this.config.pluginRoot, "native")}"`,
      };
    }

    const counts = this.db
      .prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(status = 'pending'   AND missing_since IS NULL AND ignored = 0) AS pending,
          SUM(status = 'extracted' AND missing_since IS NULL AND ignored = 0) AS extracted,
          SUM(status = 'analyzed'  AND missing_since IS NULL AND ignored = 0) AS analyzed,
          SUM(status = 'error'     AND missing_since IS NULL AND ignored = 0) AS error,
          SUM(missing_since IS NOT NULL) AS missing,
          SUM(ignored = 1) AS ignored
        FROM screenshots
      `)
      .get() as Record<string, number | null>;
    const perSource = new Map(
      (this.db
        .prepare("SELECT source_id, COUNT(*) AS n FROM screenshots WHERE missing_since IS NULL GROUP BY source_id")
        .all() as Array<{ source_id: string; n: number }>).map((r) => [r.source_id, r.n]),
    );
    const sources = listSources(this.db).map((s) => ({
      id: s.id,
      kind: s.kind,
      location: s.location,
      last_scan_at: s.last_scan_at,
      screenshots: perSource.get(s.id) ?? 0,
    }));

    return {
      library: {
        home: this.config.home,
        id: getMeta(this.db, "library_id"),
        schema_version: schemaVersion(this.db),
      },
      helper: helperInfo,
      sources,
      counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v ?? 0])),
      suggested_folders: sources.length === 0 ? await this.suggestedFolders() : undefined,
    };
  }

  /** Scans registered folders (or registers `folder` first), then extracts up to extractLimit pending items. */
  async scan(options: ScanOptions = {}): Promise<ScanSummary> {
    let targets: Source[];
    if (options.folder) {
      const folder = resolve(expandHome(options.folder));
      if (!existsSync(folder) || !statSync(folder).isDirectory()) {
        throw new Error(`Not a folder: ${folder}`);
      }
      targets = [ensureFolderSource(this.db, folder)];
    } else {
      targets = listSources(this.db).filter((s) => s.kind === "folder");
      if (targets.length === 0) {
        const suggestions = await this.suggestedFolders();
        throw new Error(
          "No screenshot folders registered yet. Call again with `folder`" +
            (suggestions.length ? `, e.g. ${suggestions.join(" or ")}` : "") + ".",
        );
      }
    }

    const sources: ScanSummary["sources"] = [];
    for (const source of targets) {
      // An unplugged drive or renamed folder shouldn't mark its whole library missing.
      if (!existsSync(source.location)) {
        sources.push({
          location: source.location,
          unavailable: true,
          discovered: 0, added: 0, changed: 0, returned: 0, missing: 0,
        });
        continue;
      }
      const files = await discoverFolder(source.location);
      sources.push({ location: source.location, ...reconcileFolder(this.db, source, files) });
    }

    const limit = options.extractLimit ?? 250;
    let extraction: ScanSummary["extraction"];
    const helper = this.helperPath();
    if (limit <= 0) {
      extraction = { skipped: "extract_limit is 0" };
    } else if (!helper) {
      extraction = { skipped: "shot-helper is not built; see get_status for the fix" };
    } else {
      extraction = await extractPending(this.db, this.config, helper, {
        limit,
        onProgress: options.onProgress,
      });
    }

    const remaining = pendingCount(this.db);
    return {
      sources,
      extraction,
      remaining_pending: remaining,
      next: remaining > 0 ? `${remaining} screenshots still need local extraction; scan again to continue.` : undefined,
    };
  }

  list(options: ListOptions = {}): ScreenshotSummary[] {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 200);
    const order = options.order === "oldest" ? "ASC" : "DESC";
    const rows = this.db
      .prepare(`
        SELECT s.id, s.captured_at, s.status, s.source_key, s.width, s.height, s.missing_since,
               substr(e.ocr_text, 1, 140) AS ocr_snippet
        FROM screenshots s LEFT JOIN extractions e ON e.screenshot_id = s.id
        WHERE (:status IS NULL OR s.status = :status)
          AND s.ignored = 0
          AND (:includeMissing = 1 OR s.missing_since IS NULL)
        ORDER BY s.captured_at ${order}, s.id
        LIMIT :limit OFFSET :offset
      `)
      .all({
        status: options.status ?? null,
        includeMissing: options.includeMissing ? 1 : 0,
        limit,
        offset: Math.max(options.offset ?? 0, 0),
      }) as Array<Record<string, string | number | null>>;
    return rows.map((r) => ({
      id: r.id as string,
      captured_at: r.captured_at as string | null,
      status: r.status as Status,
      file: r.source_key as string,
      width: r.width as number | null,
      height: r.height as number | null,
      missing: r.missing_since !== null,
      ocr_snippet: r.ocr_snippet ? String(r.ocr_snippet).replace(/\s+/g, " ").trim() || null : null,
    }));
  }

  get(id: string, options: { ocrMaxChars?: number } = {}): ScreenshotDetail | undefined {
    const row = this.db
      .prepare(`
        SELECT s.*, src.kind AS src_kind, src.location AS src_location,
               e.ocr_text, e.ocr_confidence, e.labels, e.metadata, e.thumb_path, e.screenshot_id AS has_extraction
        FROM screenshots s
        JOIN sources src ON src.id = s.source_id
        LEFT JOIN extractions e ON e.screenshot_id = s.id
        WHERE s.id = ?
      `)
      .get(id) as Record<string, any> | undefined;
    if (!row) return undefined;
    const maxChars = options.ocrMaxChars ?? 4000;
    const ocrText: string = row.ocr_text ?? "";
    return {
      id: row.id,
      source: { id: row.source_id, kind: row.src_kind, location: row.src_location },
      source_key: row.source_key,
      file_path: row.file_path,
      photo_asset_id: row.photo_asset_id,
      captured_at: row.captured_at,
      captured_at_source: row.captured_at_source,
      source_device: row.source_device,
      width: row.width,
      height: row.height,
      format: row.format,
      file_size: row.file_size,
      content_hash: row.content_hash,
      status: row.status,
      error: row.error,
      ignored: row.ignored === 1,
      missing_since: row.missing_since,
      discovered_at: row.discovered_at,
      indexed_at: row.indexed_at,
      ocr: row.has_extraction
        ? { text: ocrText.slice(0, maxChars), confidence: row.ocr_confidence, truncated: ocrText.length > maxChars }
        : null,
      labels: row.labels ? JSON.parse(row.labels) : [],
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      thumb_path: absoluteThumbPath(this.config, row.thumb_path),
    };
  }

  /** Folders worth offering on first run: the macOS screenshot location and ~/Memvana/Screenshots. */
  async suggestedFolders(): Promise<string[]> {
    const candidates: string[] = [];
    try {
      const { stdout } = await execFileAsync("defaults", ["read", "com.apple.screencapture", "location"], {
        timeout: 3000,
      });
      if (stdout.trim()) candidates.push(expandHome(stdout.trim()));
    } catch {
      candidates.push(join(homedir(), "Desktop")); // macOS default when unset
    }
    candidates.push(join(homedir(), "Memvana", "Screenshots"));
    const registered = new Set(listSources(this.db).map((s) => s.location));
    return [...new Set(candidates)].filter((p) => existsSync(p) && !registered.has(p));
  }
}
