import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { dateFromFileName } from "./dates.ts";
import { type Db, now, transaction } from "./db.ts";
import type { PhotoAsset } from "./photos.ts";

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".heic", ".heif", ".webp", ".tif", ".tiff"]);

// Never descend into these: they are app bundles or caches, not screenshot folders.
const SKIP_DIR_SUFFIXES = [".photoslibrary", ".app", ".bundle", ".photolibrary"];

export interface Source {
  id: string;
  kind: "folder" | "photos";
  location: string;
  label: string | null;
  created_at: string;
  last_scan_at: string | null;
}

export interface DiscoveredFile {
  key: string;
  path: string;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
}

export interface ReconcileResult {
  discovered: number;
  added: number;
  changed: number;
  returned: number;
  missing: number;
}

export function ensureFolderSource(db: Db, folder: string): Source {
  const existing = db
    .prepare("SELECT * FROM sources WHERE kind = 'folder' AND location = ?")
    .get(folder) as Source | undefined;
  if (existing) return existing;
  const source: Source = {
    id: randomUUID(),
    kind: "folder",
    location: folder,
    label: basename(folder),
    created_at: now(),
    last_scan_at: null,
  };
  db.prepare(
    "INSERT INTO sources (id, kind, location, label, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(source.id, source.kind, source.location, source.label, source.created_at);
  return source;
}

/** The location recorded for the Photos source: the system Photos library. */
export const PHOTOS_LOCATION = "Photos library";

export function ensurePhotosSource(db: Db): Source {
  const existing = db.prepare("SELECT * FROM sources WHERE kind = 'photos'").get() as Source | undefined;
  if (existing) return existing;
  const source: Source = {
    id: randomUUID(),
    kind: "photos",
    location: PHOTOS_LOCATION,
    label: "Photos",
    created_at: now(),
    last_scan_at: null,
  };
  db.prepare(
    "INSERT INTO sources (id, kind, location, label, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(source.id, source.kind, source.location, source.label, source.created_at);
  return source;
}

export function photosSource(db: Db): Source | undefined {
  return db.prepare("SELECT * FROM sources WHERE kind = 'photos'").get() as Source | undefined;
}

export function listSources(db: Db): Source[] {
  return db.prepare("SELECT * FROM sources ORDER BY created_at").all() as unknown as Source[];
}

/** Recursively finds image files under root, skipping hidden entries and bundles. */
export async function discoverFolder(root: string): Promise<DiscoveredFile[]> {
  const found: DiscoveredFile[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (SKIP_DIR_SUFFIXES.some((s) => lower.endsWith(s))) continue;
        await walk(full);
      } else if (entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        const st = await stat(full);
        found.push({
          key: relative(root, full),
          path: full,
          size: st.size,
          mtimeMs: st.mtimeMs,
          birthtimeMs: st.birthtimeMs,
        });
      }
    }
  }
  await walk(root);
  return found;
}

interface KnownRow {
  id: string;
  source_key: string;
  file_size: number | null;
  file_mtime: string | null;
  missing_since: string | null;
}

/**
 * Brings the screenshots table in line with what is on disk. New files are
 * queued as 'pending'; changed files are re-queued; vanished files are marked
 * missing (never deleted, so their analysis and corrections survive).
 */
