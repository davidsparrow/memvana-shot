import type { Db } from "./db.ts";
import { SEARCH_WEIGHTS } from "./search-index.ts";

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

export interface SearchOptions {
  query?: string;
  also?: string[];
  contentType?: string;
  after?: string;
  before?: string;
  limit?: number;
  offset?: number;
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
  sensitive: boolean;
  relevance?: number;
  match?: string;
}

export interface SearchResult {
  match_expression?: string;
  total: number;
  results: SearchHit[];
  /** Extracted but not yet analyzed: only their OCR text and file name are searchable. */
  unanalyzed_in_library: number;
}

export function searchScreenshots(db: Db, options: SearchOptions): SearchResult {
  const match = buildMatchExpression(options.query, options.also);
  if (!match && (options.query?.trim() || options.also?.length)) {
    throw new Error("The query has no searchable words. Add specific terms, or use only filters.");
  }
  const params = {
    match: match ?? null,
    after: normalizeDateBound(options.after) ?? null,
    before: normalizeDateBound(options.before) ?? null,
    ctype: options.contentType ?? null,
    limit: Math.min(Math.max(options.limit ?? 20, 1), 100),
    offset: Math.max(options.offset ?? 0, 0),
  };
  const filters = `
    s.ignored = 0 AND s.missing_since IS NULL AND s.status IN ('extracted', 'analyzed')
    AND (:after IS NULL OR s.captured_at >= :after)
    AND (:before IS NULL OR s.captured_at < :before)
    AND (:ctype IS NULL OR a.content_type = :ctype)
  `;
  const columns = `
    s.id, s.captured_at, s.source_key, a.screenshot_id AS analyzed, a.short_description,
    a.likely_reason_saved, a.content_type, a.topics, a.sensitive
  `;

  let rows: Array<Record<string, any>>;
  let total: number;
  if (match) {
    const from = `
      FROM search_index
      JOIN screenshots s ON s.search_rowid = search_index.rowid
      LEFT JOIN analyses a ON a.screenshot_id = s.id
      WHERE search_index MATCH :match AND ${filters}
    `;
    rows = db
      .prepare(`
        SELECT ${columns},
               bm25(search_index, ${SEARCH_WEIGHTS.join(", ")}) AS score,
               snippet(search_index, -1, '«', '»', '…', 12) AS match
        ${from}
        ORDER BY score LIMIT :limit OFFSET :offset
      `)
      .all(params) as Array<Record<string, any>>;
    const { limit: _l, offset: _o, ...countParams } = params;
    total = (db.prepare(`SELECT COUNT(*) AS n ${from}`).get(countParams) as { n: number }).n;
  } else {
    const from = `FROM screenshots s LEFT JOIN analyses a ON a.screenshot_id = s.id WHERE ${filters}`;
    const { match: _m, ...rest } = params;
    rows = db
      .prepare(`SELECT ${columns} ${from} ORDER BY s.captured_at DESC LIMIT :limit OFFSET :offset`)
      .all(rest) as Array<Record<string, any>>;
    const { limit: _l, offset: _o, ...countParams } = rest;
    total = (db.prepare(`SELECT COUNT(*) AS n ${from}`).get(countParams) as { n: number }).n;
  }

  const unanalyzed = db
    .prepare(
      "SELECT COUNT(*) AS n FROM screenshots WHERE status = 'extracted' AND ignored = 0 AND missing_since IS NULL",
    )
    .get() as { n: number };

  return {
    match_expression: match,
    total,
    results: rows.map((r) => ({
      id: r.id,
      captured_at: r.captured_at,
      file: r.source_key,
      analyzed: r.analyzed !== null,
      short_description: r.short_description,
      likely_reason_saved: r.likely_reason_saved,
      content_type: r.content_type,
      topics: r.topics ? JSON.parse(r.topics) : [],
      sensitive: r.sensitive === 1,
      relevance: typeof r.score === "number" ? Math.round(-r.score * 100) / 100 : undefined,
      match: r.match ? String(r.match).replace(/\s+/g, " ").trim() : undefined,
    })),
    unanalyzed_in_library: unanalyzed.n,
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
    sensitive: (
      db
        .prepare(base + "SELECT COUNT(*) AS n FROM base JOIN analyses a ON a.screenshot_id = base.id WHERE a.sensitive = 1")
        .get(range) as { n: number }
    ).n,
  };
}
