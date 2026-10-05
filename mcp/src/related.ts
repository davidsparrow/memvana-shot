// "Show me screenshots related to this one." Combines several signals, and
// says which ones connected each pair:
//   meaning   the semantic vectors are close (when semantic search is set up)
//   looks     Apple Vision feature prints are close (same layout, same object, a re-capture)
//   tags, names, topics in common; captured minutes apart; the same descriptive folder.

import { dirname } from "node:path";
import type { Db } from "./db.ts";
import { nameTerms } from "./names.ts";
import { cosine, toVector } from "./semantic/vectors.ts";

// Calibrated on screenshot libraries. Meaning: unrelated pairs average about
// 0.4, related ones 0.55-0.7. Looks (Vision feature-print revision 2, unit
// vectors): unrelated pairs 0.3-0.5, similar layouts 0.6-0.8, re-captures 0.95+.
const MEANING = { from: 0.45, to: 0.75, similar: 0.55, very: 0.65 };
const LOOKS = { from: 0.55, to: 0.85, layout: 0.6, alike: 0.7, duplicate: 0.95 };
const SESSION_MS = 10 * 60_000;
const MIN_SCORE = 0.35;

export interface RelatedHit {
  id: string;
  captured_at: string | null;
  file: string;
  short_description: string | null;
  likely_reason_saved: string | null;
  content_type: string | null;
  tags: string[];
  score: number;
  /** Why it's related, strongest first. */
  reasons: string[];
  /** Meaning similarity, when both have vectors. */
  similarity?: number;
  /** Visual similarity of the images (1 = identical). */
  looks_alike?: number;
  near_duplicate?: true;
}

export interface RelatedResult {
  screenshot: { id: string; short_description: string | null; file: string };
  results: RelatedHit[];
  /** Which signals were available for this screenshot. */
  signals: { meaning: boolean; visual: boolean };
  note?: string;
}

