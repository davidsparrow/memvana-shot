import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, test } from "node:test";
import { AnalysisInput } from "../src/analysis.ts";
import { findInterests, termKey } from "../src/interests.ts";
import { type TempLibrary, tempLibrary } from "./helpers.ts";

let t: TempLibrary | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

interface Shot {
  at: string;
  topics: string[];
  entities?: Array<{ name: string; type: string }>;
  sensitive?: boolean;
  file?: string;
}

/** A library holding these analyzed screenshots, without extracting real images. */
function libraryOf(shots: Shot[]): { t: TempLibrary; ids: string[] } {
  t = tempLibrary();
  const db = t.library.db;
  db.prepare("INSERT INTO sources (id, kind, location, label, created_at) VALUES ('src', 'folder', '/tmp/shots', 'shots', ?)").run(
    shots[0]!.at,
  );
  const ids = shots.map((shot, i) => {
    const id = randomUUID();
    db.prepare(`
      INSERT INTO screenshots (id, source_id, source_key, file_path, discovered_at, captured_at, status)
      VALUES (?, 'src', ?, ?, ?, ?, 'extracted')
    `).run(id, shot.file ?? `shot-${i}.png`, `/tmp/shots/${shot.file ?? `shot-${i}.png`}`, shot.at, shot.at);
    db.prepare("INSERT INTO extractions (screenshot_id, ocr_text, engine, extracted_at) VALUES (?, '', 'test', ?)").run(id, shot.at);
    return id;
  });
  const saved = t.library.saveAnalyses(
    shots.map((shot, i) =>
      AnalysisInput.parse({
        id: ids[i],
        short_description: `About ${shot.topics.at(-1)}`,
        detailed_description: "A test screenshot.",
        likely_reason_saved: "Probably saved for later.",
        content_type: "other",
        topics: shot.topics,
        entities: shot.entities ?? [],
        sensitive: shot.sensitive ?? false,
        confidence: 0.8,
      }),
    ),
  );
  assert.deepEqual(saved.errors, []);
  return { t, ids };
}

const at = (date: string, minute = 0) => `${date}T10:${String(minute).padStart(2, "0")}:00.000Z`;

/** 20 unrelated screenshots, so the library is big enough to see patterns in. */
const filler = (): Shot[] =>
  Array.from({ length: 20 }, (_, i) => ({ at: at(`2026-0${(i % 9) + 1}-1${i % 10}`), topics: [`one-off subject ${i}`] }));

/** Pickleball, saved on six days from March to July. */
const pickleball = (): Shot[] => [
  { at: at("2026-03-02"), topics: ["sports", "pickleball", "pickleball paddles"], entities: [{ name: "JOOLA", type: "brand" }] },
  { at: at("2026-03-20"), topics: ["sports", "pickleball", "pickleball paddles"] },
  { at: at("2026-04-11"), topics: ["pickleball", "rebound surfaces"] },
  { at: at("2026-05-05"), topics: ["sports", "pickleball", "pickleball paddle"], entities: [{ name: "Joola", type: "brand" }] },
  { at: at("2026-06-18"), topics: ["pickleball", "rebound surfaces", "floor tiles"] },
  { at: at("2026-07-14"), topics: ["sports", "pickleball", "pickleball paddles"] },
];

