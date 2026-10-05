// Claude-written understanding of screenshots: the field guide, the schema,
// leased batches for analysis, and persistence.

import { z } from "zod";
import { type Db, now, transaction } from "./db.ts";
import { type NameHint, nameHint } from "./names.ts";
import { reindexScreenshot } from "./search-index.ts";
import { suggestTags, vocabulary } from "./tags.ts";

/** Bump when the guide or schema changes enough that old analyses are worth redoing. */
export const ANALYSIS_VERSION = 1;

export const CONTENT_TYPES = [
  "product",
  "shopping_order",
  "social_post",
  "conversation",
  "article",
  "code",
  "design_inspiration",
  "app_ui",
  "recipe_food",
  "place_travel",
  "map_directions",
  "event_booking",
  "document",
  "data_chart",
  "finance",
  "media_entertainment",
  "meme_humor",
  "contact_profile",
  "error_problem",
  "other",
] as const;

export const ENTITY_TYPES = [
  "brand",
  "product",
  "person",
  "organization",
  "place",
  "app_website",
  "technology",
  "event",
  "other",
] as const;

const LEASE_MINUTES = 15;
const OCR_CHARS_FOR_ANALYSIS = 1500;

export const ANALYSIS_GUIDE = `How to analyze screenshots for Memvana Shot

Look at each image, using the OCR text to read small print. Write one analysis
per screenshot id, then save them all in a single save_analyses call.

Each screenshot comes with its file_name and folder. When name_is_descriptive
is true, the person chose that name, so treat it as strong evidence of what
they care about and why they kept the image. Work its concepts into topics,
entities and keywords, and into likely_reason_saved. For example,
"magus__eddm_door-hanger-strip-magnets.png" points to EDDM direct-mail
marketing, door hangers and magnets. A folder such as "Recipes/" or "Kitchen
remodel/" is a deliberate grouping. Expand abbreviations you're confident
about (EDDM = Every Door Direct Mail) and keep the original term as a keyword
too. Ignore auto-generated names ("Screenshot 2026-…", "IMG_2041").

Fields
- short_description: one line, under 120 characters. Be specific: "Kettle-cooked
  blue corn tortilla chip bag, sea salt flavor", not "A food product".
- detailed_description: 2-4 sentences. What is shown, where it comes from (app
  or site), and the visual details OCR can't capture: colors, layout, style,
  imagery, materials.
- likely_reason_saved: one hedged sentence about why someone screenshotted it.
  Write the intent, not the content: "Likely saved as packaging design
  inspiration for a snack product." / "Probably kept as proof of purchase." /
  "Probably saving the snippet to reuse later."
- content_type: one of ${CONTENT_TYPES.join(", ")}.
- source_app: the app or website if identifiable ("Instagram", "amazon.com",
  "Slack", "Xcode"). Omit it if unknown.
- entities: named things worth finding later, at most about 10, each with a
  type from ${ENTITY_TYPES.join(", ")}.
- topics: 2-6 lowercase subject tags, from broad to specific ("food
  packaging", "tortilla chips", "organic snacks"). Use general, reusable
  wording so related screenshots group together; avoid one-off phrasing.
- keywords: 5-15 extra search terms someone might use later that the text
  doesn't already say: synonyms, visual descriptors ("copper", "dark mode",
  "hand-drawn", "pastel"), and categories ("snack", "bag", "grocery").
- sensitive: true if it shows private or risky information: passwords,
  verification codes, card, bank or account numbers, government IDs, medical
  details, private conversations, home addresses.
- confidence: 0-1, how sure you are of your interpretation.
- tags: names from tag_vocabulary (in the batch header) that clearly fit. Leave
  it empty when none fits, and never invent tag names. Tags are the user's
  own top-level groups, so be conservative.

Rules
- Describe only what is visible. Don't guess names, prices or dates you can't read.
- Never copy secrets into any field (passwords, codes, full card or account
  numbers, ID numbers). Write "a verification code" instead.
- For personal photos and conversations, describe roles and context ("a group
  chat planning dinner"). Don't speculate about identity or personal traits.
- For text-heavy screenshots, summarize the gist and key facts. The full OCR
  text is already stored.
- A blank, broken or meaningless image still gets saved: content_type "other",
  an honest short description, and low confidence.`;

const trimmed = (max: number) => z.string().trim().min(1).max(max);

export const AnalysisInput = z.object({
  id: z.string().describe("Screenshot id from get_analysis_batch."),
  short_description: trimmed(200),
  detailed_description: trimmed(2000),
  likely_reason_saved: trimmed(400),
  content_type: z.enum(CONTENT_TYPES),
  source_app: z.string().trim().max(80).nullish(),
  entities: z
    .array(z.object({ name: trimmed(80), type: z.enum(ENTITY_TYPES) }))
    .max(20)
    .default([]),
  topics: z.array(trimmed(60)).min(1).max(8),
  keywords: z.array(trimmed(60)).max(25).default([]),
  sensitive: z.boolean().default(false),
  confidence: z.number().min(0).max(1),
  tags: z
    .array(z.string().trim().min(1).max(40))
    .max(8)
    .default([])
    .describe("Existing tag names (from tag_vocabulary) that clearly fit."),
});
export type AnalysisInput = z.infer<typeof AnalysisInput>;

export interface BatchItem extends NameHint {
  id: string;
  captured_at: string | null;
  width: number | null;
  height: number | null;
  source_device: string | null;
  labels: string[];
  ocr_text: string;
  ocr_truncated: boolean;
  thumb_path: string | null;
}

export function pendingAnalysisCount(db: Db): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM screenshots WHERE status = 'extracted' AND ignored = 0 AND missing_since IS NULL",
    )
    .get() as { n: number };
  return row.n;
}