interface Candidate {
  id: string;
  captured_at: string | null;
  source_key: string;
  content_hash: string | null;
  feature_print: Uint8Array | null;
  feature_print_revision: number | null;
  short_description: string | null;
  likely_reason_saved: string | null;
  content_type: string | null;
  entities: string | null;
  topics: string | null;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const scale = (x: number, range: { from: number; to: number }) => clamp01((x - range.from) / (range.to - range.from));

export function relatedScreenshots(
  db: Db,
  id: string,
  meaningVectors: Map<string, Float32Array> | undefined,
  options: { limit?: number } = {},
): RelatedResult {
  const select = `
    SELECT s.id, s.captured_at, s.source_key, s.content_hash, e.feature_print, e.feature_print_revision,
           COALESCE(u.short_description, a.short_description) AS short_description,
           COALESCE(u.likely_reason_saved, a.likely_reason_saved) AS likely_reason_saved,
           a.content_type, a.entities, a.topics
    FROM screenshots s
    JOIN extractions e ON e.screenshot_id = s.id
    LEFT JOIN analyses a ON a.screenshot_id = s.id
    LEFT JOIN user_edits u ON u.screenshot_id = s.id
  `;
  const target = db.prepare(`${select} WHERE s.id = ?`).get(id) as unknown as Candidate | undefined;
  if (!target) throw new Error(`No extracted screenshot with id ${id}`);
  const candidates = db
    .prepare(`${select} WHERE s.id != ? AND s.ignored = 0 AND s.missing_since IS NULL AND s.status IN ('extracted', 'analyzed')`)
    .all(id) as unknown as Candidate[];
  const tags = tagsById(db);

  const targetMeaning = meaningVectors?.get(id);
  const targetLooks = target.feature_print ? toVector(target.feature_print) : undefined;
  const targetTime = target.captured_at ? Date.parse(target.captured_at) : NaN;
  const targetFolder = descriptiveFolder(target.source_key);
  const targetTags = tags.get(id) ?? [];
  const targetNames = new Map(entityNames(target.entities).map((n) => [n.toLowerCase(), n]));
  const targetTopics = new Set(parseList(target.topics));

  const hits: RelatedHit[] = [];
  for (const c of candidates) {
    const reasons: Array<[number, string]> = [];
    let score = 0;
    let similarity: number | undefined;
    let looks: number | undefined;
    let nearDuplicate = false;

    const v = targetMeaning && meaningVectors?.get(c.id);
    if (targetMeaning && v) {
      similarity = cosine(targetMeaning, v);
      const s = scale(similarity, MEANING);
      score += s;
      if (similarity >= MEANING.very) reasons.push([s, "very similar subject"]);
      else if (similarity >= MEANING.similar) reasons.push([s, "similar subject"]);
    }

    if (target.content_hash && c.content_hash === target.content_hash) {
      nearDuplicate = true;
      looks = 1;
      score += 0.7;
      reasons.push([2, "identical image (a copy of the same file)"]);
    } else if (targetLooks && c.feature_print && c.feature_print_revision === target.feature_print_revision) {
      looks = cosine(targetLooks, toVector(c.feature_print));
      const s = scale(looks, LOOKS);
      score += 0.7 * s;
      if (looks >= LOOKS.duplicate) {
        nearDuplicate = true;
        reasons.push([2, "nearly identical image"]);
      } else if (looks >= LOOKS.alike) reasons.push([0.7 * s, "looks alike"]);
      else if (looks >= LOOKS.layout) reasons.push([0.7 * s, "similar layout"]);
    }

    const shared = (tags.get(c.id) ?? []).filter((t) => targetTags.some((x) => x.name === t.name));
    if (shared.length) {
      const mine = shared.filter((t) => t.state !== "suggested").length;
      const s = 0.5 * clamp01(mine * 0.6 + (shared.length - mine) * 0.3);
      score += s;
      reasons.push([s, `both tagged ${shared.map((t) => t.name).join(", ")}`]);
    }

    const names = entityNames(c.entities).filter((n) => targetNames.has(n.toLowerCase()));
    if (names.length) {
      const s = 0.4 * clamp01(names.length * 0.5);
      score += s;
      reasons.push([s, `both mention ${names.slice(0, 3).join(", ")}`]);
    }

    const topics = parseList(c.topics).filter((t) => targetTopics.has(t));
    if (topics.length) {
      const s = 0.3 * clamp01(topics.length * 0.35);
      score += s;
      reasons.push([s, `shared topics: ${topics.slice(0, 3).join(", ")}`]);
    }

    const gap = Math.abs(Date.parse(c.captured_at ?? "") - targetTime);
    if (gap <= SESSION_MS) {
      score += 0.3;
      const minutes = Math.round(gap / 60_000);
      reasons.push([0.3, minutes < 1 ? "captured less than a minute apart" : `captured ${minutes} min apart`]);
    }

    if (targetFolder && descriptiveFolder(c.source_key) === targetFolder) {
      score += 0.2;
      reasons.push([0.2, `same folder (${targetFolder})`]);
    }

    if (score < MIN_SCORE && !nearDuplicate) continue;
    hits.push({
      id: c.id,
      captured_at: c.captured_at,
      file: c.source_key,
      short_description: c.short_description,
      likely_reason_saved: c.likely_reason_saved,
      content_type: c.content_type,
      tags: (tags.get(c.id) ?? []).filter((t) => t.state !== "suggested").map((t) => t.name),
      score: Math.round(score * 100) / 100,
      reasons: reasons.sort((a, b) => b[0] - a[0]).map(([, why]) => why),
      similarity: similarity === undefined ? undefined : Math.round(similarity * 100) / 100,
      looks_alike: looks === undefined ? undefined : Math.round(looks * 100) / 100,
      near_duplicate: nearDuplicate || undefined,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  const limit = Math.min(Math.max(options.limit ?? 8, 1), 30);
  return {
    screenshot: { id, short_description: target.short_description, file: target.source_key },
    results: hits.slice(0, limit),
    signals: { meaning: targetMeaning !== undefined, visual: targetLooks !== undefined },
    note: targetMeaning
      ? undefined
      : meaningVectors
        ? "This screenshot has no meaning vector yet, so relatedness uses looks, tags, names, topics and dates."
        : "Semantic search isn't set up, so relatedness uses looks, tags, names, topics and dates only.",
  };
}

function tagsById(db: Db): Map<string, Array<{ name: string; state: string }>> {
  const rows = db
    .prepare(`
      SELECT st.screenshot_id AS id, t.name, st.state FROM screenshot_tags st JOIN tags t ON t.id = st.tag_id
      WHERE st.state != 'rejected'
    `)
    .all() as Array<{ id: string; name: string; state: string }>;
  const byId = new Map<string, Array<{ name: string; state: string }>>();
  for (const r of rows) {
    const list = byId.get(r.id) ?? [];
    list.push({ name: r.name, state: r.state });
    byId.set(r.id, list);
  }
  return byId;
}

function parseList(json: string | null): string[] {
  return json ? (JSON.parse(json) as string[]) : [];
}

function entityNames(json: string | null): string[] {
  return json ? (JSON.parse(json) as Array<{ name: string }>).map((e) => e.name) : [];
}

/** The folder a screenshot sits in, if its name means something ("Recipes", not "." or "2024"). */
function descriptiveFolder(sourceKey: string): string | undefined {
  const folder = dirname(sourceKey);
  return folder !== "." && nameTerms(folder) ? folder : undefined;
}
