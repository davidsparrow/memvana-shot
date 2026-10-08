import assert from "node:assert/strict";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type TempLibrary, needsHelper, tempLibrary } from "./helpers.ts";

let t: TempLibrary;
beforeEach(() => {
  t = tempLibrary();
});
afterEach(() => t.cleanup());

const byFile = (t: TempLibrary, file: string) => {
  const row = t.library.list({ limit: 200, includeMissing: true }).find((r) => r.file === file);
  assert.ok(row, `expected ${file} in library`);
  return t.library.get(row.id)!;
};

describe("Library.scan", needsHelper, () => {
  test("indexes a folder end to end", async () => {
    const summary = await t.library.scan({ folder: t.folder });
    assert.equal(summary.sources[0]?.added, 5);
    assert.ok("succeeded" in summary.extraction);
    assert.equal(summary.extraction.succeeded, 5);
    assert.equal(summary.remaining_pending, 0);

    const chips = byFile(t, "Screenshot 2025-08-03 at 4.15.22 PM.png");
    assert.equal(chips.status, "extracted");
    assert.match(chips.ocr?.text ?? "", /Tortilla Chips/);
    assert.equal(chips.captured_at_source, "filename");
    assert.equal(chips.width, 600);
    assert.equal(chips.height, 900);
    assert.match(chips.content_hash ?? "", /^[0-9a-f]{64}$/);
    assert.ok(chips.thumb_path && existsSync(chips.thumb_path), "thumbnail written");

    const receipt = byFile(t, "receipt.jpg");
    assert.equal(receipt.captured_at, "2025-02-14T17:30:00.000Z");
    assert.equal(receipt.captured_at_source, "exif");
    assert.equal(receipt.source_device, "iPhone 15 Pro");
    assert.equal(receipt.metadata.exifUserComment, "Screenshot");

    const blank = byFile(t, "nothing-here.png");
    assert.equal(blank.ocr?.text, "");

    const status = await t.library.status();
    assert.equal(status.counts.extracted, 5);
    assert.equal(status.sources[0]?.screenshots, 5);
  });

  test("rescanning does no work when nothing changed", async () => {
    await t.library.scan({ folder: t.folder });
    const again = await t.library.scan();
    assert.equal(again.sources[0]?.added, 0);
    assert.ok("processed" in again.extraction);
    assert.equal(again.extraction.processed, 0);
  });

  test("a renamed or moved file keeps its id", async () => {
    await t.library.scan({ folder: t.folder });
    const before = byFile(t, "receipt.jpg");
    renameSync(join(t.folder, "receipt.jpg"), join(t.folder, "code", "order-receipt.jpg"));

    const summary = await t.library.scan();
    assert.equal(summary.sources[0]?.missing, 1);
    assert.ok("relinked" in summary.extraction);
    assert.equal(summary.extraction.relinked, 1);

    const after = byFile(t, "code/order-receipt.jpg");
    assert.equal(after.id, before.id);
    assert.equal(after.missing_since, null);
    assert.equal(t.library.list({ limit: 200, includeMissing: true }).length, 5, "no duplicate record");
  });

  test("a deleted file is kept but marked missing", async () => {
    await t.library.scan({ folder: t.folder });
    rmSync(join(t.folder, "window-shadow.png"));
    await t.library.scan();
    assert.equal(t.library.list({ limit: 200 }).length, 4);
    assert.ok(byFile(t, "window-shadow.png").missing_since);
  });

  test("an unavailable folder is reported, not emptied", async () => {
    await t.library.scan({ folder: t.folder });
    const parked = t.folder + "-unplugged";
    renameSync(t.folder, parked);
    const summary = await t.library.scan();
    assert.equal(summary.sources[0]?.unavailable, true);
    assert.equal(t.library.list({ limit: 200 }).length, 5, "nothing marked missing");
    renameSync(parked, t.folder);
  });

  test("extract_limit processes large backlogs in batches", async () => {
    const first = await t.library.scan({ folder: t.folder, extractLimit: 2 });
    assert.ok("processed" in first.extraction);
    assert.equal(first.extraction.processed, 2);
    assert.equal(first.remaining_pending, 3);
    assert.match(first.next ?? "", /3 screenshots still need/);

    const discoverOnly = await t.library.scan({ extractLimit: 0 });
    assert.deepEqual(discoverOnly.extraction, { skipped: "extract_limit is 0" });

    const rest = await t.library.scan();
    assert.equal(rest.remaining_pending, 0);
  });
});

describe("Library without a helper", () => {
  test("still discovers files and explains how to build the helper", async () => {
    t.library.config.helperPath = join(t.folder, "no-such-helper");
    const summary = await t.library.scan({ folder: t.folder });
    assert.equal(summary.sources[0]?.added, 5);
    assert.match(JSON.stringify(summary.extraction), /not built/);
    const status = await t.library.status();
    assert.equal(status.helper.available, false);
    assert.equal(status.counts.pending, 5);
  });

  test("scan without sources asks for a folder or Photos", async () => {
    await assert.rejects(t.library.scan(), /No screenshot sources yet. Connect Photos with connect_photos, or call again with `folder`/);
    await assert.rejects(t.library.scan({ folder: join(t.folder, "nope") }), /Not a folder/);
  });
});
