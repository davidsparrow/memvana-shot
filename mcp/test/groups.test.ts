import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { resolveHelper } from "../src/config.ts";
import { FakePhotos } from "./fake-photos.ts";
import { REPO_ROOT, type TempLibrary, analyzedLibrary, needsHelper, tempLibrary } from "./helpers.ts";

const RECEIPT = "receipt.jpg";
const CHIPS = "Screenshot 2025-08-03 at 4.15.22 PM.png";
const PICKLEBALL = "window-shadow.png";

let t: TempLibrary | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

/** A library whose Photos holds the receipt, chips and pickleball fixtures as IMG_1001-1003. */
async function photosLibrary(albums: string[][]): Promise<{ t: TempLibrary; photos: FakePhotos; ids: string[] }> {
  const photos = new FakePhotos(resolveHelper({ home: "", pluginRoot: REPO_ROOT })!, "authorized");
  t = tempLibrary({ photos });
  [RECEIPT, CHIPS, PICKLEBALL].forEach((file, i) =>
    photos.add(join(t!.folder, file), `2026-0${i + 1}-02T10:00:00.000Z`, { albums: albums[i] }),
  );
  await t.library.connectPhotos();
  const byName = new Map(t.library.list({ limit: 50 }).map((row) => [row.file, row.id]));
  return { t, photos, ids: ["IMG_1001.PNG", "IMG_1002.PNG", "IMG_1003.PNG"].map((name) => byName.get(name)!) };
}

const files = (results: Array<{ file: string }>) => results.map((r) => r.file).sort();

describe("groups", needsHelper, () => {
  test("Photos albums are searchable, shown to Claude, and count in related screenshots", async () => {
    const { t, ids } = await photosLibrary([["Kitchen remodel"], ["Kitchen remodel", "Snacks/Packaging"], []]);
    const [receipt, chips] = ids;

    assert.deepEqual(files((await t.library.search({ query: "remodel" })).results), ["IMG_1001.PNG", "IMG_1002.PNG"]);
    assert.deepEqual(files((await t.library.search({ query: "packaging" })).results), ["IMG_1002.PNG"]);
    assert.deepEqual(t.library.get(chips!)!.albums, ["Kitchen remodel", "Snacks/Packaging"]);
    assert.deepEqual(t.library.analysisBatch({ ids: [chips!] }).items[0]!.albums, ["Kitchen remodel", "Snacks/Packaging"]);

    const related = t.library.related(receipt!).results.find((r) => r.id === chips);
    assert.ok(related, "sharing an album is enough to be related");
    assert.ok(related.reasons.includes("same album (Kitchen remodel)"));
  });

  test("albums and descriptive folders are listed as groups, and can become tags on the user's yes", async () => {
    const { t, ids } = await photosLibrary([["Kitchen remodel"], ["Kitchen remodel", "Snacks/Packaging"], []]);
    await t.library.scan({ folder: t.folder });

    const groups = t.library.stats().groups;
    assert.deepEqual(groups, [
      { kind: "album", name: "Kitchen remodel", screenshots: 2, analyzed: 0 },
      { kind: "folder", name: "code", screenshots: 1, analyzed: 0 },
      { kind: "album", name: "Snacks/Packaging", screenshots: 1, analyzed: 0 },
    ]);
    assert.equal(t.library.listTags().length, 0, "groups never become tags by themselves");

    const tagged = t.library.tagScreenshots({ album: "kitchen REMODEL" }, { add: ["Kitchen remodel"] });
    assert.equal(tagged.updated, 2);
    assert.deepEqual(t.library.get(ids[1]!)!.tags.map((tag) => [tag.name, tag.state, tag.source]), [
      ["Kitchen remodel", "added", "user"],
    ]);
    t.library.tagScreenshots({ folder: "code" }, { add: ["Code"] });
    const after = t.library.stats().groups;
    assert.equal(after.find((g) => g.name === "Kitchen remodel")?.tag, "Kitchen remodel");
    assert.equal(after.find((g) => g.name === "code")?.tag, "Code");
    assert.equal(after.find((g) => g.name === "Snacks/Packaging")?.tag, undefined);

    assert.throws(() => t.library.tagScreenshots({ album: "Nope" }, { add: ["Nope"] }), /No screenshots in the album "Nope"/);
  });

  test("album changes in Photos update the library without re-extracting", async () => {
    const { t, photos, ids } = await photosLibrary([["Kitchen remodel"], [], []]);
    const extracts = () => photos.calls.filter((call) => call === "extract").length;
    const before = extracts();

    photos.assets[0]!.albums = [];
    photos.assets[2]!.albums = ["Kitchen remodel"];
    await t.library.scan();

    assert.equal(extracts(), before, "nothing was re-extracted");
    assert.deepEqual(files((await t.library.search({ query: "remodel" })).results), ["IMG_1003.PNG"]);
    assert.deepEqual(t.library.get(ids[0]!)!.albums, []);
    assert.equal(t.library.get(ids[0]!)!.status, "extracted");
  });

  test("tagging batches show the folder and albums", async () => {
    t = tempLibrary();
    const ids = await analyzedLibrary(t);
    t.library.createTags([{ name: "Code" }]);
    const item = t.library.taggingBatch(10).items.find((i) => i.id === ids.get("code/IMG_2041.PNG"));
    assert.equal(item?.folder, "code");
    assert.deepEqual(item?.albums, []);
  });
});
