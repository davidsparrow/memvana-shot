// The user's own edits to a screenshot's details. Each text field overrides
// Claude's value until cleared; keywords can be added or removed on top of
// Claude's. Stored apart from analyses, so re-analysis never overwrites them.

import { normalizeTags } from "./analysis.ts";
import { type Db, now, transaction } from "./db.ts";
import { reindexScreenshot } from "./search-index.ts";

export interface UserEdits {
  short_description: string | null;
  detailed_description: string | null;
  likely_reason_saved: string | null;
  notes: string | null;
  keywords_added: string[];
  keywords_removed: string[];
  updated_at: string;
}

export interface EditInput {
  /** A string overrides Claude's value; null or "" reverts to it; undefined leaves it alone. */
  short_description?: string | null;
  detailed_description?: string | null;
  likely_reason_saved?: string | null;
  notes?: string | null;
  add_keywords?: string[];
  remove_keywords?: string[];
  /** Hide from search, stats and analysis (or un-hide). */
  ignored?: boolean;
}

const TEXT_FIELDS = ["short_description", "detailed_description", "likely_reason_saved", "notes"] as const;

export function userEdits(db: Db, id: string): UserEdits | null {
  const row = db.prepare("SELECT * FROM user_edits WHERE screenshot_id = ?").get(id) as Record<string, any> | undefined;
  if (!row) return null;
  return {
    short_description: row.short_description,
    detailed_description: row.detailed_description,
    likely_reason_saved: row.likely_reason_saved,
    notes: row.notes,
    keywords_added: JSON.parse(row.keywords_added),
    keywords_removed: JSON.parse(row.keywords_removed),
    updated_at: row.updated_at,
  };
}

export function editScreenshot(db: Db, id: string, input: EditInput): UserEdits | null {
  return transaction(db, () => {
    if (!db.prepare("SELECT 1 FROM screenshots WHERE id = ?").get(id)) {
      throw new Error(`No screenshot with id ${id}`);
    }
    if (input.ignored !== undefined) {
      db.prepare("UPDATE screenshots SET ignored = ? WHERE id = ?").run(input.ignored ? 1 : 0, id);
    }

    const current = userEdits(db, id) ?? {
      short_description: null,
      detailed_description: null,
      likely_reason_saved: null,
      notes: null,
      keywords_added: [],
      keywords_removed: [],
      updated_at: now(),
    };
    const next = { ...current };
    for (const field of TEXT_FIELDS) {
      const value = input[field];
      if (value === undefined) continue;
      next[field] = value === null || value.trim() === "" ? null : value.trim();
    }
    // Adding a keyword the user had removed restores Claude's; removing one the
    // user had added just withdraws it. Neither leaves an override behind.
    let added = [...current.keywords_added];
    let removed = [...current.keywords_removed];
    for (const k of normalizeTags(input.add_keywords ?? [])) {
      if (removed.includes(k)) removed = removed.filter((r) => r !== k);
      else if (!added.includes(k)) added.push(k);
    }
    for (const k of normalizeTags(input.remove_keywords ?? [])) {
      if (added.includes(k)) added = added.filter((a) => a !== k);
      else if (!removed.includes(k)) removed.push(k);
    }
    next.keywords_added = added;
    next.keywords_removed = removed;

    const empty =
      TEXT_FIELDS.every((f) => next[f] === null) && !next.keywords_added.length && !next.keywords_removed.length;
    if (empty) {
      db.prepare("DELETE FROM user_edits WHERE screenshot_id = ?").run(id);
    } else {
      db.prepare(`
        INSERT INTO user_edits
          (screenshot_id, short_description, detailed_description, likely_reason_saved, notes,
           keywords_added, keywords_removed, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (screenshot_id) DO UPDATE SET
          short_description = excluded.short_description, detailed_description = excluded.detailed_description,
          likely_reason_saved = excluded.likely_reason_saved, notes = excluded.notes,
          keywords_added = excluded.keywords_added, keywords_removed = excluded.keywords_removed,
          updated_at = excluded.updated_at
      `).run(
        id,
        next.short_description,
        next.detailed_description,
        next.likely_reason_saved,
        next.notes,
        JSON.stringify(next.keywords_added),
        JSON.stringify(next.keywords_removed),
        now(),
      );
    }
    reindexScreenshot(db, id);
    return userEdits(db, id);
  });
}
