// Schema migrations, applied in order and recorded in meta.schema_version.
//
// IDs are stable UUIDs that are never reused: user corrections, categories and
// any future importer key off screenshots.id, so a screenshot keeps its id
// across rescans, renames (matched by content hash) and source changes.
//
// Migrations hold tables only. The full-text index is derived data, so it is
// (re)built by ensureSearchIndex() whenever its definition changes.

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
  {
    version: 2,
    sql: `
      -- Claude's understanding of a screenshot. content_hash records which
      -- version of the image it describes, so edits can mark it stale.
      CREATE TABLE analyses (
        screenshot_id        TEXT PRIMARY KEY REFERENCES screenshots(id) ON DELETE CASCADE,
        short_description    TEXT NOT NULL,
        detailed_description TEXT NOT NULL,
        likely_reason_saved  TEXT NOT NULL,
        content_type         TEXT NOT NULL,
        source_app           TEXT,
        entities             TEXT NOT NULL DEFAULT '[]',
        topics               TEXT NOT NULL DEFAULT '[]',
        keywords             TEXT NOT NULL DEFAULT '[]',
        sensitive            INTEGER NOT NULL DEFAULT 0,
        confidence           REAL,
        model                TEXT,
        analysis_version     INTEGER NOT NULL,
        content_hash         TEXT,
        analyzed_at          TEXT NOT NULL
      );
      CREATE INDEX analyses_content_type ON analyses (content_type);

      -- Batches handed out for analysis are leased, so parallel analysts never
      -- receive the same screenshots.
      ALTER TABLE screenshots ADD COLUMN analysis_claimed_until TEXT;

      -- Stable integer key for the search index row (rowids can change on VACUUM).
      ALTER TABLE screenshots ADD COLUMN search_rowid INTEGER;
      CREATE UNIQUE INDEX screenshots_search_rowid ON screenshots (search_rowid);
    `,
  },
  {
    // Formerly a search-index rebuild; that now lives in ensureSearchIndex().
    version: 3,
    sql: "",
  },
  {
    version: 4,
    sql: `
      -- Tags are the user's top-level grouping. A tag can come from the user,
      -- from Claude (approved by the user), or from Finder.
      CREATE TABLE tags (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        name_key    TEXT NOT NULL UNIQUE,
        description TEXT,
        origin      TEXT NOT NULL CHECK (origin IN ('user', 'ai', 'finder')),
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      -- One row per screenshot/tag pair. 'suggested' is Claude's guess;
      -- 'confirmed' and 'added' come from the user; 'rejected' means the user
      -- said no, and Claude must never suggest that tag for that screenshot again.
      CREATE TABLE screenshot_tags (
        screenshot_id TEXT NOT NULL REFERENCES screenshots(id) ON DELETE CASCADE,
        tag_id        TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        state         TEXT NOT NULL CHECK (state IN ('suggested', 'confirmed', 'added', 'rejected')),
        source        TEXT NOT NULL CHECK (source IN ('ai', 'user', 'finder')),
        confidence    REAL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (screenshot_id, tag_id)
      );
      CREATE INDEX screenshot_tags_tag ON screenshot_tags (tag_id, state);

      -- The user's own edits. They override Claude's analysis field by field
      -- and survive re-analysis.
      CREATE TABLE user_edits (
        screenshot_id        TEXT PRIMARY KEY REFERENCES screenshots(id) ON DELETE CASCADE,
        short_description    TEXT,
        detailed_description TEXT,
        likely_reason_saved  TEXT,
        notes                TEXT,
        keywords_added       TEXT NOT NULL DEFAULT '[]',
        keywords_removed     TEXT NOT NULL DEFAULT '[]',
        updated_at           TEXT NOT NULL
      );

      -- When Claude last considered this screenshot for tag suggestions.
      ALTER TABLE screenshots ADD COLUMN ai_tagged_at TEXT;
    `,
  },
];
