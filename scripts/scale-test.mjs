// Times Memvana Shot on a large synthetic library: scanning, extraction,
// saving analyses and tags, search, related screenshots, stats and rescans.
//   npm run scale-test                  10,000 images
//   npm run scale-test -- --count 2000
// Images are generated once into /tmp/memvana-scale/images-<count> by
// scripts/make-scale-library.swift (about a minute and 400 MB for 10,000).
// Each run starts a fresh library in /tmp/memvana-scale/home. No Claude, no
// Photos, no network: analyses are written from each image's OCR text.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.MEMVANA_SCALE_DIR || "/tmp/memvana-scale";
const { values: opts } = parseArgs({ options: { count: { type: "string", default: "10000" } } });
const count = Number(opts.count);
const images = join(BASE, `images-${count}`);
const home = join(BASE, "home");

const { Library } = await import("../mcp/src/library.ts");
const { AnalysisInput } = await import("../mcp/src/analysis.ts");

const rows = [];
async function time(label, fn, { repeat = 1 } = {}) {
  const runs = [];
  let result;
  for (let i = 0; i < repeat; i++) {
    const started = performance.now();
    result = await fn();
    runs.push(performance.now() - started);
  }
  runs.sort((a, b) => a - b);
  const ms = runs[Math.floor(runs.length / 2)];
  rows.push([label, ms]);
  console.log(`${label.padEnd(52)} ${format(ms)}${repeat > 1 ? ` (median of ${repeat})` : ""}`);
  return result;
}
const format = (ms) => (ms >= 10_000 ? `${(ms / 1000).toFixed(0)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms.toFixed(0)} ms`);

if (!existsSync(images)) {
  console.log(`Generating ${count} images in ${images}…`);
  execFileSync("swift", [join(ROOT, "scripts", "make-scale-library.swift"), images, String(count)], { stdio: "inherit" });
}
rmSync(home, { recursive: true, force: true });
const library = Library.open({ home, pluginRoot: ROOT }, { photos: null });
console.log(`\nMemvana Shot scale test: ${count} screenshots\n`);

await time("first scan: discover, then extract the newest 250", () => library.scan({ folder: images }));
await time(`extract the other ${count - 250}, 500 per scan (as "analyze everything" does)`, async () => {
  for (let ready = 750; (await library.scan({ readyForAnalysis: ready })).backlog; ready += 500);
});

// Analyses written from each image's OCR text, as a stand-in for Claude's.
await time("save analyses, 48 per call (as the analyst does)", () => {
  for (;;) {
    const { items } = library.analysisBatch({ limit: 12 });
    const more = [...items, ...library.analysisBatch({ limit: 12 }).items, ...library.analysisBatch({ limit: 12 }).items,
      ...library.analysisBatch({ limit: 12 }).items];
    if (more.length === 0) break;
    const analyses = more.map((item) => {
      const words = item.ocr_text.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      return AnalysisInput.parse({
        id: item.id,
        short_description: item.ocr_text.split("\n")[0]?.slice(0, 100) || "Blank screenshot",
        detailed_description: `A synthetic screenshot showing: ${item.ocr_text.replace(/\s+/g, " ").slice(0, 300)}`,
        likely_reason_saved: "Probably saved for reference.",
        content_type: "other",
        topics: [...new Set(words)].slice(0, 4),
        keywords: [...new Set(words)].slice(4, 10),
        entities: [],
        sensitive: false,
        confidence: 0.6,
      });
    });
    library.saveAnalyses(analyses, "scale-test");
  }
});

library.createTags(["Coffee", "Recipes", "Pickleball", "Travel", "Home", "Code", "Music", "Shopping"].map((name) => ({ name })));
await time("suggest tags for everything, 100 per call", () => {
  for (;;) {
    const { items } = library.taggingBatch(100);
    if (items.length === 0) break;
    library.suggestTags(
      items.map((item) => ({
        id: item.id,
        tags: /coffee|kettle|grinder/.test(item.short_description) ? ["Coffee"] : /pasta|basil|recipe/.test(item.short_description) ? ["Recipes"] : [],
      })),
    );
  }
});

const ids = library.list({ limit: 200 }).map((row) => row.id);
const someIds = ids.filter((_, i) => i % 20 === 0).slice(0, 10);
console.log();
await time("search: keyword", () => library.search({ query: "coffee grinder" }), { repeat: 5 });
await time("search: keyword with 10 expansion terms", () =>
  library.search({ query: "kitchen remodel", also: ["tile", "backsplash", "faucet", "cabinet", "quote", "contractor", "budget", "permit", "oak", "walnut"] }),
  { repeat: 5 });
await time("search: with a date range and a tag", () =>
  library.search({ query: "coffee", after: "2025-03", before: "2025-09", tags: ["Coffee"] }), { repeat: 5 });
let i = 0;
await time("related screenshots (scores every candidate)", () => library.related(someIds[i++ % someIds.length]), { repeat: 10 });
await time("library stats (including groups)", () => library.stats(), { repeat: 5 });
await time("status", () => library.status(), { repeat: 5 });
await time("list the newest 25", () => library.list(), { repeat: 5 });
await time("tags with counts", () => library.listTags(), { repeat: 5 });
console.log();
await time("rescan with nothing new", () => library.scan(), { repeat: 3 });
await time("session-start catch-up with nothing new", () => library.catchUp(), { repeat: 3 });

const rss = Math.round(process.memoryUsage().rss / 1e6);
console.log(`\nMemory in use at the end: ${rss} MB. Semantic search wasn't set up, so meaning search wasn't timed.`);
library.close();
