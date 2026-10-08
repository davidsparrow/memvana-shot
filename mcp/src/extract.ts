import { rmSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { type Config, thumbsDir } from "./config.ts";
import { inferCaptureDate } from "./dates.ts";
import { type Db, now, transaction } from "./db.ts";
import { type ExtractResult, type ExtractSuccess, helperVersion, runExtract } from "./helper.ts";
import { type PhotoExtractResult, type PhotosBridge, PhotosAccessError } from "./photos.ts";
import { reindexScreenshot } from "./search-index.ts";

export interface ExtractSummary {
  processed: number;
  succeeded: number;
  failed: number;
  /** Renamed/moved files matched back to their existing record by content hash. */
  relinked: number;
  elapsed_ms: number;
  errors: Array<{ id: string; file: string; error: string }>;
  /** Set when Photos screenshots were due but Photos access is off. */
  photos_unavailable?: string;
}

/** What does the extracting: shot-helper for files, plus the app's bridge for Photos. */
export interface Extractors {
  helper: string;
  photos?: PhotosBridge;
}

export interface ExtractRunOptions {
  limit: number;
  maxDim?: number;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

interface PendingRow {
  id: string;
  file_path: string | null;
  photo_asset_id: string | null;
  content_hash: string | null;
}

export function pendingCount(db: Db): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM screenshots WHERE status = 'pending' AND ignored = 0 AND missing_since IS NULL",
    )
    .get() as { n: number };
  return row.n;
}

/**
 * Runs local extraction (OCR, labels, thumbnail, feature print) on pending
 * screenshots, newest first across folders and Photos. Screenshots whose
 * extractor isn't available are left pending.
 */
export async function extractPending(
  db: Db,
  config: Config,
  extractors: Extractors,
  options: ExtractRunOptions,
): Promise<ExtractSummary> {
  const started = Date.now();
  const summary: ExtractSummary = { processed: 0, succeeded: 0, failed: 0, relinked: 0, elapsed_ms: 0, errors: [] };
  const kinds = extractors.photos ? "file_path IS NOT NULL OR photo_asset_id IS NOT NULL" : "file_path IS NOT NULL";
  const rows = db
    .prepare(`
      SELECT id, file_path, photo_asset_id, content_hash FROM screenshots
      WHERE status = 'pending' AND ignored = 0 AND missing_since IS NULL AND (${kinds})
      ORDER BY captured_at DESC
      LIMIT ?
    `)
    .all(options.limit) as unknown as PendingRow[];
  if (rows.length === 0) return summary;

  const byId = new Map(rows.map((r) => [r.id, r]));
  const version = await helperVersion(extractors.helper);
  const engine = `shot-helper/${version.version} ocr-r${version.ocrRevision} fp-r${version.featurePrintRevision}`;
  const extractOptions = { thumbDir: thumbsDir(config), maxDim: options.maxDim, concurrency: options.concurrency };

  const onResult = (result: ExtractResult | PhotoExtractResult) => {
    const row = result.id ? byId.get(result.id) : undefined;
    if (!row) return;
    summary.processed++;
    if (result.ok) {
      const relinked = persistExtraction(db, config, row, result, engine);
      summary.succeeded++;
      if (relinked) summary.relinked++;
    } else {
      db.prepare("UPDATE screenshots SET status = 'error', error = ? WHERE id = ?").run(result.error, row.id);
      summary.failed++;
      if (summary.errors.length < 5) {
        summary.errors.push({ id: row.id, file: row.file_path ? basename(row.file_path) : "Photos", error: result.error });
      }
    }
    options.onProgress?.(summary.processed, rows.length);
  };

  const files = rows.filter((r) => r.file_path !== null);
  if (files.length > 0) {
    await runExtract(extractors.helper, files.map((r) => ({ id: r.id, path: r.file_path! })), extractOptions, onResult);
  }
  const assets = rows.filter((r) => r.file_path === null && r.photo_asset_id !== null);
  if (assets.length > 0 && extractors.photos) {
    try {
      await extractors.photos.extract(
        assets.map((r) => ({ id: r.id, asset: r.photo_asset_id! })),
        extractOptions,
        onResult,
      );
    } catch (err) {
      if (!(err instanceof PhotosAccessError)) throw err;
      summary.photos_unavailable = `Photos access is off (${err.authorization}), so screenshots from Photos weren't extracted.`;
    }
  }

  summary.elapsed_ms = Date.now() - started;
  return summary;
}

