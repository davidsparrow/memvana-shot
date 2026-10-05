// Tags: the user's top-level grouping of screenshots.
//
// Precedence, strongest first:
//   added      the user (or Finder) put the tag on
//   confirmed  the user accepted Claude's suggestion
//   suggested  Claude's guess
//   rejected   the user said no; Claude must never suggest it again
// Claude's suggestions never change a row the user has touched.

import { randomUUID } from "node:crypto";
import { type Db, now, transaction } from "./db.ts";
import { reindexScreenshot, reindexTagged } from "./search-index.ts";

export type TagState = "suggested" | "confirmed" | "added" | "rejected";
export type TagSource = "ai" | "user" | "finder";
export type TagOrigin = "user" | "ai" | "finder";

const RANK: Record<TagState, number> = { rejected: 1, suggested: 2, confirmed: 3, added: 4 };
const MAX_TAG_LENGTH = 40;

export interface Tag {
  id: string;
  name: string;
  description: string | null;
  origin: TagOrigin;
}

export interface TagSummary {
  name: string;
  description: string | null;
  origin: TagOrigin;
  /** Screenshots carrying the tag (added + confirmed + suggested). */
  total: number;
  added: number;
  confirmed: number;
  suggested: number;
}

export function tagKey(name: string): string {
  return cleanTagName(name).toLowerCase();
}

export function cleanTagName(name: string): string {
  const cleaned = name.replace(/\s+/g, " ").trim();
  if (!cleaned) throw new Error("Tag names can't be empty.");
  if (cleaned.length > MAX_TAG_LENGTH) throw new Error(`Tag names are limited to ${MAX_TAG_LENGTH} characters.`);
  return cleaned;
}

export function findTag(db: Db, name: string): Tag | undefined {
  return db.prepare("SELECT id, name, description, origin FROM tags WHERE name_key = ?").get(tagKey(name)) as
    | Tag
    | undefined;
}

function requireTag(db: Db, name: string): Tag {
  const tag = findTag(db, name);
  if (!tag) throw new Error(`No tag named "${name}". Existing tags: ${vocabulary(db).map((t) => t.name).join(", ") || "none"}.`);
  return tag;
}

