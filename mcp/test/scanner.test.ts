import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type Db, getMeta, openDb, schemaVersion } from "../src/db.ts";
import { discoverFolder, ensureFolderSource, reconcileFolder } from "../src/scanner.ts";

let root: string;
let db: Db;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "memvana-shot-scan-"));
  db = openDb(join(root, "library.db"));
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function touch(path: string, content = "x"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

describe("database", () => {
  test("migrates once and keeps a stable library id", () => {
    assert.equal(schemaVersion(db), 1);
    const id = getMeta(db, "library_id");
    assert.match(id ?? "", /^[0-9a-f-]{36}$/);
    db.close();
    db = openDb(join(root, "library.db"));
    assert.equal(getMeta(db, "library_id"), id);
  });
});

describe("discoverFolder", () => {
  test("finds images recursively, skipping hidden files, non-images and library bundles", async () => {
    const shots = join(root, "shots");
    touch(join(shots, "a.png"));
    touch(join(shots, "nested", "b.JPG"));
    touch(join(shots, ".hidden.png"));
    touch(join(shots, ".cache", "c.png"));
    touch(join(shots, "notes.txt"));
    touch(join(shots, "Photos Library.photoslibrary", "originals", "d.heic"));
    const found = (await discoverFolder(shots)).map((f) => f.key).sort();
    assert.deepEqual(found, ["a.png", "nested/b.JPG"]);
  });
});

describe("reconcileFolder", () => {
  test("tracks added, changed, missing and returned files", async () => {
    const shots = join(root, "shots");
    touch(join(shots, "a.png"));
    touch(join(shots, "b.png"));
    const source = ensureFolderSource(db, shots);
    assert.equal(ensureFolderSource(db, shots).id, source.id, "registering twice reuses the source");

    let r = reconcileFolder(db, source, await discoverFolder(shots));
    assert.deepEqual(r, { discovered: 2, added: 2, changed: 0, returned: 0, missing: 0 });

    r = reconcileFolder(db, source, await discoverFolder(shots));
    assert.deepEqual(r, { discovered: 2, added: 0, changed: 0, returned: 0, missing: 0 }, "rescan is a no-op");

    db.prepare("UPDATE screenshots SET status = 'extracted'").run();
    touch(join(shots, "a.png"), "different and longer");
    utimesSync(join(shots, "a.png"), new Date(), new Date(Date.now() + 5000));
    rmSync(join(shots, "b.png"));
    r = reconcileFolder(db, source, await discoverFolder(shots));
    assert.equal(r.changed, 1);
    assert.equal(r.missing, 1);

    const rows = db.prepare("SELECT source_key, status, missing_since FROM screenshots ORDER BY source_key").all() as Array<
      Record<string, string | null>
    >;
    assert.equal(rows[0]?.status, "pending", "changed file is re-queued");
    assert.ok(rows[1]?.missing_since, "vanished file is marked missing, not deleted");

    touch(join(shots, "b.png"));
    r = reconcileFolder(db, source, await discoverFolder(shots));
    assert.equal(r.changed + r.returned, 1, "a file that comes back is restored");
    const b = db.prepare("SELECT missing_since FROM screenshots WHERE source_key = 'b.png'").get() as {
      missing_since: string | null;
    };
    assert.equal(b.missing_since, null);
  });
});
