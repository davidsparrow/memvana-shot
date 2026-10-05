import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import { openDb } from "../src/db.ts";
import { migrations } from "../src/migrations.ts";
import { buildMatchExpression, normalizeDateBound } from "../src/search.ts";
import { type TempLibrary, analyzedLibrary, needsHelper, tempLibrary } from "./helpers.ts";

describe("buildMatchExpression", () => {
  test("drops filler words and quotes every term", () => {
    assert.equal(
      buildMatchExpression("find that screenshot of the interesting packaging I saved"),
      '"interesting" OR "packaging"',
    );
  });
  test("keeps quoted phrases and multi-word expansions as phrases", () => {
    assert.equal(
      buildMatchExpression('"pour over" receipt', ["coffee gear", "brewing"]),
      '"pour over" OR "receipt" OR "coffee gear" OR "brewing"',
    );
  });
  test("neutralizes FTS syntax in user text", () => {
    assert.equal(buildMatchExpression('chips* NEAR(a b) -salt "unclosed'), '"chips" OR "near" OR "salt" OR "unclosed"');
    assert.equal(buildMatchExpression("Spuds & Cheese's"), '"spuds" OR "cheese"');
  });
  test("returns undefined when nothing searchable remains", () => {
    assert.equal(buildMatchExpression("show me the screenshots"), undefined);
    assert.equal(buildMatchExpression(""), undefined);
  });
  test("keeps numbers", () => {
    assert.equal(buildMatchExpression("order 4417"), '"order" OR "4417"');
  });
});

describe("normalizeDateBound", () => {
  test("partial dates are local midnight at the start of the period", () => {
    assert.equal(normalizeDateBound("2025-03"), new Date("2025-03-01T00:00:00").toISOString());
    assert.equal(normalizeDateBound("2025"), new Date("2025-01-01T00:00:00").toISOString());
    assert.equal(normalizeDateBound("2025-02-14T17:30:00Z"), "2025-02-14T17:30:00.000Z");
    assert.throws(() => normalizeDateBound("last spring"), /Unrecognized date/);
  });
});

describe("search", needsHelper, () => {
  let t: TempLibrary;
  beforeEach(() => {
    t = tempLibrary();
  });
  afterEach(() => t.cleanup());

  test("finds screenshots by concept even when the word isn't in the image", async () => {
    await analyzedLibrary(t);
    const result = t.library.search({ query: "packaging inspiration" });
    assert.equal(result.results[0]?.file, "Screenshot 2025-08-03 at 4.15.22 PM.png");
    assert.match(result.results[0]?.match ?? "", /«packaging»/i);
    assert.equal(result.unanalyzed_in_library, 0);
  });

  test("expansion terms widen recall and stemming matches word forms", async () => {
    await analyzedLibrary(t);
    const narrow = t.library.search({ query: "barista" });
    assert.equal(narrow.total, 0);
    const expanded = t.library.search({ query: "barista", also: ["coffee", "brewing"] });
    assert.equal(expanded.results[0]?.file, "receipt.jpg");
    assert.equal(t.library.search({ query: "brews" }).results[0]?.file, "receipt.jpg", "porter stemming");
  });

  test("descriptive folder and file names are searchable; auto names are not", async () => {
    mkdirSync(join(t.folder, "Ideas"));
    copyFileSync(join(t.folder, "nothing-here.png"), join(t.folder, "Ideas", "SageGreenKitchenCabinets.png"));
    await t.library.scan({ folder: t.folder });
    assert.equal(t.library.search({ query: "kitchen cabinets" }).results[0]?.file, "Ideas/SageGreenKitchenCabinets.png");
    assert.equal(t.library.search({ query: "ideas" }).results[0]?.file, "Ideas/SageGreenKitchenCabinets.png");
    assert.equal(t.library.search({ query: "img" }).total, 0, "IMG_2041 contributes no name terms");
  });

  test("OCR text is searchable before analysis", async () => {
    await t.library.scan({ folder: t.folder });
    const result = t.library.search({ query: "PHAsset" });
    assert.equal(result.results[0]?.file, "code/IMG_2041.PNG");
    assert.equal(result.results[0]?.analyzed, false);
    assert.equal(result.unanalyzed_in_library, 5);
  });

  test("filters by content type and capture date", async () => {
    await analyzedLibrary(t);
    assert.deepEqual(
      t.library.search({ contentType: "code" }).results.map((r) => r.file),
      ["code/IMG_2041.PNG"],
    );
    const feb2025 = t.library.search({ after: "2025-02", before: "2025-03" });
    assert.deepEqual(feb2025.results.map((r) => r.file), ["receipt.jpg"]);
    const before2026 = t.library.search({ query: "order chips", before: "2026" });
    assert.deepEqual(before2026.results.map((r) => r.file).sort(), ["Screenshot 2025-08-03 at 4.15.22 PM.png", "receipt.jpg"]);
  });

  test("ignored and missing screenshots stay out of results", async () => {
    const ids = await analyzedLibrary(t);
    t.library.db.prepare("UPDATE screenshots SET ignored = 1 WHERE id = ?").run(ids.get("receipt.jpg")!);
    assert.equal(t.library.search({ query: "coffee" }).total, 0);
  });

  test("stats summarize what the user has been saving", async () => {
    await analyzedLibrary(t);
    const stats = t.library.stats();
    assert.equal(stats.totals.screenshots, 5);
    assert.equal(stats.totals.analyzed, 5);
    assert.deepEqual(stats.top_topics[0], { topic: "blank", count: 1 }, "ties sort alphabetically");
    assert.ok(stats.content_types.some((c) => c.content_type === "code" && c.count === 1));
    assert.ok(stats.top_entities.some((e) => e.name === "PhotoKit" && e.type === "technology"));
    assert.deepEqual(stats.top_source_apps, [{ source_app: "Xcode", count: 1 }]);
    const ranged = t.library.stats({ after: "2025-02", before: "2025-03" });
    assert.equal(ranged.totals.screenshots, 1);
    assert.deepEqual(ranged.by_month.map((m) => m.month), ["2025-02"]);
  });
});

describe("migration 2", () => {
  test("backfills the search index for libraries extracted under schema v1", () => {
    const root = mkdtempSync(join(tmpdir(), "memvana-shot-migrate-"));
    try {
      const path = join(root, "library.db");
      const old = new DatabaseSync(path);
      old.exec(migrations[0]!.sql);
      old.exec(`
        INSERT INTO meta VALUES ('schema_version', '1');
        INSERT INTO sources VALUES ('src', 'folder', '/tmp/x', 'x', '2025-01-01', NULL);
        INSERT INTO screenshots (id, source_id, source_key, discovered_at, status)
          VALUES ('shot', 'src', 'menu.png', '2025-01-01', 'extracted');
        INSERT INTO extractions (screenshot_id, ocr_text, engine, extracted_at)
          VALUES ('shot', 'Seasonal ramen menu', 'test', '2025-01-01');
      `);
      old.close();

      const db = openDb(path);
      const hits = db
        .prepare(
          "SELECT s.id FROM search_index JOIN screenshots s ON s.search_rowid = search_index.rowid WHERE search_index MATCH 'ramen'",
        )
        .all()
        .map((row) => ({ ...row }));
      assert.deepEqual(hits, [{ id: "shot" }]);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
