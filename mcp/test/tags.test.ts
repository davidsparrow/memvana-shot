import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { AnalysisInput } from "../src/analysis.ts";
import { FIXTURE_ANALYSES, type TempLibrary, analyzedLibrary, needsHelper, tempLibrary } from "./helpers.ts";

let t: TempLibrary;
let ids: Map<string, string>;
beforeEach(() => {
  t = tempLibrary();
});
afterEach(() => t.cleanup());

const CHIPS = "Screenshot 2025-08-03 at 4.15.22 PM.png";
const RECEIPT = "receipt.jpg";
const CODE = "code/IMG_2041.PNG";

const tagStates = (file: string) =>
  Object.fromEntries(t.library.get(ids.get(file)!)!.tags.map((tag) => [tag.name, `${tag.state}/${tag.source}`]));

function setFinderTags(path: string, tags: string[]): void {
  const plist =
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><array>' +
    tags.map((tag) => `<string>${tag}</string>`).join("") +
    "</array></plist>";
  if (tags.length) execFileSync("xattr", ["-w", "com.apple.metadata:_kMDItemUserTags", plist, path]);
  else execFileSync("xattr", ["-d", "com.apple.metadata:_kMDItemUserTags", path]);
}

describe("tags", needsHelper, () => {
  beforeEach(async () => {
    ids = await analyzedLibrary(t);
  });

  test("the user's decisions outrank Claude's suggestions", () => {
    t.library.createTags([
      { name: "Food Ideas", description: "Food products, packaging and recipes worth remembering" },
      { name: "Receipts", description: "Proof of purchase" },
    ]);

    // Claude suggests; the user confirms one and rejects another.
    const suggested = t.library.suggestTags([
      { id: ids.get(CHIPS)!, tags: ["food ideas"] },
      { id: ids.get(RECEIPT)!, tags: ["Receipts", "Food Ideas"] },
    ]);
    assert.equal(suggested.suggested, 3);
    t.library.tagScreenshots([ids.get(RECEIPT)!], { add: ["receipts"], remove: ["Food Ideas"] });
    assert.deepEqual(tagStates(RECEIPT), { "Food Ideas": "rejected/user", Receipts: "confirmed/ai" });

    // A rejection sticks: Claude can't re-suggest it.
    const again = t.library.suggestTags([{ id: ids.get(RECEIPT)!, tags: ["Food Ideas"] }]);
    assert.deepEqual([again.suggested, again.skipped], [0, 1]);
    assert.equal(tagStates(RECEIPT)["Food Ideas"], "rejected/user");

    // The user can still add it back deliberately; unknown tags are created.
    const change = t.library.tagScreenshots([ids.get(RECEIPT)!, "nope"], { add: ["Food Ideas", "Coffee"] });
    assert.deepEqual(change.created_tags, ["Coffee"]);
    assert.deepEqual(change.unknown_ids, ["nope"]);
    assert.equal(tagStates(RECEIPT)["Food Ideas"], "added/user");

    const counts = Object.fromEntries(t.library.listTags().map((tag) => [tag.name, [tag.total, tag.suggested]]));
    assert.deepEqual(counts, { "Food Ideas": [2, 1], Coffee: [1, 0], Receipts: [1, 0] });
  });

  test("Claude can only suggest existing tags, and every considered screenshot is marked", () => {
    t.library.createTags([{ name: "Dev" }]);
    assert.equal(t.library.taggingBatch().items.length, 5);
    const result = t.library.suggestTags([
      { id: ids.get(CODE)!, tags: ["Dev", "Invented"] },
      { id: ids.get(CHIPS)!, tags: [] },
    ]);
    assert.equal(result.suggested, 1);
    assert.match(result.errors[0]!.error, /no tag named "Invented"/);
    const remaining = t.library.taggingBatch().items.map((i) => i.file_name);
    assert.ok(!remaining.includes("IMG_2041.PNG") && !remaining.includes(CHIPS));
    assert.equal(remaining.length, 3);
  });

  test("tags are searchable, filterable and shown on results", () => {
    t.library.createTags([{ name: "Kitchen remodel" }]);
    t.library.tagScreenshots([ids.get(RECEIPT)!], { add: ["Kitchen remodel"] });
    t.library.suggestTags([{ id: ids.get(CHIPS)!, tags: ["Kitchen remodel"] }]);

    const byText = t.library.search({ query: "remodel" });
    assert.deepEqual(byText.results.map((r) => r.file).sort(), [CHIPS, RECEIPT].sort());
    const filtered = t.library.search({ tags: ["kitchen remodel"] });
    assert.equal(filtered.total, 2);
    const receipt = filtered.results.find((r) => r.file === RECEIPT)!;
    assert.deepEqual([receipt.tags, receipt.suggested_tags], [["Kitchen remodel"], []]);
    const chips = filtered.results.find((r) => r.file === CHIPS)!;
    assert.deepEqual([chips.tags, chips.suggested_tags], [[], ["Kitchen remodel"]]);
    assert.equal(t.library.search({ untagged: true }).total, 3);
  });

  test("rename, merge, bulk-confirm and delete", () => {
    t.library.createTags([{ name: "Food" }, { name: "Recipes" }]);
    t.library.tagScreenshots([ids.get(CHIPS)!], { add: ["Food"] });
    t.library.suggestTags([{ id: ids.get(RECEIPT)!, tags: ["Food"] }, { id: ids.get(CHIPS)!, tags: ["Recipes"] }]);

    t.library.editTag("food", { renameTo: "Snacks" });
    assert.deepEqual(tagStates(CHIPS), { Recipes: "suggested/ai", Snacks: "added/user" });
    assert.equal(t.library.search({ query: "snacks", tags: ["Snacks"] }).total, 2);

    // Renaming onto an existing tag merges, keeping the stronger state.
    const merged = t.library.editTag("Snacks", { renameTo: "recipes" });
    assert.equal(merged.merged_into, "Recipes");
    assert.deepEqual(tagStates(CHIPS), { Recipes: "added/user" });
    assert.deepEqual(tagStates(RECEIPT), { Recipes: "suggested/ai" });

    assert.equal(t.library.editTag("Recipes", { confirmSuggestions: true }).confirmed, 1);
    assert.equal(tagStates(RECEIPT).Recipes, "confirmed/ai");

    const deleted = t.library.editTag("Recipes", { delete: true });
    assert.equal(deleted.screenshots_untagged, 2);
    assert.deepEqual(t.library.listTags(), []);
    assert.equal(t.library.search({ query: "recipes" }).total, 0);
    assert.throws(() => t.library.editTag("Recipes", { delete: true }), /No tag named/);
  });

  test("analyses carry tag suggestions once a vocabulary exists", () => {
    t.library.createTags([{ name: "Coffee" }]);
    const result = t.library.saveAnalyses([
      AnalysisInput.parse({ id: ids.get(RECEIPT)!, ...FIXTURE_ANALYSES[RECEIPT]!, tags: ["Coffee", "Nope"] }),
    ]);
    assert.equal(result.tags_suggested, 1);
    assert.equal(result.tag_errors?.length, 1);
    assert.equal(tagStates(RECEIPT).Coffee, "suggested/ai");
  });

  test("Finder tags are imported, and removed when removed in Finder", async () => {
    const receiptPath = join(t.folder, RECEIPT);
    const chipsPath = join(t.folder, CHIPS);
    t.library.createTags([{ name: "Pantry" }]);
    t.library.suggestTags([{ id: ids.get(CHIPS)!, tags: ["Pantry"] }]);
    t.library.tagScreenshots([ids.get(RECEIPT)!], { remove: ["Pantry"] });

    setFinderTags(receiptPath, ["Receipts", "Red", "Pantry"]);
    setFinderTags(chipsPath, ["pantry"]);
    const summary = await t.library.scan();
    assert.deepEqual(summary.finder_tags, { added: 3, removed: 0 });
    assert.deepEqual(tagStates(RECEIPT), {
      Pantry: "rejected/user", // a decision made in Memvana Shot wins
      Receipts: "added/finder",
      Red: "added/finder",
    });
    assert.deepEqual(tagStates(CHIPS), { Pantry: "added/finder" }, "a Finder tag upgrades a suggestion");

    setFinderTags(receiptPath, ["Receipts"]);
    const after = await t.library.scan();
    assert.deepEqual(after.finder_tags, { added: 0, removed: 1 });
    assert.deepEqual(Object.keys(tagStates(RECEIPT)).sort(), ["Pantry", "Receipts"]);
    const finderTag = t.library.listTags().find((tag) => tag.name === "Receipts");
    assert.equal(finderTag?.origin, "finder");
  });
});

