import { execFile } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  type AnalysisInput,
  type BatchItem,
  type SaveResult,
  claimBatch,
  pendingAnalysisCount,
  saveAnalyses,
} from "./analysis.ts";
import {
  type Config,
  appCandidates,
  dbPath,
  defaultConfig,
  expandHome,
  helperCandidates,
  resolveApp,
  resolveHelper,
} from "./config.ts";
import { type Db, getMeta, openDb, schemaVersion, transaction } from "./db.ts";
import { type ExtractSummary, absoluteThumbPath, extractPending, pendingCount } from "./extract.ts";
import { type EditInput, type UserEdits, editScreenshot, userEdits } from "./edits.ts";
import { helperVersion, readFinderTags } from "./helper.ts";
import { NAME_SQL } from "./names.ts";
import { AppBridge, type PhotosAuthorization, type PhotosBridge, PhotosAccessError, hasAccess } from "./photos.ts";
import { type RelatedResult, relatedScreenshots } from "./related.ts";
import { type SearchOptions, type SearchResult, type StatsOptions, libraryStats, searchScreenshots } from "./search.ts";
import { rebuildSearchIndex } from "./search-index.ts";
import type { Embedder } from "./semantic/embedder.ts";
import { type SemanticStatus, SemanticIndex } from "./semantic/semantic-index.ts";
import {
  type ScreenshotTag,
  type Suggestion,
  type TagEdit,
  type TagOrigin,
  createTags,
  editTag,
  listTags,
  suggestTags,
  syncFinderTags,
  tagScreenshots,
  taggingBatch,
  tagsFor,
  vocabulary,
} from "./tags.ts";
import {
  type ReconcileResult,
  type Source,
  discoverFolder,
  ensureFolderSource,
  ensurePhotosSource,
  listSources,
  photosSource,
  reconcileFolder,
  reconcilePhotos,
} from "./scanner.ts";

const execFileAsync = promisify(execFile);

export const STATUSES = ["pending", "extracted", "analyzed", "error"] as const;
export type Status = (typeof STATUSES)[number];

export interface ScanOptions {
  folder?: string;
  /** Scan only the Photos library (once connected). */
  photos?: boolean;
  extractLimit?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface ScanSummary {
  sources: Array<{ kind: Source["kind"]; location: string; unavailable?: true; reason?: string } & ReconcileResult>;
  extraction: ExtractSummary | { skipped: string };
  /** Tags picked up from (or removed in) Finder. */
  finder_tags?: { added: number; removed: number };
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
  /** The file's name, or for Photos the name Photos reports (e.g. IMG_3794.PNG). */
  file_name: string;
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
  analysis: Analysis | null;
  user_edits: UserEdits | null;
  /** What search and answers use: the user's edits where present, else Claude's analysis. */
  details: EffectiveDetails | null;
  tags: ScreenshotTag[];
}

export interface EffectiveDetails {
  short_description: string | null;
  detailed_description: string | null;
  likely_reason_saved: string | null;
  notes: string | null;
  keywords: string[];
}

export interface Analysis {
  short_description: string;
  detailed_description: string;
  likely_reason_saved: string;
  content_type: string;
  source_app: string | null;
  entities: Array<{ name: string; type: string }>;
  topics: string[];
  keywords: string[];
  sensitive: boolean;
  confidence: number | null;
  model: string | null;
  analysis_version: number;
  analyzed_at: string;
  /** The image changed after this was written; it is queued for re-analysis. */
  stale: boolean;
}

/** Opens a file or URL (or reveals a file in Finder). Swappable for tests. */
export type Opener = (path: string, reveal: boolean) => Promise<void>;

export interface PhotosStatus {
  /** Memvana Shot.app, which holds the Photos permission, is installed with the plugin. */
  available: boolean;
  /** The Photos library is one of the library's sources. */
  connected: boolean;
  authorization?: PhotosAuthorization;
  /** Screenshots from Photos in the library. */
  screenshots?: number;
  /** What the user can do when Photos is unavailable or access is off. */
  fix?: string;
}

export type ConnectPhotosResult =
  | { authorization: PhotosAuthorization; connected: false; fix: string; settings_opened: boolean }
  | ({ authorization: PhotosAuthorization; connected: true } & ScanSummary);

const PHOTOS_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Photos";

/** Exported copies opened in Preview are kept this long, then cleared. */
const EXPORT_TTL_MS = 24 * 60 * 60_000;

function photosFix(authorization: PhotosAuthorization): string {
  return authorization === "restricted"
    ? "Photos access is restricted on this Mac (for example by Screen Time or a device management profile), so only an administrator can allow it."
    : "Open System Settings > Privacy & Security > Photos and turn on Memvana Shot, then ask again.";
}

const macOpen: Opener = async (path, reveal) => {
  await execFileAsync("open", reveal ? ["-R", path] : [path], { timeout: 10_000 });
};

export interface LibraryOptions {
  /** Replaces the local embedding model (tests). */
  embedder?: Embedder;
  /** Replaces the Photos bridge (tests); null means none. Default: Memvana Shot.app, if present. */
  photos?: PhotosBridge | null;
}

export class Library {
  readonly config: Config;
  readonly db: Db;
  /** Meaning vectors for semantic search and related screenshots. */
  readonly semantic: SemanticIndex;
  /** Reads screenshots from the Photos library, when Memvana Shot.app is available. */
  readonly photos: PhotosBridge | undefined;
  opener: Opener = macOpen;

