import type { Db } from "./db.ts";

// The full-text index has one row per extracted screenshot, keyed by
// screenshots.search_rowid. Its columns run from most to least telling, and
// SEARCH_WEIGHTS gives each column's bm25 weight in the same order.
export const SEARCH_COLUMNS = [
  "title", //    analysis.short_description
  "reason", //   analysis.likely_reason_saved
  "topics",
  "keywords", // includes visual descriptors the OCR can't see
  "entities", // names, plus the source app
  "body", //     detailed description and content type
  "ocr",
  "labels", //   Vision classifier labels
  "filename",
] as const;

export const SEARCH_WEIGHTS = [8, 6, 6, 5, 5, 3, 1.5, 1, 1];

export const CREATE_SEARCH_INDEX = `
  CREATE VIRTUAL TABLE search_index USING fts5(
    ${SEARCH_COLUMNS.join(", ")},
    tokenize = 'porter unicode61 remove_diacritics 2'
  );
`;

/** INSERT … SELECT that (re)builds index rows for screenshots matching `where`. */
export function indexRowsSql(where: string): string {
  return `
    INSERT INTO search_index (rowid, ${SEARCH_COLUMNS.join(", ")})
    SELECT
      s.search_rowid,
      COALESCE(a.short_description, ''),
      COALESCE(a.likely_reason_saved, ''),
      COALESCE((SELECT group_concat(value, ' | ') FROM json_each(a.topics)), ''),
      COALESCE((SELECT group_concat(value, ' | ') FROM json_each(a.keywords)), ''),
      COALESCE((SELECT group_concat(json_extract(value, '$.name'), ' | ') FROM json_each(a.entities)), '')
        || ' ' || COALESCE(a.source_app, ''),
      COALESCE(a.detailed_description, '') || ' ' || COALESCE(a.content_type, ''),
      COALESCE(e.ocr_text, ''),
      COALESCE((SELECT group_concat(json_extract(value, '$.label'), ' ') FROM json_each(e.labels)), ''),
      s.source_key
    FROM screenshots s
    JOIN extractions e ON e.screenshot_id = s.id
    LEFT JOIN analyses a ON a.screenshot_id = s.id
    WHERE s.search_rowid IS NOT NULL AND (${where})
  `;
}

/** Rewrites one screenshot's index row from its current extraction and analysis. */
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
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM search_index").get() as { n: number };
  return n;
}