describe("user edits", needsHelper, () => {
  beforeEach(async () => {
    ids = await analyzedLibrary(t);
  });

  test("edits override Claude, are searchable, and survive re-analysis", () => {
    const id = ids.get(CHIPS)!;
    const edited = t.library.edit(id, {
      short_description: "Spuds & Cheese competitor bag",
      notes: "Ask the co-packer about this bag structure",
      add_keywords: ["Co-Packer"],
      remove_keywords: ["grocery"],
    })!;
    assert.equal(edited.details?.short_description, "Spuds & Cheese competitor bag");
    assert.equal(edited.analysis?.short_description, FIXTURE_ANALYSES[CHIPS]!.short_description, "AI value kept");
    assert.ok(edited.details?.keywords.includes("co-packer"));
    assert.ok(!edited.details?.keywords.includes("grocery"));

    assert.equal(t.library.search({ query: "spuds" }).results[0]?.file, CHIPS);
    assert.equal(t.library.search({ query: "spuds" }).results[0]?.short_description, "Spuds & Cheese competitor bag");
    assert.equal(t.library.search({ query: "spuds" }).results[0]?.edited, true);
    assert.equal(t.library.search({ query: "packer structure" }).results[0]?.file, CHIPS, "notes are indexed");
    assert.equal(t.library.search({ query: "grocery" }).total, 0, "removed keyword no longer matches");

    t.library.saveAnalyses([AnalysisInput.parse({ id, ...FIXTURE_ANALYSES[CHIPS]!, short_description: "Re-analyzed" })]);
    const after = t.library.get(id)!;
    assert.equal(after.analysis?.short_description, "Re-analyzed");
    assert.equal(after.details?.short_description, "Spuds & Cheese competitor bag", "user edit still wins");

    const reverted = t.library.edit(id, { short_description: null, notes: "", remove_keywords: ["co-packer"], add_keywords: ["grocery"] })!;
    assert.equal(reverted.details?.short_description, "Re-analyzed");
    assert.equal(reverted.user_edits, null, "nothing left to override, so the edit row is dropped");
  });

  test("ignored screenshots disappear from search and stats", () => {
    t.library.edit(ids.get(RECEIPT)!, { ignored: true });
    assert.equal(t.library.search({ query: "coffee" }).total, 0);
    assert.equal(t.library.stats().totals.screenshots, 4);
    t.library.edit(ids.get(RECEIPT)!, { ignored: false });
    assert.equal(t.library.search({ query: "coffee" }).total, 1);
    assert.throws(() => t.library.edit("nope", { notes: "x" }), /No screenshot/);
  });

  test("status suggests starter tags, then tagging the rest", async () => {
    assert.match((await t.library.status()).next_steps.join(" "), /No tags yet/);
    t.library.createTags([{ name: "Dev" }]);
    assert.match((await t.library.status()).next_steps.join(" "), /5 analyzed screenshots haven't been considered/);
  });
});