export function reconcileFolder(db: Db, source: Source, files: DiscoveredFile[]): ReconcileResult {
  const result: ReconcileResult = { discovered: files.length, added: 0, changed: 0, returned: 0, missing: 0 };
  const stamp = now();

  transaction(db, () => {
    const known = new Map<string, KnownRow>();
    const rows = db
      .prepare("SELECT id, source_key, file_size, file_mtime, missing_since FROM screenshots WHERE source_id = ?")
      .all(source.id) as unknown as KnownRow[];
    for (const row of rows) known.set(row.source_key, row);

    const insert = db.prepare(`
      INSERT INTO screenshots
        (id, source_id, source_key, file_path, file_size, file_mtime, captured_at, captured_at_source,
         discovered_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `);
    const requeue = db.prepare(`
      UPDATE screenshots
      SET file_path = ?, file_size = ?, file_mtime = ?, modified_at = ?, missing_since = NULL,
          status = 'pending', error = NULL
      WHERE id = ?
    `);
    const restore = db.prepare("UPDATE screenshots SET missing_since = NULL, file_path = ? WHERE id = ?");
    const markMissing = db.prepare("UPDATE screenshots SET missing_since = ? WHERE id = ?");

    const seen = new Set<string>();
    for (const file of files) {
      seen.add(file.key);
      const mtime = new Date(file.mtimeMs).toISOString();
      const row = known.get(file.key);
      if (!row) {
        // Provisional date for ordering; extraction refines it from metadata.
        const fromName = dateFromFileName(basename(file.path));
        const provisional = fromName ?? new Date(file.birthtimeMs || file.mtimeMs).toISOString();
        insert.run(
          randomUUID(), source.id, file.key, file.path, file.size, mtime,
          provisional, fromName ? "filename" : "file", stamp,
        );
        result.added++;
      } else if (row.file_size !== file.size || row.file_mtime !== mtime) {
        requeue.run(file.path, file.size, mtime, stamp, row.id);
        result.changed++;
      } else if (row.missing_since) {
        restore.run(file.path, row.id);
        result.returned++;
      }
    }
    for (const row of rows) {
      if (!seen.has(row.source_key) && !row.missing_since) {
        markMissing.run(stamp, row.id);
        result.missing++;
      }
    }
    db.prepare("UPDATE sources SET last_scan_at = ? WHERE id = ?").run(stamp, source.id);
  });

  return result;
}

/**
 * What changes when a Photos asset's image can have changed. Originals in
 * Photos never change, and the modification date also moves for things like
 * iCloud syncing, so only an edit (or a new size) counts.
 */
export function photoVersion(asset: PhotoAsset): string {
  const size = `${asset.width}x${asset.height}`;
  return asset.edited ? `${size} edited ${asset.modified ?? ""}` : size;
}

/**
 * Brings the screenshots table in line with the Photos Screenshots album,
 * like reconcileFolder: new assets are queued, edited ones re-queued, and
 * assets gone from the album (deleted or hidden) marked missing.
 */
export function reconcilePhotos(db: Db, source: Source, assets: PhotoAsset[]): ReconcileResult {
  const result: ReconcileResult = { discovered: assets.length, added: 0, changed: 0, returned: 0, missing: 0 };
  const stamp = now();

  transaction(db, () => {
    const known = new Map<string, { id: string; source_version: string | null; missing_since: string | null }>();
    const rows = db
      .prepare("SELECT id, source_key, source_version, missing_since FROM screenshots WHERE source_id = ?")
      .all(source.id) as unknown as Array<{ id: string; source_key: string; source_version: string | null; missing_since: string | null }>;
    for (const row of rows) known.set(row.source_key, row);

    // file_name is filled in by extraction; '' keeps the asset id out of names until then.
    const insert = db.prepare(`
      INSERT INTO screenshots
        (id, source_id, source_key, photo_asset_id, file_name, file_mtime, source_version, width, height,
         captured_at, captured_at_source, discovered_at, status)
      VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, 'photos', ?, 'pending')
    `);
    const requeue = db.prepare(`
      UPDATE screenshots
      SET file_mtime = ?, source_version = ?, modified_at = ?, missing_since = NULL, status = 'pending', error = NULL
      WHERE id = ?
    `);
    const update = db.prepare("UPDATE screenshots SET file_mtime = ?, missing_since = NULL WHERE id = ?");
    const markMissing = db.prepare("UPDATE screenshots SET missing_since = ? WHERE id = ?");

    const seen = new Set<string>();
    for (const asset of assets) {
      seen.add(asset.asset);
      const version = photoVersion(asset);
      const row = known.get(asset.asset);
      if (!row) {
        insert.run(
          randomUUID(), source.id, asset.asset, asset.asset, asset.modified, version, asset.width, asset.height,
          asset.created ?? stamp, stamp,
        );
        result.added++;
      } else if (row.source_version !== version) {
        requeue.run(asset.modified, version, stamp, row.id);
        result.changed++;
      } else {
        update.run(asset.modified, row.id);
        if (row.missing_since) result.returned++;
      }
    }
    for (const row of rows) {
      if (!seen.has(row.source_key) && !row.missing_since) {
        markMissing.run(stamp, row.id);
        result.missing++;
      }
    }
    db.prepare("UPDATE sources SET last_scan_at = ? WHERE id = ?").run(stamp, source.id);
  });

  return result;
}