/** Returns true when the image turned out to be a moved/renamed copy of a known screenshot. */
function persistExtraction(
  db: Db,
  config: Config,
  row: PendingRow,
  r: ExtractSuccess | Extract<PhotoExtractResult, { ok: true }>,
  engine: string,
): boolean {
  return transaction(db, () => {
    const fromPhotos = "asset" in r;
    if (fromPhotos) db.prepare("UPDATE screenshots SET file_name = ? WHERE id = ?").run(r.filename ?? "", row.id);
    if (row.content_hash === null && relinkMovedFile(db, config, row, r)) return true;

    // Photos records when each screenshot was taken, which beats anything in
    // the image. For files without metadata or a dated name, the scanner's
    // birthtime-based provisional date (kept by COALESCE below) is the best guess.
    const captured = fromPhotos ? undefined : inferCaptureDate(r.metadata, basename(r.path), {});
    const stamp = now();
    db.prepare(`
      UPDATE screenshots SET
        content_hash = ?, file_size = ?, format = ?, width = ?, height = ?,
        captured_at = COALESCE(?, captured_at), captured_at_source = COALESCE(?, captured_at_source),
        source_device = ?, indexed_at = ?, status = 'extracted', error = NULL
      WHERE id = ?
    `).run(
      r.sha256, r.byteSize, formatFromUti(r.uti), r.width, r.height,
      captured?.iso ?? null, captured?.source ?? null,
      r.metadata.tiffModel ?? null, stamp, row.id,
    );
    db.prepare(`
      INSERT INTO extractions
        (screenshot_id, ocr_text, ocr_confidence, labels, metadata, thumb_path, thumb_width, thumb_height,
         feature_print, feature_print_revision, engine, extracted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (screenshot_id) DO UPDATE SET
        ocr_text = excluded.ocr_text, ocr_confidence = excluded.ocr_confidence, labels = excluded.labels,
        metadata = excluded.metadata, thumb_path = excluded.thumb_path, thumb_width = excluded.thumb_width,
        thumb_height = excluded.thumb_height, feature_print = excluded.feature_print,
        feature_print_revision = excluded.feature_print_revision, engine = excluded.engine,
        extracted_at = excluded.extracted_at
    `).run(
      row.id,
      r.ocr?.text ?? "",
      r.ocr?.confidence ?? null,
      JSON.stringify(r.labels ?? []),
      JSON.stringify(r.metadata ?? {}),
      r.thumb ? relative(config.home, r.thumb.path) : null,
      r.thumb?.width ?? null,
      r.thumb?.height ?? null,
      r.featurePrint ? Buffer.from(r.featurePrint.base64, "base64") : null,
      r.featurePrint?.revision ?? null,
      engine,
      stamp,
    );
    // An analysis written for these exact bytes still holds (e.g. the file was
    // only touched); one written for older bytes is stale and needs redoing.
    db.prepare(`
      UPDATE screenshots SET status = 'analyzed'
      WHERE id = ? AND EXISTS (SELECT 1 FROM analyses a WHERE a.screenshot_id = ? AND a.content_hash = ?)
    `).run(row.id, row.id, r.sha256);
    reindexScreenshot(db, row.id);
    return false;
  });
}

/**
 * A never-before-extracted image whose bytes match a screenshot that went
 * missing is the same screenshot moved, renamed, or moved between a folder
 * and Photos: keep the old record (and its id) and point it at the new location.
 */
function relinkMovedFile(db: Db, config: Config, row: PendingRow, r: { sha256: string; thumb?: { path: string } }): boolean {
  const original = db
    .prepare(`
      SELECT s.id FROM screenshots s JOIN extractions e ON e.screenshot_id = s.id
      WHERE s.content_hash = ? AND s.missing_since IS NOT NULL AND s.id != ?
      ORDER BY s.missing_since DESC LIMIT 1
    `)
    .get(r.sha256, row.id) as { id: string } | undefined;
  if (!original) return false;

  const moved = db
    .prepare(`
      SELECT source_id, source_key, file_path, photo_asset_id, file_name, file_size, file_mtime, source_version
      FROM screenshots WHERE id = ?
    `)
    .get(row.id) as Record<string, string | number | null>;
  db.prepare("DELETE FROM screenshots WHERE id = ?").run(row.id);
  db.prepare(`
    UPDATE screenshots SET source_id = ?, source_key = ?, file_path = ?, photo_asset_id = ?, file_name = ?,
      file_size = ?, file_mtime = ?, source_version = ?, missing_since = NULL, modified_at = ?
    WHERE id = ?
  `).run(
    moved.source_id, moved.source_key, moved.file_path, moved.photo_asset_id, moved.file_name,
    moved.file_size, moved.file_mtime, moved.source_version, now(), original.id,
  );
  reindexScreenshot(db, original.id); // the file name is searchable
  if (r.thumb) rmSync(r.thumb.path, { force: true });
  return true;
}

function formatFromUti(uti: string | null): string | null {
  if (!uti) return null;
  const known: Record<string, string> = {
    "public.png": "png",
    "public.jpeg": "jpeg",
    "public.heic": "heic",
    "public.heif": "heif",
    "org.webmproject.webp": "webp",
    "public.tiff": "tiff",
  };
  return known[uti] ?? uti;
}

export function absoluteThumbPath(config: Config, thumbPath: string | null): string | null {
  return thumbPath ? join(config.home, thumbPath) : null;
}
