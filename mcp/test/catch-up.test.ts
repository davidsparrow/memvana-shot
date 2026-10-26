import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { dbPath, resolveHelper } from "../src/config.ts";
import { setMeta } from "../src/db.ts";
import { Library } from "../src/library.ts";
import { runSessionStart, sessionContext } from "../src/session-start.ts";
import { FakePhotos } from "./fake-photos.ts";
import { REPO_ROOT, type TempLibrary, needsHelper, tempLibrary } from "./helpers.ts";

const RECEIPT = "receipt.jpg";

let t: TempLibrary | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

describe("extraction claims", needsHelper, () => {
  test("two processes extracting at once never take the same screenshots", async () => {
    t = tempLibrary();
    await t.library.scan({ folder: t.folder, extractLimit: 0 });
    const other = Library.open(t.config, { photos: null });
    try {
      const [a, b] = await Promise.all([t.library.scan({ readyForAnalysis: 5 }), other.scan({ readyForAnalysis: 5 })]);
      assert.ok("processed" in a.extraction && "processed" in b.extraction);
      assert.equal(a.extraction.processed + b.extraction.processed, 5, "each screenshot was extracted once");
      assert.equal((await t.library.status()).counts.extracted, 5);
    } finally {
      other.close();
    }
  });

  test("a screenshot claimed elsewhere is left alone until the claim runs out", async () => {
    t = tempLibrary();
    await t.library.scan({ folder: t.folder, extractLimit: 0 });
    const claimed = t.library.list({ limit: 1 })[0]!.id;
    const claim = (until: Date) =>
      t!.library.db.prepare("UPDATE screenshots SET extract_claimed_until = ? WHERE id = ?").run(until.toISOString(), claimed);

    claim(new Date(Date.now() + 60_000));
    const first = await t.library.scan({ readyForAnalysis: 5 });
    assert.ok("processed" in first.extraction);
    assert.equal(first.extraction.processed, 4);
    assert.equal(first.extracting_elsewhere, 1);
    assert.match(first.next ?? "", /1 screenshots are being extracted in the background/);

    claim(new Date(Date.now() - 1000)); // the other process died
    const second = await t.library.scan({ readyForAnalysis: 5 });
    assert.ok("processed" in second.extraction);
    assert.equal(second.extraction.processed, 1);
    assert.equal(second.extracting_elsewhere, undefined);
  });
});

describe("session-start catch-up", needsHelper, () => {
  test("extracts only screenshots that are new since setup, and says so next session", async () => {
    t = tempLibrary();
    await t.library.scan({ folder: t.folder, extractLimit: 2 }); // the user chose to prepare 2 of 5
    assert.equal(sessionContext(dbPath(t.config)), undefined, "nothing new yet");

    copyFileSync(join(t.folder, RECEIPT), join(t.folder, "new receipt.jpg"));
    const result = await t.library.catchUp();
    assert.equal(result.sources[0]?.added, 1);
    assert.equal(result.extracted, 1, "the new screenshot, not the backlog");
    assert.equal(result.new_waiting, 1);
    assert.ok(result.finished_at);

    const status = await t.library.status();
    assert.equal(status.counts.pending, 3, "the backlog stays as the user left it");
    assert.equal(status.new_screenshots_waiting, 1);
    assert.deepEqual({ ...status.catch_up, started_at: "", finished_at: "" }, { started_at: "", finished_at: "", found: 1, extracted: 1 });
    assert.match(status.next_steps.join(" "), /1 of them new since setup; mention them, and analyze only after a yes/);
    assert.match(sessionContext(dbPath(t.config)) ?? "", /^Memvana Shot: 1 new screenshot is ready to analyze .* Analyze only after they agree\.$/);
  });

  test("never asks for Photos access, and skips Photos without it", async () => {
    const photos = new FakePhotos(resolveHelper({ home: "", pluginRoot: REPO_ROOT })!, "authorized");
    t = tempLibrary({ photos });
    photos.add(join(t.folder, RECEIPT), "2026-01-02T10:00:00.000Z");
    await t.library.connectPhotos();
    photos.authorization = "not_determined"; // as if the permission were reset
    photos.calls.length = 0;

    const result = await t.library.catchUp();
    assert.deepEqual(photos.calls, ["list"]);
    assert.equal(result.sources[0]?.unavailable, true);
  });

  test("runs one at a time, unless the running one has died", async () => {
    t = tempLibrary();
    await t.library.scan({ folder: t.folder });
    setMeta(t.library.db, "catch_up", JSON.stringify({ started_at: new Date().toISOString(), sources: [], extracted: 0, new_waiting: 0 }));
    assert.equal((await t.library.catchUp()).skipped, "another catch-up is running");

    const long_ago = new Date(Date.now() - 60 * 60_000).toISOString();
    setMeta(t.library.db, "catch_up", JSON.stringify({ started_at: long_ago, sources: [], extracted: 0, new_waiting: 0 }));
    assert.equal((await t.library.catchUp()).skipped, undefined);
  });

  test("the hook stays quiet without a library, and starts the catch-up with one", async () => {
    const empty = mkdtempSync(join(tmpdir(), "memvana-shot-no-library-"));
    try {
      const started: string[] = [];
      const start = (cli: string) => void started.push(cli);
      assert.equal(runSessionStart({ home: join(empty, "home"), pluginRoot: REPO_ROOT }, start), undefined);
      assert.deepEqual(started, [], "no library is created or scanned for someone who never set one up");

      t = tempLibrary();
      await t.library.scan({ folder: t.folder });
      assert.equal(runSessionStart(t.config, start), undefined);
      assert.deepEqual(started, [join(REPO_ROOT, "mcp", "dist", "cli.mjs")]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
