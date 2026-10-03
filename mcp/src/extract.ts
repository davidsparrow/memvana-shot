import { rmSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { type Config, thumbsDir } from "./config.ts";
import { inferCaptureDate } from "./dates.ts";
import { type Db, now, transaction } from "./db.ts";
import { type ExtractSuccess, helperVersion, runExtract } from "./helper.ts";

export interface ExtractSummary {
  processed: number;
  succeeded: number;
  failed: number;
  /** Renamed/moved files matched back to their existing record by content hash. */
  relinked: number;
  elapsed_ms: number;
  errors: Array<{ id: string; file: string; error: string }>;
}

export interface ExtractRunOptions {
  limit: number;
  maxDim?: number;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

interface PendingRow {
  id: string;
  file_path: string;
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

/** Runs local extraction (OCR, labels, thumbnail, feature print) on pending screenshots, newest first. */
export async function extractPending(
  db: Db,
  config: Config,
  helper: string,
  options: ExtractRunOptions,
): Promise<ExtractSummary> {
  const started = Date.now();
  const summary: ExtractSummary = { processed: 0, succeeded: 0, failed: 0, relinked: 0, elapsed_ms: 0, errors: [] };
  const rows = db
    .prepare(`
      SELECT id, file_path, content_hash FROM screenshots
      WHERE status = 'pending' AND ignored = 0 AND missing_since IS NULL AND file_path IS NOT NULL
      ORDER BY captured_at DESC
      LIMIT ?
    `)
    .all(options.limit) as unknown as PendingRow[];
  if (rows.length === 0) return summary;

  const byId = new Map(rows.map((r) => [r.id, r]));
  const version = await helperVersion(helper);
  const engine = `shot-helper/${version.version} ocr-r${version.ocrRevision} fp-r${version.featurePrintRevision}`;

  await runExtract(
    helper,
    rows.map((r) => ({ id: r.id, path: r.file_path })),
    { thumbDir: thumbsDir(config), maxDim: options.maxDim, concurrency: options.concurrency },
    (result) => {
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
          summary.errors.push({ id: row.id, file: basename(row.file_path), error: result.error });
        }
      }
      options.onProgress?.(summary.processed, rows.length);
    },
  );

  summary.elapsed_ms = Date.now() - started;
  return summary;
}

/** Returns true when the file turned out to be a moved/renamed copy of a known screenshot. */
function persistExtraction(db: Db, config: Config, row: PendingRow, r: ExtractSuccess, engine: string): boolean {
  return transaction(db, () => {
    if (row.content_hash === null && relinkMovedFile(db, config, row, r)) return true;

    // No file times here: without metadata or a dated name, the scanner's
    // birthtime-based provisional date (kept by COALESCE below) is the best guess.
    const captured = inferCaptureDate(r.metadata, basename(r.path), {});
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
    return false;
  });
}

/**
 * A never-before-extracted file whose bytes match a screenshot that went
 * missing is the same screenshot moved or renamed: keep the old record (and
 * its id) and point it at the new location.
 */
function relinkMovedFile(db: Db, config: Config, row: PendingRow, r: ExtractSuccess): boolean {
  const original = db
    .prepare(`
      SELECT s.id FROM screenshots s JOIN extractions e ON e.screenshot_id = s.id
      WHERE s.content_hash = ? AND s.missing_since IS NOT NULL AND s.id != ?
      ORDER BY s.missing_since DESC LIMIT 1
    `)
    .get(r.sha256, row.id) as { id: string } | undefined;
  if (!original) return false;

  const moved = db
    .prepare("SELECT source_id, source_key, file_path, file_size, file_mtime FROM screenshots WHERE id = ?")
    .get(row.id) as { source_id: string; source_key: string; file_path: string; file_size: number; file_mtime: string };
  db.prepare("DELETE FROM screenshots WHERE id = ?").run(row.id);
  db.prepare(`
    UPDATE screenshots SET source_id = ?, source_key = ?, file_path = ?, file_size = ?, file_mtime = ?,
      missing_since = NULL, modified_at = ?
    WHERE id = ?
  `).run(moved.source_id, moved.source_key, moved.file_path, moved.file_size, moved.file_mtime, now(), original.id);
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
