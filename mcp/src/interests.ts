// Repeated interests: subjects the user keeps saving screenshots about ("11
// screenshots about pickleball equipment over four months"). They come from
// the topics and named things in Claude's analyses (and keywords the user
// added), grouped where the wordings overlap, and judged by how they spread
// over time. Meaning vectors, when semantic search is set up, only help rank
// how tightly each one hangs together; they never pull screenshots in.
//
// An interest is only a view: nothing is merged, moved or deleted. It becomes
// a tag only when the user says yes (tagInterest), and a no is remembered so
// the tag isn't offered again.

import { dirname } from "node:path";
import { type Db, getMeta, now, setMeta, transaction } from "./db.ts";
import { nameTerms, parseAlbums } from "./names.ts";
import { normalizeDateBound } from "./search.ts";
import { reindexScreenshot } from "./search-index.ts";
import { cosine } from "./semantic/vectors.ts";
import { ensureTag, tagKey } from "./tags.ts";

export interface Interest {
  /** Identifies the interest for tag_interest. */
  key: string;
  label: string;
  /** Other wordings folded into this interest. */
  also: string[];
  screenshots: number;
  /** recurring: saved on several days over weeks or months. burst: within a few days. */
  pattern: "recurring" | "burst";
  first: string | null;
  last: string | null;
  /** Distinct days and months with a screenshot about it. */
  days: number;
  months: number;
  /** Sub-subjects that recur within it, with how many of its screenshots mention each. */
  facets: Array<{ term: string; screenshots: number }>;
  /** A broader interest this one sits inside. */
  within?: string;
  /** The album or descriptive folder holding most of these. */
  group?: { kind: "album" | "folder"; name: string };
  /** A tag already on most of these (or named like it), so there's no need to offer one. */
  tag?: string;
  /** The user said no to a tag for this before: don't offer one again. */
  tag_declined?: true;
  examples: Array<{ id: string; captured_at: string | null; short_description: string | null }>;
  /** Its screenshots, newest first (at most 100). */
  ids: string[];
}

export interface InterestsResult {
  range: { after: string | null; before: string | null };
  analyzed: number;
  /** Screenshots in range that aren't analyzed yet, so can't count toward interests. */
  not_analyzed: number;
  interests: Interest[];
  note?: string;
}

export interface InterestOptions {
  after?: string;
  before?: string;
  limit?: number;
}

// Named things worth treating as interests. People are left out on purpose,
// and apps and websites say where something was seen, not what it was about.
const ENTITY_TYPES = new Set(["brand", "product", "organization", "place", "technology", "event"]);

// Words that describe the screenshot rather than its subject.
const GENERIC = new Set([
  "screenshot", "app", "mobile app", "user interface", "ui", "app ui", "web page", "website", "web", "text",
  "document", "blank", "other", "misc", "miscellaneous", "image", "photo", "notification", "settings", "screen",
  "menu", "interface", "browser", "message", "social media", "online",
]);

/** Fewer analyzed screenshots than this, and there's too little to see patterns in. */
const MIN_ANALYZED = 20;
/** A term on more than this share of a library is a broad theme (the overview's job), not an interest. */
const THEME_SHARE = 0.3;
const RECURRING = { days: 3, spanDays: 14 };
const DECLINED_KEY = "interests_declined";

interface Row {
  id: string;
  captured_at: string | null;
  source_key: string;
  photo_asset_id: string | null;
  albums: string | null;
  topics: string;
  entities: string;
  keywords_added: string | null;
  short_description: string | null;
}

interface Term {
  key: string;
  members: Set<number>;
  wordings: Map<string, number>;
  /** How specific the analyses considered it: topics are listed broad to specific. */
  specificity: number;
}

interface Cluster {
  terms: Term[];
  members: Set<number>;
}

