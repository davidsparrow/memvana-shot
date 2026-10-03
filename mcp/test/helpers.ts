import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { z } from "zod";
import { AnalysisInput } from "../src/analysis.ts";
import { type Config, resolveHelper } from "../src/config.ts";
import { Library } from "../src/library.ts";

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
export const FIXTURES = join(REPO_ROOT, "mcp", "test", "fixtures", "library");

export const helperBuilt = resolveHelper({ home: "", pluginRoot: REPO_ROOT }) !== undefined;
export const needsHelper = helperBuilt ? {} : { skip: "shot-helper not built (npm run build:native)" };

export interface TempLibrary {
  library: Library;
  config: Config;
  /** A private copy of the fixture screenshots that tests may modify. */
  folder: string;
  cleanup: () => void;
}

export function tempLibrary(): TempLibrary {
  const root = mkdtempSync(join(tmpdir(), "memvana-shot-test-"));
  const folder = join(root, "screenshots");
  cpSync(FIXTURES, folder, { recursive: true });
  const config: Config = { home: join(root, "home"), pluginRoot: REPO_ROOT };
  const library = Library.open(config);
  return {
    library,
    config,
    folder,
    cleanup: () => {
      library.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Analyses as Claude might write them for the fixture screenshots, keyed by file name. */
export const FIXTURE_ANALYSES: Record<string, Omit<z.input<typeof AnalysisInput>, "id">> = {
  "Screenshot 2025-08-03 at 4.15.22 PM.png": {
    short_description: "Kettle-cooked blue corn tortilla chip bag, sea salt flavor",
    detailed_description:
      "Front of a snack bag with bold brown lettering on a warm yellow background. Calls out organic blue corn and a 10 oz net weight.",
    likely_reason_saved: "Likely saved as packaging design inspiration for a snack product.",
    content_type: "product",
    source_app: null,
    entities: [{ name: "Kettle Cooked", type: "brand" }],
    topics: ["Food Packaging", "tortilla chips", "organic snacks", "food packaging"],
    keywords: ["snack", "bag", "yellow", "grocery", "label design"],
    sensitive: false,
    confidence: 0.9,
  },
  "code/IMG_2041.PNG": {
    short_description: "Swift code fetching photo assets with PhotoKit",
    detailed_description: "Dark-mode code editor showing an async Swift function that fetches PHAssets and maps them to a Screenshot type.",
    likely_reason_saved: "Probably saving the snippet to reuse when building a Photos integration.",
    content_type: "code",
    source_app: "Xcode",
    entities: [{ name: "PhotoKit", type: "technology" }, { name: "Swift", type: "technology" }],
    topics: ["ios development", "photokit"],
    keywords: ["swift", "dark mode", "programming", "apple"],
    sensitive: false,
    confidence: 0.85,
  },
  "receipt.jpg": {
    short_description: "Order confirmation for a ceramic pour-over coffee set, $43.18",
    detailed_description: "Plain white order confirmation screen listing a ceramic pour over set and the order total.",
    likely_reason_saved: "Probably kept as proof of purchase.",
    content_type: "shopping_order",
    source_app: null,
    entities: [{ name: "Ceramic Pour Over Set", type: "product" }],
    topics: ["coffee gear", "online orders"],
    keywords: ["receipt", "coffee", "brewing", "kitchen"],
    sensitive: false,
    confidence: 0.8,
  },
  "window-shadow.png": {
    short_description: "Spec sheet title for a pickleball rebound surface panel",
    detailed_description: "Window capture with blue headings reading Pickleball Rebound Surface and Panel spec v2 on white.",
    likely_reason_saved: "Likely saved as reference for a pickleball training product idea.",
    content_type: "document",
    source_app: null,
    entities: [],
    topics: ["pickleball equipment", "product ideas"],
    keywords: ["sports", "training wall", "hardware"],
    sensitive: false,
    confidence: 0.7,
  },
  "nothing-here.png": {
    short_description: "Plain sage green square with no content",
    detailed_description: "A solid muted green image with no text or objects.",
    likely_reason_saved: "Possibly an accidental capture.",
    content_type: "other",
    entities: [],
    topics: ["blank"],
    keywords: ["green", "empty"],
    sensitive: false,
    confidence: 0.3,
  },
};

/** Scans the temp library and saves FIXTURE_ANALYSES for every screenshot. */
export async function analyzedLibrary(t: TempLibrary): Promise<Map<string, string>> {
  await t.library.scan({ folder: t.folder });
  const ids = new Map<string, string>();
  for (const row of t.library.list({ limit: 200 })) ids.set(row.file, row.id);
  const analyses = [...ids].map(([file, id]) => AnalysisInput.parse({ id, ...FIXTURE_ANALYSES[file]! }));
  const saved = t.library.saveAnalyses(analyses, "test-model");
  if (saved.errors.length) throw new Error(JSON.stringify(saved.errors));
  return ids;
}