  constructor(config: Config, db: Db, options: LibraryOptions = {}) {
    this.config = config;
    this.db = db;
    this.semantic = new SemanticIndex(db, config, options.embedder);
    if (options.photos !== undefined) {
      this.photos = options.photos ?? undefined;
    } else {
      const app = resolveApp(config);
      this.photos = app ? new AppBridge(app, join(config.home, "tmp")) : undefined;
    }
  }

  static open(config: Config = defaultConfig(), options: LibraryOptions = {}): Library {
    return new Library(config, openDb(dbPath(config)), options);
  }

  close(): void {
    this.semantic.close();
    this.db.close();
  }

  private taggingState(): { tags: number; untagged: number } {
    const tags = (this.db.prepare("SELECT COUNT(*) AS n FROM tags").get() as { n: number }).n;
    const untagged = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM screenshots WHERE status = 'analyzed' AND ignored = 0 AND missing_since IS NULL AND ai_tagged_at IS NULL",
        )
        .get() as { n: number }
    ).n;
    return { tags, untagged };
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
        fix:
          "Memvana Shot.app is missing from the plugin's bin folder; reinstall the plugin. " +
          `In a source checkout, build it: swift build -c release --package-path "${join(this.config.pluginRoot, "native")}"`,
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

    this.semantic.schedule();
    const semantic = this.semantic.status();
    const photos = await this.photosStatus();
    return {
      library: {
        home: this.config.home,
        id: getMeta(this.db, "library_id"),
        schema_version: schemaVersion(this.db),
      },
      helper: helperInfo,
      sources,
      counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v ?? 0])),
      photos,
      semantic_search: semantic,
      suggested_folders: sources.length === 0 ? await this.suggestedFolders() : undefined,
      next_steps: nextSteps(sources.length, counts, helperInfo.available === true, this.taggingState(), semantic, photos),
    };
  }

  /**
   * Scans every source (folders and Photos), one new `folder`, or only
   * Photos, then extracts up to extractLimit pending items, newest first.
   */
  async scan(options: ScanOptions = {}): Promise<ScanSummary> {
    let targets: Source[];
    if (options.folder) {
      const folder = resolve(expandHome(options.folder));
      if (!existsSync(folder) || !statSync(folder).isDirectory()) {
        throw new Error(`Not a folder: ${folder}`);
      }
      targets = [ensureFolderSource(this.db, folder)];
    } else if (options.photos) {
      const source = photosSource(this.db);
      if (!source) throw new Error("The Photos library isn't connected yet. Use connect_photos (after the user agrees).");
      targets = [source];
    } else {
      targets = listSources(this.db);
      if (targets.length === 0) {
        const suggestions = await this.suggestedFolders();
        throw new Error(
          "No screenshot sources yet. Connect Photos with connect_photos, or call again with `folder`" +
            (suggestions.length ? `, e.g. ${suggestions.join(" or ")}` : "") + ".",
        );
      }
    }

    const sources: ScanSummary["sources"] = [];
    for (const source of targets) {
      if (source.kind === "photos") {
        sources.push(await this.scanPhotos(source));
        continue;
      }
      // An unplugged drive or renamed folder shouldn't mark its whole library missing.
      if (!existsSync(source.location)) {
        sources.push({
          kind: "folder",
          location: source.location,
          unavailable: true,
          reason: "folder not found",
          ...NOTHING_FOUND,
        });
        continue;
      }
      const files = await discoverFolder(source.location);
      sources.push({ kind: "folder", location: source.location, ...reconcileFolder(this.db, source, files) });
    }

    const limit = options.extractLimit ?? 250;
    let extraction: ScanSummary["extraction"];
    const helper = this.helperPath();
    if (limit <= 0) {
      extraction = { skipped: "extract_limit is 0" };
    } else if (!helper) {
      extraction = { skipped: "shot-helper is not built; see get_status for the fix" };
    } else {
      // When this scan found Photos unavailable, leave its screenshots out, so
      // ones that can't be read don't take the places of folder screenshots.
      const photosOff = sources.some((s) => s.kind === "photos" && s.unavailable);
      extraction = await extractPending(this.db, this.config, { helper, photos: photosOff ? undefined : this.photos }, {
        limit,
        onProgress: options.onProgress,
      });
    }

    let finderTags: ScanSummary["finder_tags"];
    if (helper) finderTags = await this.syncFinderTags(targets.filter((t) => existsSync(t.location)));

    this.semantic.schedule();
    const remaining = pendingCount(this.db);
    return {
      sources,
      extraction,
      finder_tags: finderTags,
      remaining_pending: remaining,
      next: remaining > 0 ? `${remaining} screenshots still need local extraction; scan again to continue.` : undefined,
    };
  }

  /** Brings the library in line with the Photos Screenshots album. Access being off isn't an error here. */
  private async scanPhotos(source: Source): Promise<ScanSummary["sources"][number]> {
    const unavailable = (reason: string) => ({
      kind: "photos" as const,
      location: source.location,
      unavailable: true as const,
      reason,
      ...NOTHING_FOUND,
    });
    if (!this.photos) return unavailable("Memvana Shot.app is missing; reinstall the plugin");
    try {
      const assets = await this.photos.list();
      return { kind: "photos", location: source.location, ...reconcilePhotos(this.db, source, assets) };
    } catch (err) {
      if (!(err instanceof PhotosAccessError)) throw err;
      return unavailable(`Photos access is off (${err.authorization}). ${photosFix(err.authorization)}`);
    }
  }

  /** Whether the Photos library can be connected, and whether it is. */
  async photosStatus(): Promise<PhotosStatus> {
    const source = photosSource(this.db);
    const connected = source !== undefined;
    const screenshots = connected
      ? (this.db
          .prepare("SELECT COUNT(*) AS n FROM screenshots WHERE source_id = ? AND missing_since IS NULL")
          .get(source.id) as { n: number }).n
      : undefined;
    if (!this.photos) {
      return {
        available: false,
        connected,
        screenshots,
        fix: `Memvana Shot.app is missing (looked in ${appCandidates(this.config).join(", ")}); reinstall the plugin.`,
      };
    }
    let authorization: PhotosAuthorization;
    try {
      authorization = await this.photos.status();
    } catch (err) {
      return { available: false, connected, screenshots, fix: `Memvana Shot.app didn't respond: ${(err as Error).message}` };
    }
    return {
      available: true,
      connected,
      authorization,
      screenshots,
      fix: connected && !hasAccess(authorization) ? photosFix(authorization) : undefined,
    };
  }

  /**
   * Asks for Photos access (macOS shows its prompt the first time), then adds
   * the Photos library as a source and scans it. Without access, optionally
   * opens the Photos pane of System Settings.
   */
  async connectPhotos(options: Omit<ScanOptions, "folder" | "photos"> & { openSettings?: boolean } = {}): Promise<ConnectPhotosResult> {
    if (!this.photos) {
      throw new Error(`Memvana Shot.app is missing (looked in ${appCandidates(this.config).join(", ")}); reinstall the plugin.`);
    }
    const authorization = await this.photos.authorize();
    if (!hasAccess(authorization)) {
      if (options.openSettings) await this.opener(PHOTOS_SETTINGS_URL, false);
      return { authorization, connected: false, fix: photosFix(authorization), settings_opened: Boolean(options.openSettings) };
    }
    ensurePhotosSource(this.db);
    const { extractLimit, onProgress } = options;
    return { authorization, connected: true, ...(await this.scan({ photos: true, extractLimit, onProgress })) };
  }

  list(options: ListOptions = {}): ScreenshotSummary[] {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 200);
    const order = options.order === "oldest" ? "ASC" : "DESC";
    const rows = this.db
      .prepare(`
        SELECT s.id, s.captured_at, s.status, ${NAME_SQL} AS name, s.width, s.height, s.missing_since,
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
      file: r.name as string,
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
               e.ocr_text, e.ocr_confidence, e.labels, e.metadata, e.thumb_path, e.screenshot_id AS has_extraction,
               a.screenshot_id AS has_analysis, a.short_description, a.detailed_description, a.likely_reason_saved,
               a.content_type, a.source_app, a.entities, a.topics, a.keywords, a.sensitive, a.confidence, a.model,
               a.analysis_version, a.analyzed_at, a.content_hash AS analysis_hash
        FROM screenshots s
        JOIN sources src ON src.id = s.source_id
        LEFT JOIN extractions e ON e.screenshot_id = s.id
        LEFT JOIN analyses a ON a.screenshot_id = s.id
        WHERE s.id = ?
      `)
      .get(id) as Record<string, any> | undefined;
    if (!row) return undefined;
    const maxChars = options.ocrMaxChars ?? 4000;
    const ocrText: string = row.ocr_text ?? "";
    const detail: ScreenshotDetail = {
      id: row.id,
      source: { id: row.source_id, kind: row.src_kind, location: row.src_location },
      source_key: row.source_key,
      file_name: row.file_name ?? basename(row.source_key),
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
      analysis: row.has_analysis
        ? {
            short_description: row.short_description,
            detailed_description: row.detailed_description,
            likely_reason_saved: row.likely_reason_saved,
            content_type: row.content_type,
            source_app: row.source_app,
            entities: JSON.parse(row.entities),
            topics: JSON.parse(row.topics),
            keywords: JSON.parse(row.keywords),
            sensitive: row.sensitive === 1,
            confidence: row.confidence,
            model: row.model,
            analysis_version: row.analysis_version,
            analyzed_at: row.analyzed_at,
            stale: row.analysis_hash !== row.content_hash,
          }
        : null,
      user_edits: userEdits(this.db, id),
      details: null,
      tags: tagsFor(this.db, id),
    };
    detail.details = effectiveDetails(detail.analysis, detail.user_edits);
    return detail;
  }

  /** Leases the next screenshots needing analysis (or specific ids), with absolute thumbnail paths. */
  analysisBatch(options: { limit?: number; ids?: string[] } = {}): { items: BatchItem[]; remaining: number } {
    const items = claimBatch(this.db, { limit: Math.min(Math.max(options.limit ?? 6, 1), 12), ids: options.ids });
    for (const item of items) item.thumb_path = absoluteThumbPath(this.config, item.thumb_path);
    const remaining = pendingAnalysisCount(this.db) - items.filter((i) => !options.ids?.includes(i.id)).length;
    return { items, remaining: Math.max(remaining, 0) };
  }

  saveAnalyses(analyses: AnalysisInput[], model?: string): SaveResult & { remaining: number } {
    const saved = this.changed(saveAnalyses(this.db, analyses, model));
    return { ...saved, remaining: pendingAnalysisCount(this.db) };
  }

  tagVocabulary() {
    return vocabulary(this.db);
  }

  listTags() {
    return listTags(this.db);
  }

  createTags(tags: Array<{ name: string; description?: string }>, origin: TagOrigin = "user") {
    return createTags(this.db, tags, origin);
  }

  editTag(name: string, edit: TagEdit) {
    return this.changed(editTag(this.db, name, edit));
  }

  tagScreenshots(ids: string[], change: { add?: string[]; remove?: string[] }) {
    return this.changed(tagScreenshots(this.db, ids, change));
  }

  suggestTags(suggestions: Suggestion[]) {
    return this.changed(suggestTags(this.db, suggestions));
  }

  taggingBatch(limit = 40) {
    return taggingBatch(this.db, Math.min(Math.max(limit, 1), 100));
  }

  edit(id: string, input: EditInput) {
    this.changed(editScreenshot(this.db, id, input));
    return this.get(id, { ocrMaxChars: 0 });
  }

  /** Lets the semantic index catch up after a change to screenshots' details. */
  private changed<T>(result: T): T {
    this.semantic.schedule();
    return result;
  }

  /** Imports Finder tags for every present file in the given folder sources. */
  private async syncFinderTags(sources: Source[]): Promise<{ added: number; removed: number } | undefined> {
    const helper = this.helperPath();
    const folderIds = sources.filter((s) => s.kind === "folder").map((s) => s.id);
    if (!helper || folderIds.length === 0) return undefined;
    const jobs = this.db
      .prepare(`
        SELECT id, file_path AS path FROM screenshots
        WHERE missing_since IS NULL AND file_path IS NOT NULL
          AND source_id IN (${folderIds.map(() => "?").join(", ")})
      `)
      .all(...folderIds) as Array<{ id: string; path: string }>;
    const tags = await readFinderTags(helper, jobs.map((j) => ({ ...j })));
    return syncFinderTags(this.db, tags);
  }

  search(options: SearchOptions): Promise<SearchResult> {
    this.semantic.schedule(); // picks up changes made elsewhere (e.g. the CLI)
    return searchScreenshots(this.db, options, this.semantic);
  }

  /** Screenshots related to one screenshot, by meaning, looks, tags, names, topics and time. */
  related(id: string, options: { limit?: number } = {}): RelatedResult {
    if (!this.db.prepare("SELECT 1 FROM screenshots WHERE id = ?").get(id)) {
      throw new Error(`No screenshot with id ${id}`);
    }
    return relatedScreenshots(this.db, id, this.semantic.ready ? this.semantic.vectors() : undefined, options);
  }

  /** Starts the one-time semantic-search download (in the background) if needed, or records a no. */
  setupSemantic(options: { declined?: boolean } = {}): SemanticStatus {
    return this.semantic.setup(options);
  }

  /**
   * Rebuilds the keyword index from stored data, and with `semantic` also
   * discards every meaning vector so they are made again.
   */
  async rebuildIndex(options: { semantic?: boolean } = {}) {
    const rows = transaction(this.db, () => rebuildSearchIndex(this.db));
    if (options.semantic) await this.semantic.rebuild();
    else this.semantic.schedule();
    return { keyword_index: { screenshots: rows }, semantic_search: this.semantic.status() };
  }

  stats(options: StatsOptions = {}) {
    return libraryStats(this.db, options);
  }

  /**
   * Opens the original file in its default app (Preview), or reveals it in
   * Finder. A screenshot from Photos opens as an exported copy.
   */
  async open(id: string, reveal = false): Promise<{ opened: string; reveal: boolean; note?: string }> {
    const detail = this.get(id, { ocrMaxChars: 0 });
    if (!detail) throw new Error(`No screenshot with id ${id}`);
    if (detail.photo_asset_id) return this.openFromPhotos(id, detail.photo_asset_id, detail.missing_since, reveal);
    if (!detail.file_path || detail.missing_since || !existsSync(detail.file_path)) {
      throw new Error(`The original file for ${id} is missing (last seen at ${detail.file_path ?? "unknown"}).`);
    }
    await this.opener(detail.file_path, reveal);
    return { opened: detail.file_path, reveal };
  }

  private async openFromPhotos(id: string, asset: string, missingSince: string | null, reveal: boolean) {
    if (!this.photos) throw new Error("Memvana Shot.app is missing, so screenshots from Photos can't be opened.");
    if (missingSince) throw new Error(`${id} is no longer in the Photos Screenshots album (deleted or hidden).`);
    const dir = join(this.config.home, "tmp", "open");
    clearOldExports(dir);
    const path = (await this.photos.exportImages([{ id, asset }], dir)).get(id);
    if (!path) throw new Error(`Photos couldn't provide the image for ${id}.`);
    await this.opener(path, false);
    return {
      opened: path,
      reveal: false,
      note: reveal
        ? "Screenshots in Photos have no file to show in Finder, so a copy opened in Preview instead."
        : "Opened a copy exported from Photos.",
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

/** Removes exported copies older than EXPORT_TTL_MS. */
function clearOldExports(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (Date.now() - statSync(path).mtimeMs > EXPORT_TTL_MS) rmSync(path, { recursive: true, force: true });
  }
}

const NOTHING_FOUND: ReconcileResult = { discovered: 0, added: 0, changed: 0, returned: 0, missing: 0 };

function nextSteps(
  sourceCount: number,
  counts: Record<string, number | null>,
  helperReady: boolean,
  tagging: { tags: number; untagged: number },
  semantic: SemanticStatus,
  photos: PhotosStatus,
): string[] {
  const steps: string[] = [];
  if (!helperReady) steps.push("The native helper is missing (see helper.fix), so screenshots can't be extracted.");
  if (sourceCount === 0) {
    if (photos.available) {
      steps.push(
        "Offer to connect the Photos library (connect_photos, after the user agrees; macOS asks for permission " +
          "once), which includes iPhone screenshots synced with iCloud Photos.",
      );
    }
    steps.push("Or register a screenshot folder with scan_screenshots({ folder }). See suggested_folders.");
    return steps;
  }
  if (photos.connected && photos.fix) steps.push(`Photos is connected but unavailable: ${photos.fix}`);
  if (counts.pending) steps.push(`${counts.pending} screenshots await local extraction: call scan_screenshots.`);
  if (counts.extracted) {
    steps.push(`${counts.extracted} screenshots await analysis: get_analysis_batch, then save_analyses.`);
  }
  if (counts.analyzed && tagging.tags === 0) {
    steps.push("No tags yet. Propose 6-12 starter tags from get_library_stats and create them once the user agrees.");
  } else if (tagging.tags > 0 && tagging.untagged > 0) {
    steps.push(`${tagging.untagged} analyzed screenshots haven't been considered for tags: get_tagging_batch, then suggest_tags.`);
  }
  if (counts.analyzed && semantic.state === "not_set_up" && !semantic.declined) {
    steps.push(
      `Semantic search (search by meaning, related screenshots) isn't set up. Offer it once: a one-time ` +
        `${semantic.download?.total_mb} MB download of ${semantic.model} (${semantic.license}). ` +
        "Call setup_semantic_search only after the user agrees.",
    );
  } else if (semantic.state === "downloading") {
    steps.push(`Semantic search is downloading (${semantic.download?.received_mb} of ${semantic.download?.total_mb} MB).`);
  } else if (semantic.state === "ready" && semantic.waiting > 0) {
    steps.push(`${semantic.waiting} screenshots are waiting for semantic indexing; it runs in the background.`);
  } else if (semantic.state === "error") {
    steps.push(`Semantic search has a problem: ${semantic.error}`);
  }
  if (!steps.length) steps.push("Library is up to date. Search with search_screenshots.");
  return steps;
}

function effectiveDetails(analysis: Analysis | null, edits: UserEdits | null): EffectiveDetails | null {
  if (!analysis && !edits) return null;
  const removed = new Set(edits?.keywords_removed ?? []);
  return {
    short_description: edits?.short_description ?? analysis?.short_description ?? null,
    detailed_description: edits?.detailed_description ?? analysis?.detailed_description ?? null,
    likely_reason_saved: edits?.likely_reason_saved ?? analysis?.likely_reason_saved ?? null,
    notes: edits?.notes ?? null,
    keywords: [...(analysis?.keywords ?? []).filter((k) => !removed.has(k)), ...(edits?.keywords_added ?? [])],
  };
}