/** The comparison key for a wording: lowercase, single spaces, last word singular. */
export function termKey(text: string): string {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}&+#.' -]+/gu, " ").replace(/\s+/g, " ").trim().split(" ");
  const last = words.at(-1) ?? "";
  if (last.length > 3) {
    if (last.endsWith("ies")) words[words.length - 1] = `${last.slice(0, -3)}y`;
    else if (last.endsWith("sses")) words[words.length - 1] = last.slice(0, -2);
    else if (last.endsWith("s") && !/(ss|us|is)$/.test(last)) words[words.length - 1] = last.slice(0, -1);
  }
  return words.join(" ");
}

function loadRows(db: Db, range: { after: string | null; before: string | null }): { rows: Row[]; notAnalyzed: number } {
  const where = `
    s.ignored = 0 AND s.missing_since IS NULL
    AND (:after IS NULL OR s.captured_at >= :after)
    AND (:before IS NULL OR s.captured_at < :before)
  `;
  // Sensitive screenshots never become part of an interest.
  const rows = db
    .prepare(`
      SELECT s.id, s.captured_at, s.source_key, s.photo_asset_id, s.albums, a.topics, a.entities,
             u.keywords_added, COALESCE(u.short_description, a.short_description) AS short_description
      FROM screenshots s JOIN analyses a ON a.screenshot_id = s.id
      LEFT JOIN user_edits u ON u.screenshot_id = s.id
      WHERE ${where} AND a.sensitive = 0
      ORDER BY s.captured_at DESC, s.id
    `)
    .all(range) as unknown as Row[];
  const notAnalyzed = (
    db
      .prepare(`
        SELECT COUNT(*) AS n FROM screenshots s
        WHERE ${where} AND NOT EXISTS (SELECT 1 FROM analyses a WHERE a.screenshot_id = s.id)
      `)
      .get(range) as { n: number }
  ).n;
  return { rows, notAnalyzed };
}

function collectTerms(rows: Row[]): Map<string, Term> {
  const terms = new Map<string, Term>();
  const positions = new Map<string, number[]>();
  const add = (index: number, wording: string, specificity: number) => {
    const clean = wording.replace(/\s+/g, " ").trim();
    const key = termKey(clean);
    if (key.length < 2 || GENERIC.has(key)) return;
    const term = terms.get(key) ?? { key, members: new Set(), wordings: new Map(), specificity: 0 };
    if (!term.members.has(index)) {
      term.members.add(index);
      const list = positions.get(key) ?? [];
      list.push(specificity);
      positions.set(key, list);
    }
    term.wordings.set(clean, (term.wordings.get(clean) ?? 0) + 1);
    terms.set(key, term);
  };
  rows.forEach((row, index) => {
    const topics = JSON.parse(row.topics) as string[];
    topics.forEach((topic, i) => add(index, topic, topics.length > 1 ? i / (topics.length - 1) : 0.5));
    for (const entity of JSON.parse(row.entities) as Array<{ name: string; type: string }>) {
      if (ENTITY_TYPES.has(entity.type)) add(index, entity.name, 1);
    }
    // A keyword the user added is their own word for what matters.
    for (const keyword of row.keywords_added ? (JSON.parse(row.keywords_added) as string[]) : []) add(index, keyword, 1);
  });
  for (const term of terms.values()) {
    const list = positions.get(term.key)!;
    term.specificity = list.reduce((a, b) => a + b, 0) / list.length;
  }
  return terms;
}

/**
 * Folds wordings of the same subject together, when each mostly covers the
 * other's screenshots ("pickleball" and "pickleball paddles"). A narrower
 * subject inside a broader one stays separate ("pickleball" in "sports").
 */
function cluster(candidates: Term[]): Cluster[] {
  const clusters: Cluster[] = [];
  for (const term of candidates) {
    let home: Cluster | undefined;
    for (const c of clusters) {
      const shared = overlap(term.members, c.members);
      if (shared / term.members.size >= 0.75 && shared / c.members.size >= 0.7) {
        home = c;
        break;
      }
    }
    if (home) {
      home.terms.push(term);
      for (const m of term.members) home.members.add(m);
    } else {
      clusters.push({ terms: [term], members: new Set(term.members) });
    }
  }
  return clusters;
}

