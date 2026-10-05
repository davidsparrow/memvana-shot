// The text each screenshot is embedded from. It is read from the keyword
// search index, which already holds each screenshot's effective details (the
// user's edits and notes over Claude's analysis, tags, file name, OCR text), so
// both kinds of search always describe a screenshot the same way.

import { createHash } from "node:crypto";
import type { Db } from "../db.ts";

/** Bump when the document text below changes; every screenshot is then re-embedded. */
export const DOCUMENT_VERSION = 1;

const OCR_CHARS = 800;

export interface EmbeddingDocument {
  id: string;
  title: string | null;
  text: string;
  /** Identifies this exact text for this model. */
  hash: string;
}

interface IndexRow {
  id: string;
  title: string;
  reason: string;
  tags: string;
  notes: string;
  topics: string;
  keywords: string;
  entities: string;
  body: string;
  ocr: string;
  filename: string;
}

/** Screenshots that can be searched: extracted, present and not hidden. */
const ELIGIBLE = "s.ignored = 0 AND s.missing_since IS NULL AND s.status IN ('extracted', 'analyzed')";

export function embeddingDocuments(db: Db, model: string, ids?: string[]): EmbeddingDocument[] {
  const only = ids ? `AND s.id IN (${ids.map(() => "?").join(", ")})` : "";
  const rows = db
    .prepare(`
      SELECT s.id, si.title, si.reason, si.tags, si.notes, si.topics, si.keywords, si.entities, si.body,
             si.ocr, si.filename
      FROM screenshots s JOIN search_index si ON si.rowid = s.search_rowid
      WHERE ${ELIGIBLE} ${only}
      ORDER BY s.captured_at DESC
    `)
    .all(...(ids ?? [])) as unknown as IndexRow[];
  return rows.map((row) => {
    const { title, text } = documentText(row);
    const hash = createHash("sha1").update(`${model}\n${DOCUMENT_VERSION}\n${title ?? ""}\n${text}`).digest("hex");
    return { id: row.id, title, text, hash };
  });
}

/** The index stores lists joined with " | "; tidy them into a comma list. */
function list(value: string): string {
  return value
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
}

function documentText(row: IndexRow): { title: string | null; text: string } {
  const ocr = row.ocr.replace(/\s+/g, " ").trim();
  const lines = [
    row.reason,
    row.body,
    row.notes && `Notes: ${row.notes}`,
    list(row.tags) && `Tags: ${list(row.tags)}`,
    list(row.topics) && `Topics: ${list(row.topics)}`,
    list(row.keywords) && `Keywords: ${list(row.keywords)}`,
    list(row.entities) && `Names: ${list(row.entities)}`,
    row.filename && `File name: ${row.filename}`,
    ocr && `Text in image: ${ocr.length > OCR_CHARS ? ocr.slice(0, OCR_CHARS) + "…" : ocr}`,
  ];
  return {
    title: row.title.trim() || null,
    text: lines.map((line) => line?.trim()).filter(Boolean).join("\n"),
  };
}
