import type { Db } from "./db.ts";
import { cosine } from "./semantic/vectors.ts";
import { SEARCH_WEIGHTS } from "./search-index.ts";
import { listTags, tagKey } from "./tags.ts";

// Words that carry no meaning in a screenshot search ("find that screenshot
// of the …"). Everything else becomes a search term.
const STOPWORDS = new Set(
  (
    "a an and any are as at be been but by can could did do does find for from get had has have i i'd i've if in " +
    "into is it its me my of on or our please saw seen show some that the their them then there these they this " +
    "those to was we were what when where which while who with you your " +
    "screenshot screenshots screen shot shots image images picture pictures pic pics photo photos saved save " +
    "took taken"
  ).split(" "),
);

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu;

function words(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).map((w) => w.replace(/['’]s?$/, ""));
}

/**
 * Turns a natural-language query plus optional expansion terms into an FTS5
 * expression. Every term is quoted (so user text can't inject FTS syntax) and
 * terms are OR-ed: bm25 ranks screenshots that match more of them higher.
 * Quoted "multi word phrases" in the query, and multi-word `also` entries,
 * match as phrases.
 */
export function buildMatchExpression(query = "", also: string[] = []): string | undefined {
  const clauses = new Set<string>();
  const add = (tokens: string[]) => {
    if (tokens.length) clauses.add(`"${tokens.join(" ")}"`);
  };
  const unquoted = query.replace(/"([^"]+)"/g, (_, phrase: string) => {
    add(words(phrase));
    return " ";
  });
  for (const w of words(unquoted)) {
    if (!STOPWORDS.has(w) && (w.length > 1 || /\d/.test(w))) add([w]);
  }
  for (const term of also) add(words(term));
  return clauses.size ? [...clauses].join(" OR ") : undefined;
}

/** "2025", "2025-03", "2025-03-14" → local midnight; full timestamps pass through. */
export function normalizeDateBound(value?: string): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  const m = v.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
  const ms = m ? new Date(`${m[1]}-${m[2] ?? "01"}-${m[3] ?? "01"}T00:00:00`).getTime() : Date.parse(v);
  if (Number.isNaN(ms)) throw new Error(`Unrecognized date: ${value}`);
  return new Date(ms).toISOString();
}