function overlap(a: Set<number>, b: Set<number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const x of small) if (large.has(x)) n++;
  return n;
}

const day = (iso: string | null) => iso?.slice(0, 10) ?? null;

function bestWording(term: Term): string {
  return [...term.wordings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
}

function folderOf(row: Row): string | undefined {
  if (row.photo_asset_id) return undefined;
  const folder = dirname(row.source_key);
  return folder !== "." && nameTerms(folder) ? folder : undefined;
}

/** How tightly the screenshots hang together by meaning (mean similarity to their centroid), if known. */
function cohesion(ids: string[], vectors: Map<string, Float32Array> | undefined): number | undefined {
  const found = ids.map((id) => vectors?.get(id)).filter((v): v is Float32Array => v !== undefined);
  if (found.length < 3 || found.length < ids.length * 0.6) return undefined;
  const centroid = new Float32Array(found[0]!.length);
  for (const v of found) for (let i = 0; i < v.length; i++) centroid[i]! += v[i]!;
  const norm = Math.hypot(...centroid);
  for (let i = 0; i < centroid.length; i++) centroid[i]! /= norm || 1;
  return found.reduce((sum, v) => sum + cosine(v, centroid), 0) / found.length;
}

function declinedInterests(db: Db): Set<string> {
  const value = getMeta(db, DECLINED_KEY);
  return new Set(value ? (JSON.parse(value) as Array<{ key: string }>).map((d) => d.key) : []);
}

/** An interest, with every screenshot and term behind it (the output lists are capped). */
interface Found {
  interest: Interest;
  ids: string[];
  keys: string[];
  members: Set<number>;
  score: number;
}

/** Recurring subjects across the analyzed screenshots in a date range, strongest first. */
export function findInterests(
  db: Db,
  options: InterestOptions = {},
  vectors?: Map<string, Float32Array>,
): InterestsResult {
  const range = { after: normalizeDateBound(options.after) ?? null, before: normalizeDateBound(options.before) ?? null };
  const { rows, notAnalyzed } = loadRows(db, range);
  const result: InterestsResult = { range, analyzed: rows.length, not_analyzed: notAnalyzed, interests: [] };
  if (rows.length < MIN_ANALYZED) {
    result.note = `Only ${rows.length} screenshots are analyzed${range.after || range.before ? " in this range" : ""}, too few to see repeated interests yet.`;
    return result;
  }
  const limit = Math.min(Math.max(options.limit ?? 12, 1), 25);
  result.interests = computeInterests(db, rows, vectors).slice(0, limit).map((f) => f.interest);
  if (!result.interests.length) result.note = "No subject comes up often enough yet to count as a repeated interest.";
  else if (notAnalyzed > rows.length) {
    result.note = `Based on ${rows.length} analyzed screenshots; ${notAnalyzed} more aren't analyzed, so some interests may be missing.`;
  }
  return result;
}

function computeInterests(db: Db, rows: Row[], vectors: Map<string, Float32Array> | undefined): Found[] {
  const minimum = rows.length < 100 ? 3 : 4;
  const candidates = [...collectTerms(rows).values()]
    .filter((t) => t.members.size >= minimum && (rows.length < 40 || t.members.size / rows.length <= THEME_SHARE))
    .sort((a, b) => b.members.size - a.members.size || b.specificity - a.specificity || a.key.localeCompare(b.key));
  const clusters = cluster(candidates);

  const tags = tagsByScreenshot(db);
  const tagNames = new Map(
    (db.prepare("SELECT name, name_key FROM tags").all() as Array<{ name: string; name_key: string }>).map((t) => [t.name_key, t.name]),
  );
  const declined = declinedInterests(db);
  const scored: Found[] = [];

  for (const c of clusters) {
    const indexes = [...c.members].sort((a, b) => a - b); // rows are newest first
    const members = indexes.map((i) => rows[i]!);
    const days = new Set(members.map((r) => day(r.captured_at)).filter(Boolean));
    const months = new Set([...days].map((d) => d!.slice(0, 7)));
    const dates = members.map((r) => r.captured_at).filter((d): d is string => d !== null).sort();
    const first = dates[0] ?? null;
    const last = dates.at(-1) ?? null;
    const spanDays = first && last ? (Date.parse(last) - Date.parse(first)) / 86_400_000 : 0;
    const recurring = days.size >= RECURRING.days && spanDays >= RECURRING.spanDays;

    const own = new Set(c.terms.map((t) => t.key));
    const facetCounts = new Map<string, { term: Term; n: number }>();
    for (const t of candidates) {
      if (own.has(t.key)) continue;
      const n = overlap(t.members, c.members);
      if (n >= 2 && n < c.members.size) facetCounts.set(t.key, { term: t, n });
    }
    const facets = [...facetCounts.values()]
      .sort((a, b) => b.n - a.n || b.term.specificity - a.term.specificity)
      .slice(0, 4)
      .map(({ term, n }) => ({ term: bestWording(term), screenshots: n }));

    // Name it by its most specific wording that still covers nearly all of it.
    const main = c.terms
      .filter((t) => t.members.size >= c.members.size * 0.9)
      .sort((a, b) => b.specificity - a.specificity || b.members.size - a.members.size)[0] ?? c.terms[0]!;
    const label = bestWording(main);
    const interest: Interest = {
      key: main.key,
      label,
      also: c.terms.filter((t) => t !== main).slice(0, 5).map(bestWording),
      screenshots: members.length,
      pattern: recurring ? "recurring" : "burst",
      first: day(first),
      last: day(last),
      days: days.size,
      months: months.size,
      facets,
      examples: members.slice(0, 3).map((r) => ({ id: r.id, captured_at: r.captured_at, short_description: r.short_description })),
      ids: members.slice(0, 100).map((r) => r.id),
    };

    const group = mostCommon(members.flatMap((r) => [
      ...parseAlbums(r.albums).map((name) => `album\n${name}`),
      ...(folderOf(r) ? [`folder\n${folderOf(r)}`] : []),
    ]));
    if (group && group.n >= members.length * 0.6) {
      const [kind, name] = group.value.split("\n") as ["album" | "folder", string];
      interest.group = { kind, name };
    }
    const tag = mostCommon(members.flatMap((r) => tags.get(r.id) ?? []));
    const named = c.terms.map((t) => tagNames.get(safeTagKey(bestWording(t)))).find(Boolean);
    if (tag && tag.n >= members.length * 0.6) interest.tag = tag.value;
    else if (named) interest.tag = named;
    if (c.terms.some((t) => declined.has(t.key))) interest.tag_declined = true;

    const tight = cohesion(interest.ids, vectors);
    const specificity = c.terms.reduce((s, t) => s + t.specificity * t.members.size, 0) /
      c.terms.reduce((s, t) => s + t.members.size, 0);
    const score =
      members.length *
      (1 + Math.log2(days.size || 1)) *
      (0.6 + 0.4 * specificity) *
      (recurring ? 1.3 : 1) *
      (tight === undefined ? 1 : 0.5 + tight);
    scored.push({ interest, score, members: c.members, ids: members.map((r) => r.id), keys: [...own] });
  }

  scored.sort((a, b) => b.score - a.score || a.interest.key.localeCompare(b.interest.key));
  // Say when one interest sits inside a broader one ("pickleball" within "sports").
  for (const s of scored) {
    const parent = scored
      .filter((p) => p !== s && p.members.size > s.members.size && overlap(s.members, p.members) / s.members.size >= 0.8)
      .sort((a, b) => a.members.size - b.members.size)[0];
    if (parent) s.interest.within = parent.interest.label;
  }
  return scored;
}

function mostCommon(values: string[]): { value: string; n: number } | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const [value, n] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
  return value === undefined ? undefined : { value, n: n! };
}

