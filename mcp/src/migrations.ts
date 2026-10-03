// Schema migrations, applied in order and recorded in meta.schema_version.
//
// IDs are stable UUIDs that are never reused: user corrections, categories and
// any future importer key off screenshots.id, so a screenshot keeps its id
// across rescans, renames (matched by content hash) and source changes.

export interface Migration {
  version: number;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Where screenshots come from: a folder today, the Photos library later.
      CREATE TABLE sources (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL CHECK (kind IN ('folder', 'photos')),
        location     TEXT NOT NULL,
        label        TEXT,
        created_at   TEXT NOT NULL,
        last_scan_at TEXT,
        UNIQUE (kind, location)
      );

      CREATE TABLE screenshots (
        id                 TEXT PRIMARY KEY,
        source_id          TEXT NOT NULL REFERENCES sources(id),
        -- Path relative to the folder root, or a PhotoKit local identifier.
        source_key         TEXT NOT NULL,
        photo_asset_id     TEXT,
        file_path          TEXT,
        file_size          INTEGER,
        file_mtime         TEXT,
        content_hash       TEXT,
        format             TEXT,
        width              INTEGER,
        height             INTEGER,
        captured_at        TEXT,
        captured_at_source TEXT,
        source_device      TEXT,
        discovered_at      TEXT NOT NULL,
        indexed_at         TEXT,
        modified_at        TEXT,
        missing_since      TEXT,
        status             TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'extracted', 'analyzed', 'error')),
        error              TEXT,
        ignored            INTEGER NOT NULL DEFAULT 0,
        UNIQUE (source_id, source_key)
      );
      CREATE INDEX screenshots_status   ON screenshots (status);
      CREATE INDEX screenshots_captured ON screenshots (captured_at);
      CREATE INDEX screenshots_hash     ON screenshots (content_hash);

      -- Facts produced locally by shot-helper (no AI interpretation).
      CREATE TABLE extractions (
        screenshot_id          TEXT PRIMARY KEY REFERENCES screenshots(id) ON DELETE CASCADE,
        ocr_text               TEXT NOT NULL DEFAULT '',
        ocr_confidence         REAL,
        labels                 TEXT NOT NULL DEFAULT '[]',
        metadata               TEXT NOT NULL DEFAULT '{}',
        thumb_path             TEXT,
        thumb_width            INTEGER,
        thumb_height           INTEGER,
        feature_print          BLOB,
        feature_print_revision INTEGER,
        engine                 TEXT NOT NULL,
        extracted_at           TEXT NOT NULL
      );
    `,
  },
];