export const SEARCH_MODES = ["auto", "keyword", "semantic"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export interface SearchOptions {
  query?: string;
  also?: string[];
  contentType?: string;
  /** Only screenshots carrying all of these tags (suggested ones included). */
  tags?: string[];
  /** Only screenshots with no tags at all. */
  untagged?: boolean;
  after?: string;
  before?: string;
  limit?: number;
  offset?: number;
  /** auto (default): keywords plus meaning when semantic search is set up. */
  mode?: SearchMode;
}

export interface SearchHit {
  id: string;
  captured_at: string | null;
  file: string;
  analyzed: boolean;
  short_description: string | null;
  likely_reason_saved: string | null;
  content_type: string | null;
  topics: string[];
  /** Tags the user added or confirmed. */
  tags: string[];
  /** Claude's tag suggestions, not yet confirmed. */
  suggested_tags: string[];
  /** The user has edited this screenshot's details. */
  edited: boolean;
  sensitive: boolean;
  relevance?: number;
  /** How close in meaning to the query (cosine, roughly 0.3 weak to 0.6 strong). */
  similarity?: number;
  matched_by?: Array<"keywords" | "meaning">;
  match?: string;
}

export interface SearchResult {
  match_expression?: string;
  total: number;
  results: SearchHit[];
  /** Extracted but not yet analyzed: only their OCR text and file name are searchable. */
  unanalyzed_in_library: number;
  /** Whether meaning (semantic) matching took part, and why not if it didn't. */
  semantic?: { used: boolean; note?: string };
}

/** Where query meaning vectors and screenshot vectors come from (the SemanticIndex). */
export interface MeaningSource {
  /** Undefined when semantic search can't run; see unavailableReason(). */
  queryVector(text: string): Promise<Float32Array | undefined>;
  vectors(): Map<string, Float32Array>;
  unavailableReason(): string | undefined;
}

// Meaning matches below this cosine similarity are noise for EmbeddingGemma
// queries, and so are those far below the best match. Calibrated on screenshot
// descriptions: relevant matches mostly score 0.35-0.55, unrelated ones under 0.3.
export const MEANING_FLOOR = 0.3;
const MEANING_SPREAD = 0.2;
/** Reciprocal-rank fusion constant: smaller favours the top of each list more. */
const FUSION_K = 20;
/** How deep each list goes before fusion. */
const CANDIDATES = 200;

const COLUMNS = `
  s.id, s.captured_at, s.source_key, a.screenshot_id AS analyzed,
  COALESCE(u.short_description, a.short_description) AS short_description,
  COALESCE(u.likely_reason_saved, a.likely_reason_saved) AS likely_reason_saved,
  a.content_type, a.topics, a.sensitive, u.screenshot_id AS edited,
  (SELECT json_group_array(json_array(t.name, st.state)) FROM screenshot_tags st JOIN tags t ON t.id = st.tag_id
   WHERE st.screenshot_id = s.id AND st.state != 'rejected') AS tag_states
`;
const JOINS = `
  LEFT JOIN analyses a ON a.screenshot_id = s.id
  LEFT JOIN user_edits u ON u.screenshot_id = s.id
`;

type Params = Record<string, string | number | null>;

/** The WHERE clause (over s, a, u) for the filters, with its named parameters. */
function filterSql(options: SearchOptions): { where: string; params: Params } {
  const params: Params = {
    after: normalizeDateBound(options.after) ?? null,
    before: normalizeDateBound(options.before) ?? null,
    ctype: options.contentType ?? null,
  };
  const tagFilters = (options.tags ?? []).map((name, i) => {
    params[`tag${i}`] = tagKey(name);
    return `AND EXISTS (SELECT 1 FROM screenshot_tags st JOIN tags t ON t.id = st.tag_id
                WHERE st.screenshot_id = s.id AND t.name_key = :tag${i} AND st.state != 'rejected')`;
  });
  if (options.untagged) {
    tagFilters.push(
      "AND NOT EXISTS (SELECT 1 FROM screenshot_tags st WHERE st.screenshot_id = s.id AND st.state != 'rejected')",
    );
  }
  const where = `
    s.ignored = 0 AND s.missing_since IS NULL AND s.status IN ('extracted', 'analyzed')
    AND (:after IS NULL OR s.captured_at >= :after)
    AND (:before IS NULL OR s.captured_at < :before)
    AND (:ctype IS NULL OR a.content_type = :ctype)
    ${tagFilters.join("\n")}
  `;
  return { where, params };
}

interface Ranked {
  id: string;
  score?: number;
  match?: string;
}

export async function searchScreenshots(
  db: Db,
  options: SearchOptions,
  meaning?: MeaningSource,
): Promise<SearchResult> {
  const mode = options.mode ?? "auto";
  const hasTerms = Boolean(options.query?.trim() || options.also?.length);
  const match = mode === "semantic" ? undefined : buildMatchExpression(options.query, options.also);

  let queryVector: Float32Array | undefined;
  let semantic: SearchResult["semantic"];
  if (hasTerms && mode !== "keyword") {
    const text = options.query?.trim() || options.also!.join(", ");
    queryVector = meaning ? await meaning.queryVector(text) : undefined;
    semantic = queryVector
      ? { used: true }
      : { used: false, note: meaning?.unavailableReason() ?? "Semantic search isn't available." };
    if (!queryVector && mode === "semantic") throw new Error(semantic.note);
  }
  if (hasTerms && !match && !queryVector) {
    throw new Error("The query has no searchable words. Add specific terms, or use only filters.");
  }

  const { where, params } = filterSql(options);
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const keywordFrom = `
    FROM search_index
    JOIN screenshots s ON s.search_rowid = search_index.rowid
    ${JOINS}
    WHERE search_index MATCH :match AND ${where}
  `;
  const keywordRanked = (extra: string, p: Params) =>
    db
      .prepare(`
        SELECT s.id, bm25(search_index, ${SEARCH_WEIGHTS.join(", ")}) AS score,
               snippet(search_index, -1, '«', '»', '…', 12) AS match
        ${keywordFrom} ORDER BY score ${extra}
      `)
      .all({ ...params, match: match ?? null, ...p }) as unknown as Ranked[];

  let ranked: Array<Ranked & { similarity?: number; matched_by?: SearchHit["matched_by"] }>;
  let total: number;
  if (queryVector) {
    // Hybrid: fuse the keyword ranking with the meaning ranking.
    const keywords = match ? keywordRanked("LIMIT :candidates", { candidates: CANDIDATES }) : [];
    const vectors = meaning!.vectors();
    const eligible = db.prepare(`SELECT s.id FROM screenshots s ${JOINS} WHERE ${where}`).all(params) as Array<{
      id: string;
    }>;
    const similarity = new Map<string, number>();
    for (const { id } of eligible) {
      const v = vectors.get(id);
      if (v) similarity.set(id, cosine(queryVector, v));
    }
    const unindexed = eligible.length - similarity.size;
    if (unindexed > 0) {
      semantic = {
        used: true,
        note: `${unindexed} of ${eligible.length} screenshots aren't indexed for meaning yet (indexing runs in the background), so they matched on keywords only.`,
      };
    }
    const byMeaning = [...similarity].sort((a, b) => b[1] - a[1]);
    const cutoff = Math.max(MEANING_FLOOR, (byMeaning[0]?.[1] ?? 0) - MEANING_SPREAD);
    const meaningful = byMeaning.filter(([, sim]) => sim >= cutoff).slice(0, CANDIDATES);

    const fused = new Map<string, { score: number; match?: string; matched_by: Array<"keywords" | "meaning"> }>();
    keywords.forEach((hit, rank) => {
      fused.set(hit.id, { score: 1 / (FUSION_K + rank + 1), match: hit.match, matched_by: ["keywords"] });
    });
    meaningful.forEach(([id], rank) => {
      const entry = fused.get(id) ?? { score: 0, matched_by: [] };
      entry.score += 1 / (FUSION_K + rank + 1);
      entry.matched_by.push("meaning");
      fused.set(id, entry);
    });
    const best = 2 / (FUSION_K + 1);
    const ordered = [...fused].sort(
      (a, b) => b[1].score - a[1].score || (similarity.get(b[0]) ?? 0) - (similarity.get(a[0]) ?? 0),
    );
    total = ordered.length;
    ranked = ordered.slice(offset, offset + limit).map(([id, entry]) => ({
      id,
      score: Math.round((entry.score / best) * 100) / 100,
      match: entry.match,
      similarity: similarity.has(id) ? Math.round(similarity.get(id)! * 100) / 100 : undefined,
      matched_by: entry.matched_by,
    }));
  } else if (match) {
    ranked = keywordRanked("LIMIT :limit OFFSET :offset", { limit, offset }).map((r) => ({
      ...r,
      score: Math.round(-r.score! * 100) / 100,
    }));
    total = (db.prepare(`SELECT COUNT(*) AS n ${keywordFrom}`).get({ ...params, match }) as { n: number }).n;
  } else {
    const from = `FROM screenshots s ${JOINS} WHERE ${where}`;
    ranked = db
      .prepare(`SELECT s.id ${from} ORDER BY s.captured_at DESC LIMIT :limit OFFSET :offset`)
      .all({ ...params, limit, offset }) as unknown as Ranked[];
    total = (db.prepare(`SELECT COUNT(*) AS n ${from}`).get(params) as { n: number }).n;
  }

  const rows = new Map(
    (ranked.length
      ? (db
          .prepare(`SELECT ${COLUMNS} FROM screenshots s ${JOINS} WHERE s.id IN (${ranked.map(() => "?").join(", ")})`)
          .all(...ranked.map((r) => r.id)) as Array<Record<string, any>>)
      : []
    ).map((r) => [r.id as string, r]),
  );
  const unanalyzed = db
    .prepare(
      "SELECT COUNT(*) AS n FROM screenshots WHERE status = 'extracted' AND ignored = 0 AND missing_since IS NULL",
    )
    .get() as { n: number };

  return {
    match_expression: match,
    total,
    results: ranked.flatMap((hit) => {
      const r = rows.get(hit.id);
      if (!r) return [];
      const tagStates: Array<[string, string]> = (r.tag_states ? JSON.parse(r.tag_states) : []).sort(
        (a: [string, string], b: [string, string]) => a[0].localeCompare(b[0]),
      );
      return [
        {
          id: r.id,
          captured_at: r.captured_at,
          file: r.source_key,
          analyzed: r.analyzed !== null,
          short_description: r.short_description,
          likely_reason_saved: r.likely_reason_saved,
          content_type: r.content_type,
          topics: r.topics ? JSON.parse(r.topics) : [],
          tags: tagStates.filter(([, state]) => state !== "suggested").map(([name]) => name),
          suggested_tags: tagStates.filter(([, state]) => state === "suggested").map(([name]) => name),
          edited: r.edited !== null,
          sensitive: r.sensitive === 1,
          relevance: hit.score,
          similarity: hit.similarity,
          matched_by: hit.matched_by,
          match: hit.match ? String(hit.match).replace(/\s+/g, " ").trim() : undefined,
        },
      ];
    }),
    unanalyzed_in_library: unanalyzed.n,
    semantic,
  };
}

export interface StatsOptions {
  after?: string;
  before?: string;
  top?: number;
}

/** Aggregate picture of what the user has been screenshotting, optionally within a date range. */
export function libraryStats(db: Db, options: StatsOptions = {}) {
  const params = {
    after: normalizeDateBound(options.after) ?? null,
    before: normalizeDateBound(options.before) ?? null,
    top: Math.min(Math.max(options.top ?? 15, 1), 100),
  };
  const base = `
    WITH base AS (
      SELECT id, captured_at, status FROM screenshots
      WHERE ignored = 0 AND missing_since IS NULL
        AND (:after IS NULL OR captured_at >= :after)
        AND (:before IS NULL OR captured_at < :before)
    )
  `;
  const { top: _t, ...range } = params;
  // Spread rows: node:sqlite returns null-prototype objects.
  const all = <T>(sql: string, p: Record<string, string | number | null> = params) =>
    db.prepare(base + sql).all(p).map((row) => ({ ...row })) as T[];

  const totals = db
    .prepare(base + `
      SELECT COUNT(*) AS screenshots,
             SUM(status = 'analyzed') AS analyzed,
             SUM(status = 'extracted') AS awaiting_analysis,
             SUM(status = 'pending') AS awaiting_extraction,
             MIN(captured_at) AS earliest, MAX(captured_at) AS latest
      FROM base
    `)
    .get(range) as Record<string, number | string | null>;

  return {
    range: { after: params.after, before: params.before },
    totals: {
      screenshots: totals.screenshots ?? 0,
      analyzed: totals.analyzed ?? 0,
      awaiting_analysis: totals.awaiting_analysis ?? 0,
      awaiting_extraction: totals.awaiting_extraction ?? 0,
      earliest: totals.earliest,
      latest: totals.latest,
    },
    by_month: all<{ month: string; count: number }>(
      `SELECT strftime('%Y-%m', captured_at) AS month, COUNT(*) AS count FROM base
       GROUP BY month ORDER BY month DESC LIMIT 24`,
      range,
    ),
    content_types: all<{ content_type: string; count: number }>(
      `SELECT a.content_type, COUNT(*) AS count FROM base JOIN analyses a ON a.screenshot_id = base.id
       GROUP BY a.content_type ORDER BY count DESC`,
      range,
    ),
    top_topics: all<{ topic: string; count: number }>(
      `SELECT j.value AS topic, COUNT(DISTINCT a.screenshot_id) AS count
       FROM base JOIN analyses a ON a.screenshot_id = base.id, json_each(a.topics) j
       GROUP BY j.value ORDER BY count DESC, topic LIMIT :top`,
    ),
    top_entities: all<{ name: string; type: string; count: number }>(
      `SELECT json_extract(j.value, '$.name') AS name, json_extract(j.value, '$.type') AS type,
              COUNT(DISTINCT a.screenshot_id) AS count
       FROM base JOIN analyses a ON a.screenshot_id = base.id, json_each(a.entities) j
       GROUP BY lower(name), type ORDER BY count DESC, name LIMIT :top`,
    ),
    top_source_apps: all<{ source_app: string; count: number }>(
      `SELECT a.source_app, COUNT(*) AS count FROM base JOIN analyses a ON a.screenshot_id = base.id
       WHERE a.source_app IS NOT NULL GROUP BY lower(a.source_app) ORDER BY count DESC LIMIT :top`,
    ),
    tags: listTags(db).map(({ name, total, suggested }) => ({ name, count: total, suggested })),
    sensitive: (
      db
        .prepare(base + "SELECT COUNT(*) AS n FROM base JOIN analyses a ON a.screenshot_id = base.id WHERE a.sensitive = 1")
        .get(range) as { n: number }
    ).n,
  };
}