function tagsByScreenshot(db: Db): Map<string, string[]> {
  const rows = db
    .prepare(`
      SELECT st.screenshot_id AS id, t.name FROM screenshot_tags st JOIN tags t ON t.id = st.tag_id
      WHERE st.state != 'rejected'
    `)
    .all() as Array<{ id: string; name: string }>;
  const byId = new Map<string, string[]>();
  for (const r of rows) byId.set(r.id, [...(byId.get(r.id) ?? []), r.name]);
  return byId;
}

function safeTagKey(name: string): string {
  try {
    return tagKey(name);
  } catch {
    return "";
  }
}

export type InterestDecision = { tag: string; description?: string } | { declined: true };

export type InterestDecisionResult =
  | { interest: string; tag: string; tag_created: boolean; confirmed: number; already_tagged: number; kept_rejected: number }
  | { interest: string; declined: true };

/**
 * The user's answer to "Want a tag for these?", for one interest or several
 * that Claude presented as one. A yes puts the tag on every screenshot of
 * them as an accepted suggestion (the user's earlier decisions, rejections
 * included, stand). A no is remembered.
 */
export function tagInterest(
  db: Db,
  keys: string[],
  decision: InterestDecision,
  vectors?: Map<string, Float32Array>,
): InterestDecisionResult {
  const { rows } = loadRows(db, { after: null, before: null });
  const all = computeInterests(db, rows, vectors);
  const picked = keys.map((key) => {
    const match = all.find((f) => f.keys.includes(termKey(key)));
    if (!match) throw new Error(`No repeated interest "${key}" right now. Call get_interests for the current ones.`);
    return match;
  });
  const found = {
    keys: [...new Set(picked.flatMap((f) => f.keys))],
    ids: [...new Set(picked.flatMap((f) => f.ids))],
  };
  const label = [...new Set(picked.map((f) => f.interest.label))].join(" + ");

  return transaction(db, () => {
    if ("declined" in decision) {
      const list = getMeta(db, DECLINED_KEY);
      const declined = list ? (JSON.parse(list) as Array<{ key: string; label: string; at: string }>) : [];
      const fresh = found.keys.filter((k) => !declined.some((d) => d.key === k));
      declined.push(...fresh.map((k) => ({ key: k, label, at: now() })));
      setMeta(db, DECLINED_KEY, JSON.stringify(declined));
      return { interest: label, declined: true as const };
    }

    const { tag, created } = ensureTag(db, decision.tag, "ai", decision.description);
    const current = db.prepare("SELECT state FROM screenshot_tags WHERE screenshot_id = ? AND tag_id = ?");
    const upsert = db.prepare(`
      INSERT INTO screenshot_tags (screenshot_id, tag_id, state, source, created_at, updated_at)
      VALUES (?, ?, 'confirmed', 'ai', ?, ?)
      ON CONFLICT (screenshot_id, tag_id) DO UPDATE SET state = 'confirmed', updated_at = excluded.updated_at
    `);
    const stamp = now();
    const result = { interest: label, tag: tag.name, tag_created: created, confirmed: 0, already_tagged: 0, kept_rejected: 0 };
    for (const id of found.ids) {
      const state = (current.get(id, tag.id) as { state: string } | undefined)?.state;
      if (state === "rejected") result.kept_rejected++;
      else if (state === "added" || state === "confirmed") result.already_tagged++;
      else {
        upsert.run(id, tag.id, stamp, stamp);
        reindexScreenshot(db, id);
        result.confirmed++;
      }
    }
    return result;
  });
}