export function ensureTag(db: Db, name: string, origin: TagOrigin, description?: string): { tag: Tag; created: boolean } {
  const existing = findTag(db, name);
  if (existing) {
    if (description && description !== existing.description) {
      db.prepare("UPDATE tags SET description = ?, updated_at = ? WHERE id = ?").run(description, now(), existing.id);
      existing.description = description;
    }
    return { tag: existing, created: false };
  }
  const tag: Tag = { id: randomUUID(), name: cleanTagName(name), description: description ?? null, origin };
  const stamp = now();
  db.prepare(
    "INSERT INTO tags (id, name, name_key, description, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(tag.id, tag.name, tagKey(name), tag.description, origin, stamp, stamp);
  return { tag, created: true };
}

/** Tag names and descriptions, for Claude to choose from. */
export function vocabulary(db: Db): Array<{ name: string; description: string | null }> {
  return db.prepare("SELECT name, description FROM tags ORDER BY name COLLATE NOCASE").all().map((r) => ({
    ...r,
  })) as Array<{ name: string; description: string | null }>;
}

export function listTags(db: Db): TagSummary[] {
  return db
    .prepare(`
      SELECT t.name, t.description, t.origin,
             COUNT(s.id) AS total,
             COALESCE(SUM(st.state = 'added'), 0) AS added,
             COALESCE(SUM(st.state = 'confirmed'), 0) AS confirmed,
             COALESCE(SUM(st.state = 'suggested'), 0) AS suggested
      FROM tags t
      LEFT JOIN screenshot_tags st ON st.tag_id = t.id AND st.state != 'rejected'
      LEFT JOIN screenshots s ON s.id = st.screenshot_id AND s.ignored = 0 AND s.missing_since IS NULL
      GROUP BY t.id
      ORDER BY total DESC, t.name COLLATE NOCASE
    `)
    .all()
    .map((r) => ({ ...r })) as unknown as TagSummary[];
}

export function createTags(
  db: Db,
  tags: Array<{ name: string; description?: string }>,
  origin: TagOrigin,
): { created: string[]; existing: string[] } {
  const result = { created: [] as string[], existing: [] as string[] };
  transaction(db, () => {
    for (const t of tags) {
      const { tag, created } = ensureTag(db, t.name, origin, t.description);
      (created ? result.created : result.existing).push(tag.name);
    }
  });
  return result;
}

export interface TagEdit {
  renameTo?: string;
  description?: string;
  mergeInto?: string;
  delete?: boolean;
  confirmSuggestions?: boolean;
  rejectSuggestions?: boolean;
}

/** Rename (merging if the new name exists), describe, merge, delete, or settle suggestions in bulk. */
export function editTag(db: Db, name: string, edit: TagEdit): Record<string, unknown> {
  return transaction(db, () => {
    const tag = requireTag(db, name);
    const stamp = now();
    const result: Record<string, unknown> = { tag: tag.name };

    if (edit.delete) {
      const ids = taggedIds(db, tag.id);
      db.prepare("DELETE FROM tags WHERE id = ?").run(tag.id);
      for (const id of ids) reindexScreenshot(db, id);
      return { deleted: tag.name, screenshots_untagged: ids.length };
    }
    if (edit.description !== undefined) {
      db.prepare("UPDATE tags SET description = ?, updated_at = ? WHERE id = ?").run(edit.description || null, stamp, tag.id);
      result.description = edit.description || null;
    }
    if (edit.confirmSuggestions) {
      const changed = db
        .prepare("UPDATE screenshot_tags SET state = 'confirmed', updated_at = ? WHERE tag_id = ? AND state = 'suggested'")
        .run(stamp, tag.id).changes;
      result.confirmed = Number(changed);
    } else if (edit.rejectSuggestions) {
      const changed = db
        .prepare(
          "UPDATE screenshot_tags SET state = 'rejected', source = 'user', updated_at = ? WHERE tag_id = ? AND state = 'suggested'",
        )
        .run(stamp, tag.id).changes;
      result.rejected = Number(changed);
      reindexTagged(db, tag.id);
    }

    const target = edit.mergeInto ?? edit.renameTo;
    if (target !== undefined) {
      const existing = findTag(db, target);
      if (existing && existing.id !== tag.id) {
        const moved = mergeInto(db, tag, existing);
        result.merged_into = existing.name;
        result.screenshots_moved = moved;
      } else if (edit.mergeInto) {
        throw new Error(`No tag named "${edit.mergeInto}" to merge into.`);
      } else {
        const newName = cleanTagName(target);
        db.prepare("UPDATE tags SET name = ?, name_key = ?, updated_at = ? WHERE id = ?").run(newName, tagKey(newName), stamp, tag.id);
        reindexTagged(db, tag.id);
        result.renamed_to = newName;
      }
    }
    return result;
  });
}

function taggedIds(db: Db, tagId: string): string[] {
  return (
    db.prepare("SELECT screenshot_id FROM screenshot_tags WHERE tag_id = ?").all(tagId) as Array<{ screenshot_id: string }>
  ).map((r) => r.screenshot_id);
}

/** Moves every assignment from `from` to `into`, keeping the stronger state per screenshot. */
function mergeInto(db: Db, from: Tag, into: Tag): number {
  const rows = db.prepare("SELECT * FROM screenshot_tags WHERE tag_id = ?").all(from.id) as Array<Record<string, any>>;
  const existing = db.prepare("SELECT state FROM screenshot_tags WHERE screenshot_id = ? AND tag_id = ?");
  const upsert = db.prepare(`
    INSERT INTO screenshot_tags (screenshot_id, tag_id, state, source, confidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (screenshot_id, tag_id) DO UPDATE SET
      state = excluded.state, source = excluded.source, confidence = excluded.confidence, updated_at = excluded.updated_at
  `);
  const stamp = now();
  for (const row of rows) {
    const current = existing.get(row.screenshot_id, into.id) as { state: TagState } | undefined;
    if (!current || RANK[row.state as TagState] > RANK[current.state]) {
      upsert.run(row.screenshot_id, into.id, row.state, row.source, row.confidence, row.created_at, stamp);
    }
  }
  db.prepare("DELETE FROM tags WHERE id = ?").run(from.id);
  for (const row of rows) reindexScreenshot(db, row.screenshot_id);
  return rows.length;
}

export interface TagChange {
  updated: number;
  created_tags: string[];
  unknown_ids: string[];
}

/**
 * The user's own tagging. Adding confirms a suggestion or adds the tag;
 * removing records a rejection, so Claude won't suggest it again.
 */
export function tagScreenshots(db: Db, ids: string[], change: { add?: string[]; remove?: string[] }): TagChange {
  return transaction(db, () => {
    const result: TagChange = { updated: 0, created_tags: [], unknown_ids: [] };
    const exists = db.prepare("SELECT 1 FROM screenshots WHERE id = ?");
    const current = db.prepare("SELECT state FROM screenshot_tags WHERE screenshot_id = ? AND tag_id = ?");
    const upsert = db.prepare(`
      INSERT INTO screenshot_tags (screenshot_id, tag_id, state, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (screenshot_id, tag_id) DO UPDATE SET
        state = excluded.state, source = excluded.source, updated_at = excluded.updated_at
    `);
    const stamp = now();
    const adds = (change.add ?? []).map((name) => {
      const { tag, created } = ensureTag(db, name, "user");
      if (created) result.created_tags.push(tag.name);
      return tag;
    });
    const removes = (change.remove ?? []).map((name) => findTag(db, name)).filter((t): t is Tag => !!t);

    for (const id of ids) {
      if (!exists.get(id)) {
        result.unknown_ids.push(id);
        continue;
      }
      for (const tag of adds) {
        const row = current.get(id, tag.id) as { state: TagState } | undefined;
        if (row?.state === "added" || row?.state === "confirmed") continue;
        // A suggestion the user accepts stays credited to Claude ('confirmed').
        if (row?.state === "suggested") upsert.run(id, tag.id, "confirmed", "ai", stamp, stamp);
        else upsert.run(id, tag.id, "added", "user", stamp, stamp);
      }
      for (const tag of removes) upsert.run(id, tag.id, "rejected", "user", stamp, stamp);
      reindexScreenshot(db, id);
      result.updated++;
    }
    return result;
  });
}

export interface Suggestion {
  id: string;
  tags: string[];
  confidence?: number;
}

export interface SuggestResult {
  suggested: number;
  /** Already decided by the user (or already suggested), so left alone. */
  skipped: number;
  errors: Array<{ id: string; error: string }>;
}

/**
 * Claude's tag suggestions. Only existing tags can be suggested, and rows the
 * user has touched (including rejections) are never changed. Every id passed
 * is marked as considered for tagging, even with an empty tag list.
 */
export function suggestTags(db: Db, suggestions: Suggestion[]): SuggestResult {
  return transaction(db, () => {
    const result: SuggestResult = { suggested: 0, skipped: 0, errors: [] };
    const exists = db.prepare("SELECT 1 FROM screenshots WHERE id = ?");
    const insert = db.prepare(`
      INSERT INTO screenshot_tags (screenshot_id, tag_id, state, source, confidence, created_at, updated_at)
      VALUES (?, ?, 'suggested', 'ai', ?, ?, ?)
      ON CONFLICT (screenshot_id, tag_id) DO NOTHING
    `);
    const markConsidered = db.prepare("UPDATE screenshots SET ai_tagged_at = ? WHERE id = ?");
    const stamp = now();
    for (const s of suggestions) {
      if (!exists.get(s.id)) {
        result.errors.push({ id: s.id, error: "unknown screenshot id" });
        continue;
      }
      for (const name of s.tags) {
        const tag = findTag(db, name);
        if (!tag) {
          result.errors.push({ id: s.id, error: `no tag named "${name}" (create it first, with the user's OK)` });
          continue;
        }
        const changes = Number(insert.run(s.id, tag.id, s.confidence ?? null, stamp, stamp).changes);
        if (changes) result.suggested++;
        else result.skipped++;
      }
      markConsidered.run(stamp, s.id);
      reindexScreenshot(db, s.id);
    }
    return result;
  });
}

export interface ScreenshotTag {
  name: string;
  state: TagState;
  source: TagSource;
}

export function tagsFor(db: Db, id: string): ScreenshotTag[] {
  return db
    .prepare(`
      SELECT t.name, st.state, st.source FROM screenshot_tags st JOIN tags t ON t.id = st.tag_id
      WHERE st.screenshot_id = ? ORDER BY t.name COLLATE NOCASE
    `)
    .all(id)
    .map((r) => ({ ...r })) as unknown as ScreenshotTag[];
}

export interface TaggingItem {
  id: string;
  file_name: string;
  folder: string | null;
  short_description: string;
  likely_reason_saved: string;
  content_type: string;
  topics: string[];
  tags: string[];
  rejected_tags: string[];
}

/** Analyzed screenshots Claude hasn't yet considered for tags, newest first (text only, no images). */
export function taggingBatch(db: Db, limit: number): { items: TaggingItem[]; remaining: number } {
  const where = `
    s.status = 'analyzed' AND s.ignored = 0 AND s.missing_since IS NULL AND s.ai_tagged_at IS NULL
  `;
  const rows = db
    .prepare(`
      SELECT s.id, s.source_key, COALESCE(u.short_description, a.short_description) AS short_description,
             COALESCE(u.likely_reason_saved, a.likely_reason_saved) AS likely_reason_saved,
             a.content_type, a.topics
      FROM screenshots s JOIN analyses a ON a.screenshot_id = s.id
      LEFT JOIN user_edits u ON u.screenshot_id = s.id
      WHERE ${where}
      ORDER BY s.captured_at DESC LIMIT ?
    `)
    .all(limit) as Array<Record<string, any>>;
  const items = rows.map((r) => {
    const tags = tagsFor(db, r.id);
    const slash = r.source_key.lastIndexOf("/");
    return {
      id: r.id,
      file_name: slash >= 0 ? r.source_key.slice(slash + 1) : r.source_key,
      folder: slash >= 0 ? r.source_key.slice(0, slash) : null,
      short_description: r.short_description,
      likely_reason_saved: r.likely_reason_saved,
      content_type: r.content_type,
      topics: JSON.parse(r.topics),
      tags: tags.filter((t) => t.state !== "rejected").map((t) => t.name),
      rejected_tags: tags.filter((t) => t.state === "rejected").map((t) => t.name),
    };
  });
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM screenshots s WHERE ${where}`).get() as { n: number };
  return { items, remaining: n - items.length };
}

/**
 * Brings Finder-sourced tags in line with the files' current Finder tags.
 * Finder tags become 'added' (upgrading Claude's suggestions); tags removed in
 * Finder are removed here. Decisions the user made inside Memvana Shot win.
 */
export function syncFinderTags(db: Db, finderTags: Map<string, string[]>): { added: number; removed: number } {
  return transaction(db, () => {
    const result = { added: 0, removed: 0 };
    const stamp = now();
    const rowsFor = db.prepare(`
      SELECT st.tag_id, st.state, st.source, t.name_key FROM screenshot_tags st JOIN tags t ON t.id = st.tag_id
      WHERE st.screenshot_id = ?
    `);
    const upsert = db.prepare(`
      INSERT INTO screenshot_tags (screenshot_id, tag_id, state, source, created_at, updated_at)
      VALUES (?, ?, 'added', 'finder', ?, ?)
      ON CONFLICT (screenshot_id, tag_id) DO UPDATE SET state = 'added', source = 'finder', updated_at = excluded.updated_at
    `);
    const remove = db.prepare("DELETE FROM screenshot_tags WHERE screenshot_id = ? AND tag_id = ?");

    for (const [id, names] of finderTags) {
      const rows = rowsFor.all(id) as Array<{ tag_id: string; state: TagState; source: TagSource; name_key: string }>;
      const byKey = new Map(rows.map((r) => [r.name_key, r]));
      const wanted = new Set<string>();
      let changed = false;
      for (const name of names) {
        let key: string;
        try {
          key = tagKey(name);
        } catch {
          continue; // empty or oversized Finder tag
        }
        wanted.add(key);
        const row = byKey.get(key);
        if (row && (row.source === "finder" || row.state === "added" || row.state === "confirmed")) continue;
        if (row && row.state === "rejected") continue;
        const { tag } = ensureTag(db, name, "finder");
        upsert.run(id, tag.id, stamp, stamp);
        result.added++;
        changed = true;
      }
      for (const row of rows) {
        if (row.source === "finder" && !wanted.has(row.name_key)) {
          remove.run(id, row.tag_id);
          result.removed++;
          changed = true;
        }
      }
      if (changed) reindexScreenshot(db, id);
    }
    return result;
  });
}
