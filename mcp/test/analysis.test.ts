import assert from "node:assert/strict";
import { appendFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { AnalysisInput, normalizeTags } from "../src/analysis.ts";
import { FIXTURE_ANALYSES, type TempLibrary, analyzedLibrary, needsHelper, tempLibrary } from "./helpers.ts";

let t: TempLibrary;
beforeEach(() => {
  t = tempLibrary();
});
afterEach(() => t.cleanup());

const CHIPS = "Screenshot 2025-08-03 at 4.15.22 PM.png";

describe("AnalysisInput schema", () => {
  test("accepts a complete analysis and fills defaults", () => {
    const { entities: _e, keywords: _k, sensitive: _s, ...minimal } = FIXTURE_ANALYSES[CHIPS]!;
    const parsed = AnalysisInput.parse({ id: "x", ...minimal });
    assert.deepEqual(parsed.entities, []);
    assert.deepEqual(parsed.keywords, []);
    assert.equal(parsed.sensitive, false);
  });
  test("rejects unknown content types, empty topics and out-of-range confidence", () => {
    const base = { id: "x", ...FIXTURE_ANALYSES[CHIPS]! };
    assert.throws(() => AnalysisInput.parse({ ...base, content_type: "selfie" }));
    assert.throws(() => AnalysisInput.parse({ ...base, topics: [] }));
    assert.throws(() => AnalysisInput.parse({ ...base, confidence: 1.5 }));
  });
  test("normalizeTags lowercases, trims and dedupes in order", () => {
    assert.deepEqual(normalizeTags(["Food  Packaging", "chips", "food packaging ", ""]), ["food packaging", "chips"]);
  });
});

describe("analysis pipeline", needsHelper, () => {
  test("batches are leased so parallel analysts never overlap", async () => {
    await t.library.scan({ folder: t.folder });
    const first = t.library.analysisBatch({ limit: 3 });
    const second = t.library.analysisBatch({ limit: 3 });
    assert.equal(first.items.length, 3);
    assert.equal(second.items.length, 2);
    const overlap = first.items.filter((i) => second.items.some((j) => j.id === i.id));
    assert.deepEqual(overlap, []);
    assert.equal(t.library.analysisBatch({ limit: 3 }).items.length, 0, "everything is leased");

    // An expired lease is handed out again.
    t.library.db.prepare("UPDATE screenshots SET analysis_claimed_until = '2000-01-01T00:00:00.000Z'").run();
    assert.equal(t.library.analysisBatch({ limit: 12 }).items.length, 5);
  });

  test("batch items carry what Claude needs to analyze", async () => {
    await t.library.scan({ folder: t.folder });
    const { items } = t.library.analysisBatch({ limit: 12 });
    const chips = items.find((i) => i.file_name === CHIPS);
    assert.ok(chips);
    assert.match(chips.ocr_text, /Tortilla Chips/);
    assert.ok(chips.thumb_path?.endsWith(".jpg"));
    assert.ok(chips.labels.length > 0);
    assert.equal(chips.ocr_truncated, false);
  });

  test("saving marks screenshots analyzed and normalizes tags", async () => {
    const ids = await analyzedLibrary(t);
    const status = await t.library.status();
    assert.equal(status.counts.analyzed, 5);
    assert.equal(status.counts.extracted, 0);
    assert.match(status.next_steps.join(" "), /up to date/);

    const chips = t.library.get(ids.get(CHIPS)!)!;
    assert.equal(chips.status, "analyzed");
    assert.deepEqual(chips.analysis?.topics, ["food packaging", "tortilla chips", "organic snacks"]);
    assert.equal(chips.analysis?.model, "test-model");
    assert.equal(chips.analysis?.stale, false);
    assert.equal(t.library.analysisBatch().items.length, 0, "nothing left to analyze");
  });

  test("unknown ids are reported per item without blocking the rest", async () => {
    const ids = await analyzedLibrary(t);
    const result = t.library.saveAnalyses([
      { id: "missing", ...FIXTURE_ANALYSES[CHIPS]! } as AnalysisInput,
      { id: ids.get(CHIPS)!, ...FIXTURE_ANALYSES[CHIPS]!, short_description: "Revised" } as AnalysisInput,
    ]);
    assert.equal(result.saved, 1);
    assert.deepEqual(result.errors, [{ id: "missing", error: "unknown screenshot id" }]);
    assert.equal(t.library.get(ids.get(CHIPS)!)!.analysis?.short_description, "Revised");
  });

  test("ids re-lease analyzed screenshots for a second look", async () => {
    const ids = await analyzedLibrary(t);
    const again = t.library.analysisBatch({ ids: [ids.get("receipt.jpg")!, "nope"] });
    assert.deepEqual(again.items.map((i) => i.file_name), ["receipt.jpg"]);
  });

  test("an edited image needs re-analysis; a merely touched one does not", async () => {
    const ids = await analyzedLibrary(t);

    const touched = join(t.folder, "receipt.jpg");
    utimesSync(touched, new Date(), new Date(Date.now() + 60_000));
    const edited = join(t.folder, CHIPS);
    appendFileSync(edited, Buffer.from([0])); // same pixels to decoders, different bytes
    await t.library.scan();

    assert.equal(t.library.get(ids.get("receipt.jpg")!)!.status, "analyzed");
    const chips = t.library.get(ids.get(CHIPS)!)!;
    assert.equal(chips.status, "extracted");
    assert.equal(chips.analysis?.stale, true, "old analysis is kept but flagged");
  });
});