/**
 * Leases up to `limit` screenshots that need analysis (newest first), or the
 * specific `ids` asked for (for a second look). Leased items are skipped by
 * other callers until saved or until the lease expires.
 */
export function claimBatch(db: Db, options: { limit: number; ids?: string[] }): BatchItem[] {
  return transaction(db, () => {
    const stamp = now();
    let ids: string[];
    if (options.ids?.length) {
      ids = options.ids;
    } else {
      ids = (
        db
          .prepare(`
            SELECT id FROM screenshots
            WHERE status = 'extracted' AND ignored = 0 AND missing_since IS NULL
              AND (analysis_claimed_until IS NULL OR analysis_claimed_until < ?)
            ORDER BY captured_at DESC
            LIMIT ?
          `)
          .all(stamp, options.limit) as Array<{ id: string }>
      ).map((r) => r.id);
    }
    const until = new Date(Date.now() + LEASE_MINUTES * 60_000).toISOString();
    const lease = db.prepare("UPDATE screenshots SET analysis_claimed_until = ? WHERE id = ?");
    const fetch = db.prepare(`
      SELECT s.id, s.captured_at, s.source_key, s.width, s.height, s.source_device,
             e.ocr_text, e.labels, e.thumb_path
      FROM screenshots s JOIN extractions e ON e.screenshot_id = s.id
      WHERE s.id = ?
    `);
    const items: BatchItem[] = [];
    for (const id of ids) {
      const row = fetch.get(id) as Record<string, any> | undefined;
      if (!row) continue; // unknown or not yet extracted
      lease.run(until, id);
      const ocr: string = row.ocr_text ?? "";
      items.push({
        id: row.id,
        captured_at: row.captured_at,
        ...nameHint(row.source_key),
        width: row.width,
        height: row.height,
        source_device: row.source_device,
        labels: (JSON.parse(row.labels ?? "[]") as Array<{ label: string }>).slice(0, 6).map((l) => l.label),
        ocr_text: ocr.slice(0, OCR_CHARS_FOR_ANALYSIS),
        ocr_truncated: ocr.length > OCR_CHARS_FOR_ANALYSIS,
        thumb_path: row.thumb_path,
      });
    }
    return items;
  });
}

export interface SaveResult {
  saved: number;
  errors: Array<{ id: string; error: string }>;
  /** Tag suggestions recorded alongside the analyses. */
  tags_suggested?: number;
  tag_errors?: Array<{ id: string; error: string }>;
}

export function saveAnalyses(db: Db, analyses: AnalysisInput[], model?: string): SaveResult {
  const result: SaveResult = { saved: 0, errors: [] };
  const lookup = db.prepare(`
    SELECT s.content_hash, e.screenshot_id AS extracted
    FROM screenshots s LEFT JOIN extractions e ON e.screenshot_id = s.id WHERE s.id = ?
  `);
  const upsert = db.prepare(`
    INSERT INTO analyses
      (screenshot_id, short_description, detailed_description, likely_reason_saved, content_type, source_app,
       entities, topics, keywords, sensitive, confidence, model, analysis_version, content_hash, analyzed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (screenshot_id) DO UPDATE SET
      short_description = excluded.short_description, detailed_description = excluded.detailed_description,
      likely_reason_saved = excluded.likely_reason_saved, content_type = excluded.content_type,
      source_app = excluded.source_app, entities = excluded.entities, topics = excluded.topics,
      keywords = excluded.keywords, sensitive = excluded.sensitive, confidence = excluded.confidence,
      model = excluded.model, analysis_version = excluded.analysis_version,
      content_hash = excluded.content_hash, analyzed_at = excluded.analyzed_at
  `);
  const markAnalyzed = db.prepare(
    "UPDATE screenshots SET status = 'analyzed', analysis_claimed_until = NULL WHERE id = ?",
  );

  const hasVocabulary = vocabulary(db).length > 0;
  transaction(db, () => {
    for (const a of analyses) {
      const row = lookup.get(a.id) as { content_hash: string | null; extracted: string | null } | undefined;
      if (!row) {
        result.errors.push({ id: a.id, error: "unknown screenshot id" });
        continue;
      }
      if (!row.extracted) {
        result.errors.push({ id: a.id, error: "screenshot has not been extracted yet" });
        continue;
      }
      upsert.run(
        a.id,
        a.short_description,
        a.detailed_description,
        a.likely_reason_saved,
        a.content_type,
        a.source_app || null,
        JSON.stringify(dedupeEntities(a.entities)),
        JSON.stringify(normalizeTags(a.topics)),
        JSON.stringify(normalizeTags(a.keywords)),
        a.sensitive ? 1 : 0,
        a.confidence,
        model ?? null,
        ANALYSIS_VERSION,
        row.content_hash,
        now(),
      );
      markAnalyzed.run(a.id);
      reindexScreenshot(db, a.id);
      result.saved++;
      // With no tags defined yet there was nothing to choose from, so leave the
      // screenshot for a later tagging pass instead of marking it considered.
      if (hasVocabulary) {
        const tagged = suggestTags(db, [{ id: a.id, tags: a.tags ?? [], confidence: a.confidence }]);
        result.tags_suggested = (result.tags_suggested ?? 0) + tagged.suggested;
        if (tagged.errors.length) (result.tag_errors ??= []).push(...tagged.errors);
      }
    }
  });
  return result;
}

/** Lowercase, collapse whitespace, drop duplicates; order preserved. */
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const t = tag.toLowerCase().replace(/\s+/g, " ").trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function dedupeEntities(entities: AnalysisInput["entities"]): AnalysisInput["entities"] {
  const seen = new Set<string>();
  return entities.filter((e) => {
    const key = `${e.type}:${e.name.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
