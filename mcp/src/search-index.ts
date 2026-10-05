import type { Db } from "./db.ts";

// The full-text index is derived data: one row per extracted screenshot, keyed
// by screenshots.search_rowid, holding the *effective* details (the user's
// edits win over Claude's analysis). Bump SEARCH_INDEX_VERSION whenever the
// columns, weights or row SQL change; ensureSearchIndex() then rebuilds it.
export const SEARCH_INDEX_VERSION = 3;

// Columns from most to least telling. SEARCH_WEIGHTS gives each column's bm25
// weight in the same order.
export const SEARCH_COLUMNS = [
  "title", //    short description
  "reason", //   likely reason saved
  "tags", //     non-rejected tag names
  "notes", //    the user's own notes
  "topics",
  "keywords", // includes visual descriptors the OCR can't see
  "entities", // names, plus the source app
  "body", //     detailed description and content type
  "ocr",
  "labels", //   Vision classifier labels
  "filename", // meaningful folder and file-name words only (see names.ts)
] as const;

export const SEARCH_WEIGHTS = [8, 6, 7, 7, 6, 5, 5, 3, 1.5, 1, 4];

const CREATE_SEARCH_INDEX = `
  CREATE VIRTUAL TABLE search_index USING fts5(
    ${SEARCH_COLUMNS.join(", ")},
    tokenize = 'porter unicode61 remove_diacritics 2'
  );
`;

/** INSERT … SELECT that (re)builds index rows for screenshots matching `where`. */
function indexRowsSql(where: string): string {
  return `
    INSERT INTO search_index (rowid, ${SEARCH_COLUMNS.join(", ")})
    SELECT
      s.search_rowid,
      COALESCE(u.short_description, a.short_description, ''),
      COALESCE(u.likely_reason_saved, a.likely_reason_saved, ''),
      COALESCE((
        SELECT group_concat(t.name, ' | ') FROM screenshot_tags st JOIN tags t ON t.id = st.tag_id
        WHERE st.screenshot_id = s.id AND st.state != 'rejected'
      ), ''),
      COALESCE(u.notes, ''),
      COALESCE((SELECT group_concat(value, ' | ') FROM json_each(a.topics)), ''),
      COALESCE((
        SELECT group_concat(value, ' | ') FROM json_each(a.keywords)
        WHERE value NOT IN (SELECT value FROM json_each(COALESCE(u.keywords_removed, '[]')))
      ), '') || ' | ' || COALESCE((SELECT group_concat(value, ' | ') FROM json_each(u.keywords_added)), ''),
      COALESCE((SELECT group_concat(json_extract(value, '$.name'), ' | ') FROM json_each(a.entities)), '')
        || ' | ' || COALESCE(a.source_app, ''),
      COALESCE(u.detailed_description, a.detailed_description, '') || ' ' || COALESCE(a.content_type, ''),
      COALESCE(e.ocr_text, ''),
      COALESCE((SELECT group_concat(json_extract(value, '$.label'), ' ') FROM json_each(e.labels)), ''),
      name_terms(s.source_key)
    FROM screenshots s
    JOIN extractions e ON e.screenshot_id = s.id
    LEFT JOIN analyses a ON a.screenshot_id = s.id
    LEFT JOIN user_edits u ON u.screenshot_id = s.id
    WHERE s.search_rowid IS NOT NULL AND (${where})
  `;
}

/** Creates or rebuilds the index when its definition has changed. Runs on every open. */
export function ensureSearchIndex(db: Db): void {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'search_index_version'").get() as
    | { value: string }
    | undefined;
  if (row?.value === String(SEARCH_INDEX_VERSION)) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DROP TABLE IF EXISTS search_index");
    db.exec(CREATE_SEARCH_INDEX);
    rebuildSearchIndex(db);
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('search_index_version', ?) " +
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).run(String(SEARCH_INDEX_VERSION));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Counts changes to index rows. The semantic index compares it with the value
 * it last saw, so it can skip re-checking every screenshot when nothing changed.
 */
export function searchGeneration(db: Db): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'search_generation'").get() as
    | { value: string }
    | undefined;
  return Number(row?.value ?? 0);
}

function bumpSearchGeneration(db: Db): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('search_generation', '1') " +
      "ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1",
  ).run();
}

/** Rewrites one screenshot's index row from its current extraction, analysis, edits and tags. */
export function reindexScreenshot(db: Db, id: string): void {
  db.prepare(`
    UPDATE screenshots
    SET search_rowid = (SELECT COALESCE(MAX(search_rowid), 0) + 1 FROM screenshots)
    WHERE id = ? AND search_rowid IS NULL
  `).run(id);
  const row = db.prepare("SELECT search_rowid FROM screenshots WHERE id = ?").get(id) as
    | { search_rowid: number | null }
    | undefined;
  if (!row?.search_rowid) return;
  db.prepare("DELETE FROM search_index WHERE rowid = ?").run(row.search_rowid);
  db.prepare(indexRowsSql("s.id = ?")).run(id);
  bumpSearchGeneration(db);
}

/** Reindexes every screenshot carrying a tag (after a rename, merge or delete). */
export function reindexTagged(db: Db, tagId: string): void {
  const ids = db.prepare("SELECT screenshot_id FROM screenshot_tags WHERE tag_id = ?").all(tagId) as Array<{
    screenshot_id: string;
  }>;
  for (const { screenshot_id } of ids) reindexScreenshot(db, screenshot_id);
}

/** Drops and rebuilds every index row. Returns the number of rows indexed. */
export function rebuildSearchIndex(db: Db): number {
  db.exec("DELETE FROM search_index");
  db.exec(`
    UPDATE screenshots
    SET search_rowid = (SELECT COALESCE(MAX(search_rowid), 0) FROM screenshots) + rowid
    WHERE search_rowid IS NULL AND id IN (SELECT screenshot_id FROM extractions)
  `);
  db.exec(indexRowsSql("1"));
  bumpSearchGeneration(db);
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM search_index").get() as { n: number };
  return n;
}
