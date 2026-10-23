// The user's own groupings: Photos albums, and descriptively named folders
// inside a screenshot folder ("Recipes/", "Kitchen remodel/Tiles/"). Many
// people never sort their screenshots, so nothing depends on these. When they
// exist, Claude offers them as tags, and only the user's yes turns one into a tag.

import { dirname } from "node:path";
import type { Db } from "./db.ts";
import { nameTerms, parseAlbums } from "./names.ts";
import { tagKey } from "./tags.ts";

export interface Group {
  kind: "album" | "folder";
  /** The album ("Trips/Japan" for one in an album folder) or folder path inside its source. */
  name: string;
  screenshots: number;
  analyzed: number;
  /** An existing tag with the same name as the group (its last part), if any. */
  tag?: string;
}

export type GroupSelector = { album: string } | { folder: string };

interface Row {
  id: string;
  source_key: string;
  photo_asset_id: string | null;
  albums: string | null;
  status: string;
}

const PRESENT = "s.ignored = 0 AND s.missing_since IS NULL";

function rows(db: Db, range: { after?: string | null; before?: string | null } = {}): Row[] {
  return db
    .prepare(`
      SELECT s.id, s.source_key, s.photo_asset_id, s.albums, s.status FROM screenshots s
      WHERE ${PRESENT}
        AND (:after IS NULL OR s.captured_at >= :after)
        AND (:before IS NULL OR s.captured_at < :before)
        AND (s.albums IS NOT NULL OR (s.photo_asset_id IS NULL AND instr(s.source_key, '/') > 0))
    `)
    .all({ after: range.after ?? null, before: range.before ?? null }) as unknown as Row[];
}

/** A folder screenshot's folder, when its name means something ("Recipes", not "2024"). */
function folderOf(row: Row): string | undefined {
  if (row.photo_asset_id) return undefined;
  const folder = dirname(row.source_key);
  return folder !== "." && nameTerms(folder) ? folder : undefined;
}

/** The user's albums and descriptive folders, largest first. */
export function listGroups(db: Db, range: { after?: string | null; before?: string | null } = {}, top = 20): Group[] {
  const groups = new Map<string, Group>();
  const count = (kind: Group["kind"], name: string, row: Row) => {
    const key = `${kind}\n${name.toLowerCase()}`;
    const group = groups.get(key) ?? { kind, name, screenshots: 0, analyzed: 0 };
    group.screenshots++;
    if (row.status === "analyzed") group.analyzed++;
    groups.set(key, group);
  };
  for (const row of rows(db, range)) {
    for (const album of parseAlbums(row.albums)) count("album", album, row);
    const folder = folderOf(row);
    if (folder) count("folder", folder, row);
  }
  const tags = new Map(
    (db.prepare("SELECT name, name_key FROM tags").all() as Array<{ name: string; name_key: string }>).map((t) => [
      t.name_key,
      t.name,
    ]),
  );
  return [...groups.values()]
    .sort((a, b) => b.screenshots - a.screenshots || a.name.localeCompare(b.name))
    .slice(0, top)
    .map((group) => {
      const tag = tags.get(safeKey(group.name.split("/").at(-1)!)) ?? tags.get(safeKey(group.name));
      return tag ? { ...group, tag } : group;
    });
}

/** The screenshots in one album or folder (names match case-insensitively). */
export function groupMembers(db: Db, selector: GroupSelector): string[] {
  const wanted = ("album" in selector ? selector.album : selector.folder).trim().toLowerCase();
  return rows(db)
    .filter((row) =>
      "album" in selector
        ? parseAlbums(row.albums).some((album) => album.toLowerCase() === wanted)
        : folderOf(row)?.toLowerCase() === wanted,
    )
    .map((row) => row.id);
}

function safeKey(name: string): string {
  try {
    return tagKey(name);
  } catch {
    return ""; // too long or empty to be a tag name
  }
}
