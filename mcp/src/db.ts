import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { migrations } from "./migrations.ts";
import { nameTerms } from "./names.ts";
import { ensureSearchIndex } from "./search-index.ts";

export type Db = DatabaseSync;

// Loaded lazily (not a static import) so an old Node gets a readable error
// from assertNodeVersion instead of a module-linking failure.
function sqlite(): typeof import("node:sqlite") {
  const mod = process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined;
  if (!mod) throw new Error("This Node.js has no node:sqlite module; Memvana Shot needs Node 22.13+.");
  return mod;
}

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new (sqlite().DatabaseSync)(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  // Used by the search index (and its migrations) to index meaningful name words.
  db.function("name_terms", { deterministic: true }, (key) => nameTerms(String(key ?? "")));
  migrate(db);
  ensureSearchIndex(db);
  return db;
}

export function schemaVersion(db: Db): number {
  const hasMeta = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  if (!hasMeta) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}

function migrate(db: Db): void {
  const current = schemaVersion(db);
  for (const m of migrations) {
    if (m.version <= current) continue;
    transaction(db, () => {
      db.exec(m.sql);
      if (m.version === 1) {
        // A library id lets other tools recognise this exact library later.
        db.prepare("INSERT INTO meta (key, value) VALUES ('library_id', ?), ('created_at', ?)").run(
          randomUUID(),
          new Date().toISOString(),
        );
      }
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ).run(String(m.version));
    });
  }
}

const depth = new WeakMap<Db, number>();

/** Runs fn in a transaction. Nested calls join the outer transaction. */
export function transaction<T>(db: Db, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  if (level > 0) {
    depth.set(db, level + 1);
    try {
      return fn();
    } finally {
      depth.set(db, level);
    }
  }
  db.exec("BEGIN IMMEDIATE");
  depth.set(db, 1);
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    depth.set(db, 0);
  }
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function now(): string {
  return new Date().toISOString();
}