describe("repeated interests", () => {
  test("wordings compare by a simple key", () => {
    assert.equal(termKey("Pickleball  Paddles"), "pickleball paddle");
    assert.equal(termKey("standing desks"), "standing desk");
    assert.equal(termKey("bodies"), "body");
    assert.equal(termKey("glasses"), "glass");
    assert.equal(termKey("analysis"), "analysis");
  });

  test("finds a subject saved over months, with its sub-subjects and time span", () => {
    const { t } = libraryOf([...filler(), ...pickleball()]);
    const { interests, analyzed } = t.library.interests();
    assert.equal(analyzed, 26);
    const top = interests[0]!;
    assert.equal(top.label, "pickleball");
    assert.equal(top.screenshots, 6);
    assert.equal(top.pattern, "recurring");
    assert.deepEqual([top.first, top.last, top.days, top.months], ["2026-03-02", "2026-07-14", 6, 5]);
    assert.ok(top.facets.some((f) => f.term === "pickleball paddles" && f.screenshots === 4), JSON.stringify(top.facets));
    assert.equal(top.examples[0]!.captured_at, at("2026-07-14"), "newest example first");
    assert.equal(top.ids.length, 6);
    for (const nested of interests.filter((i) => i !== top && ["sports", "pickleball paddles"].includes(i.label))) {
      assert.equal(nested.within, "pickleball");
    }
  });

  test("one afternoon of research is a burst, not a recurring interest", () => {
    const desks = Array.from({ length: 5 }, (_, i) => ({ at: at("2026-04-03", i * 7), topics: ["home office", "standing desks"] }));
    const { t } = libraryOf([...filler(), ...desks]);
    const desk = t.library.interests().interests.find((i) => i.label === "standing desks");
    assert.ok(desk, "both wordings fold into one interest, named by the more specific one");
    assert.deepEqual(desk.also, ["home office"]);
    assert.equal(desk.pattern, "burst");
    assert.equal(desk.days, 1);
  });

  test("leaves out broad themes, people, apps and sensitive screenshots", () => {
    const food = Array.from({ length: 22 }, (_, i) => ({ at: at(`2026-0${(i % 8) + 1}-0${(i % 9) + 1}`), topics: ["food", `dish ${i}`] }));
    const people = Array.from({ length: 4 }, (_, i) => ({
      at: at(`2026-0${i + 1}-21`),
      topics: [`chat ${i}`],
      entities: [{ name: "Jane Doe", type: "person" }, { name: "Instagram", type: "app_website" }],
    }));
    const bank = Array.from({ length: 4 }, (_, i) => ({ at: at(`2026-0${i + 1}-25`), topics: ["bank statements"], sensitive: true }));
    const { t } = libraryOf([...filler(), ...food, ...people, ...bank]);
    const labels = t.library.interests().interests.map((i) => i.label);
    assert.ok(!labels.includes("food"), "food is on nearly half the library: a theme for the overview");
    assert.ok(!labels.some((l) => /jane|instagram|bank/i.test(l)), labels.join(", "));
  });

  test("needs enough analyzed screenshots, and respects a date range", () => {
    const small = libraryOf(pickleball()).t;
    const none = small.library.interests();
    assert.deepEqual(none.interests, []);
    assert.match(none.note ?? "", /Only 6 screenshots are analyzed/);
    small.cleanup();

    const { t } = libraryOf([...filler(), ...pickleball()]);
    const spring = t.library.interests({ after: "2026-03", before: "2026-05" });
    assert.equal(spring.analyzed, 7);
    assert.match(spring.note ?? "", /too few/);
  });

  test("a yes tags every screenshot of the interest; the user's rejections stand", async () => {
    const { t, ids } = libraryOf([...filler(), ...pickleball()]);
    const rejectedOn = ids.at(-1)!; // the July pickleball screenshot
    t.library.createTags([{ name: "Pickleball" }]);
    t.library.tagScreenshots([rejectedOn], { remove: ["Pickleball"] });

    const result = t.library.tagInterest("pickleball", { tag: "Pickleball", description: "Pickleball gear and court ideas" });
    assert.deepEqual(result, {
      interest: "pickleball",
      tag: "Pickleball",
      tag_created: false,
      confirmed: 5,
      already_tagged: 0,
      kept_rejected: 1,
    });
    const tags = t.library.listTags().find((tag) => tag.name === "Pickleball")!;
    assert.deepEqual([tags.confirmed, tags.suggested, tags.added], [5, 0, 0]);
    assert.equal(t.library.get(rejectedOn)!.tags.find((tag) => tag.name === "Pickleball")?.state, "rejected");
    assert.equal(t.library.interests().interests[0]!.tag, "Pickleball", "now covered by the tag, so not offered again");
    assert.equal((await t.library.search({ tags: ["Pickleball"] })).results.length, 5, "searchable by the tag");
  });

  test("meaning vectors rank a tightly knit interest above a loose one of the same size", () => {
    // Same days, same size, and listed as more specific than pickleball, so without meaning it ranks higher.
    const loose = pickleball().map((shot, i) => ({ ...shot, topics: ["sports", "gadgets", `gadget ${i}`] }));
    const { t, ids } = libraryOf([...filler(), ...pickleball(), ...loose]);
    const vectors = new Map<string, Float32Array>();
    ids.forEach((id, i) => {
      const v = new Float32Array(4);
      // Pickleball screenshots point the same way; the gadgets point every which way.
      if (i >= 20 && i < 26) v[0] = 1;
      else v[i % 4] = 1;
      vectors.set(id, v);
    });
    const rank = (v?: Map<string, Float32Array>) => findInterests(t.library.db, {}, v).interests.map((i) => i.label);
    const without = rank();
    assert.ok(without.indexOf("gadgets") < without.indexOf("pickleball"), without.join(", "));
    const withMeaning = rank(vectors);
    assert.ok(withMeaning.indexOf("pickleball") < withMeaning.indexOf("gadgets"), withMeaning.join(", "));
  });

  test("a no is remembered, also for the interest's other wordings", () => {
    const { t } = libraryOf([...filler(), ...pickleball()]);
    assert.equal(t.library.interests().interests[0]!.tag_declined, undefined);
    assert.deepEqual(t.library.tagInterest("Pickleball", { declined: true }), { interest: "pickleball", declined: true });
    assert.equal(t.library.interests().interests[0]!.tag_declined, true);
    assert.equal(t.library.listTags().length, 0);
    assert.throws(() => t.library.tagInterest("knitting", { declined: true }), /No repeated interest "knitting"/);
  });
});
