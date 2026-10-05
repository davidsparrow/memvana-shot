import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ANALYSIS_GUIDE, AnalysisInput, CONTENT_TYPES } from "./analysis.ts";
import { Library, STATUSES } from "./library.ts";
import { SEARCH_MODES } from "./search.ts";
import { cleanUpAbandonedDownloads } from "./semantic/install.ts";
import { DOWNLOAD_BYTES } from "./semantic/model.ts";
import { VERSION } from "./version.ts";

const INSTRUCTIONS = `Memvana Shot keeps a local, persistent index of the user's screenshots on their Mac, from
folders and from the Photos library (connect_photos, only after the user agrees; macOS asks for permission once).
Pipeline: scan_screenshots (discover + on-device OCR/thumbnails) → get_analysis_batch / save_analyses (you look
at each screenshot and record what it is and why it was likely saved) → search_screenshots and
get_library_stats answer questions. Call get_status when unsure what to do next; it lists next steps.
Search with the user's words in \`query\` plus your own synonyms and visual descriptors in \`also\`. With semantic
search set up, search also matches by meaning, and get_related_screenshots finds screenshots related to one.
Tags are the user's own top-level groups: suggest them freely with suggest_tags, but only create, rename,
merge or delete tags when the user asks or agrees. The user's tag decisions and edits always win.
Screenshots are personal: never repeat secrets (passwords, codes, account numbers) and never claim to have
seen an image you have not retrieved.`;

const DOWNLOAD_MB = Math.round(DOWNLOAD_BYTES / 1_000_000);

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
}

/** Reports extraction progress to clients that asked for it. */
function progressReporter(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): ((done: number, total: number) => void) | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  return (done, total) => {
    void extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress: done, total, message: `Extracted ${done}/${total}` },
    });
  };
}

/** Appends thumbnails for the first `count` ids, so Claude can check them visually. */
async function attachThumbnails(library: Library, result: CallToolResult, ids: string[], count = 0): Promise<void> {
  for (const id of ids.slice(0, count)) {
    const thumb = library.get(id, { ocrMaxChars: 0 })?.thumb_path;
    if (!thumb) continue;
    try {
      const data = await readFile(thumb);
      result.content.push({ type: "text", text: `Thumbnail for ${id}:` });
      result.content.push({ type: "image", data: data.toString("base64"), mimeType: "image/jpeg" });
    } catch {
      // A missing thumbnail just means no preview for this one.
    }
  }
}

export function createServer(library: Library): McpServer {
  const server = new McpServer({ name: "memvana-shot", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "get_status",
    {
      title: "Library status",
      description:
        "Where the screenshot library lives, whether the native helper is ready, its sources (folders and " +
        "Photos), how many screenshots are pending, extracted, analyzed, missing or in error, whether the " +
        "Photos library can be or is connected (`photos`), and whether semantic search is set up and " +
        "indexed. With no sources yet it suggests likely screenshot folders.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return json(await library.status());
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "scan_screenshots",
    {
      title: "Scan for screenshots",
      description:
        "Finds new, changed and removed screenshots in every source: registered folders and, once " +
        "connected, the Photos library (or registers `folder` first and scans just it). Then runs on-device " +
        "extraction (OCR, Vision labels, thumbnail, visual fingerprint) on up to `extract_limit` pending " +
        "screenshots, newest first. Only new or changed screenshots are processed, so it is cheap to call " +
        "repeatedly. Nothing is uploaded and nothing is modified.",
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe("Folder to register and scan (absolute or ~/ path). Omit to rescan every source."),
        photos: z.boolean().optional().describe("Rescan only the Photos library."),
        extract_limit: z
          .number()
          .int()
          .min(0)
          .max(5000)
          .optional()
          .describe("Max screenshots to extract this call (default 250; 0 = discover only)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ folder, photos, extract_limit }, extra) => {
      try {
        return json(await library.scan({ folder, photos, extractLimit: extract_limit, onProgress: progressReporter(extra) }));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "connect_photos",
    {
      title: "Connect the Photos library",
      description:
        "Connects the user's Photos library: the Screenshots album, including iPhone screenshots synced " +
        "through iCloud Photos. The first time, macOS asks the user to let \"Memvana Shot\" access Photos, so " +
        "call this only after the user agrees, and tell them to expect the prompt. With access, it adds " +
        "Photos as a source and scans it like scan_screenshots (extracting up to `extract_limit`, newest " +
        "first). Read-only: nothing in Photos is changed. Without access it returns `fix`; with " +
        "`open_settings` it also opens the Photos pane of System Settings.",
      inputSchema: {
        extract_limit: z
          .number()
          .int()
          .min(0)
          .max(5000)
          .optional()
          .describe("Max screenshots to extract this call (default 250; 0 = discover only)."),
        open_settings: z
          .boolean()
          .optional()
          .describe("If access is off, open System Settings > Privacy & Security > Photos (only when the user asks)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ extract_limit, open_settings }, extra) => {
      try {
        return json(
          await library.connectPhotos({
            extractLimit: extract_limit,
            openSettings: open_settings,
            onProgress: progressReporter(extra),
          }),
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "list_screenshots",
    {
      title: "List screenshots",
      description:
        "Lists indexed screenshots by capture date with a short OCR snippet. Use for browsing and " +
        "pipeline checks; use get_screenshot to see one.",
      inputSchema: {
        status: z.enum(STATUSES).optional().describe("Only screenshots in this pipeline state."),
        order: z.enum(["newest", "oldest"]).optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Default 25."),
        offset: z.number().int().min(0).optional(),
        include_missing: z.boolean().optional().describe("Include screenshots whose files have disappeared."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status, order, limit, offset, include_missing }) => {
      try {
        return json(library.list({ status, order, limit, offset, includeMissing: include_missing }));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "get_screenshot",
    {
      title: "Get screenshot",
      description:
        "Full record for one screenshot: dates, dimensions, source file, OCR text, Vision labels, metadata, " +
        "Claude's analysis, the user's edits, the effective details (edits win), and tags with their states, " +
        "plus the thumbnail image so you can actually look at it.",
      inputSchema: {
        id: z.string().describe("Screenshot id."),
        include_image: z.boolean().optional().describe("Attach the thumbnail (default true)."),
        ocr_max_chars: z.number().int().min(0).max(50_000).optional().describe("Default 4000."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, include_image, ocr_max_chars }) => {
      try {
        const detail = library.get(id, { ocrMaxChars: ocr_max_chars });
        if (!detail) return failure(new Error(`No screenshot with id ${id}`));
        const result = json(detail);
        if (include_image !== false && detail.thumb_path) {
          try {
            const data = await readFile(detail.thumb_path);
            result.content.push({ type: "image", data: data.toString("base64"), mimeType: "image/jpeg" });
          } catch {
            result.content.push({ type: "text", text: "(thumbnail file is missing; rescan to regenerate)" });
          }
        }
        return result;
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "get_analysis_batch",
    {
      title: "Get screenshots to analyze",
      description:
        "Hands out the next batch of extracted screenshots that need understanding (newest first), each with " +
        "its thumbnail image, OCR text and Vision labels, plus the analysis guide. Look at each one, then " +
        "record your analysis with save_analyses. Batches are leased for 15 minutes so parallel analysts " +
        "never get the same screenshots. Pass `ids` to take a second look at specific screenshots.",
      inputSchema: {
        limit: z.number().int().min(1).max(12).optional().describe("Screenshots per batch (default 6)."),
        ids: z.array(z.string()).max(12).optional().describe("Re-analyze these specific screenshots."),
        include_guide: z
          .boolean()
          .optional()
          .describe("Include the analysis guide (default true; pass false after the first batch)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ limit, ids, include_guide }) => {
      try {
        const { items, remaining } = library.analysisBatch({ limit, ids });
        const content: CallToolResult["content"] = [];
        const tagVocabulary = library.tagVocabulary();
        const header = {
          batch_size: items.length,
          remaining_after_this_batch: remaining,
          tag_vocabulary: tagVocabulary.length ? tagVocabulary : undefined,
          next:
            items.length === 0
              ? "Nothing left to analyze."
              : "Analyze each screenshot below, then call save_analyses once with one entry per id.",
        };
        content.push({ type: "text", text: JSON.stringify(header, null, 2) });
        if (items.length && include_guide !== false) content.push({ type: "text", text: ANALYSIS_GUIDE });
        for (const item of items) {
          const { thumb_path, ...facts } = item;
          content.push({ type: "text", text: `Screenshot ${item.id}\n${JSON.stringify(facts, null, 2)}` });
          if (thumb_path) {
            try {
              const data = await readFile(thumb_path);
              content.push({ type: "image", data: data.toString("base64"), mimeType: "image/jpeg" });
            } catch {
              content.push({ type: "text", text: "(thumbnail missing: analyze from the OCR text, lower confidence)" });
            }
          }
        }
        return { content };
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "save_analyses",
    {
      title: "Save screenshot analyses",
      description:
        "Records your understanding of screenshots from get_analysis_batch: description, likely reason saved, " +
        "content type, entities, topics and search keywords. Saving again for the same id replaces the " +
        "previous analysis. Follow the analysis guide.",
      inputSchema: {
        analyses: z.array(AnalysisInput).min(1).max(20),
        model: z.string().max(80).optional().describe("Model that wrote these analyses, if known."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ analyses, model }) => {
      try {
        return json(library.saveAnalyses(analyses, model));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "search_screenshots",
    {
      title: "Search screenshots",
      description:
        "Searches each screenshot's description, likely reason saved, the user's notes, tags, topics, keywords, " +
        "entities, OCR text and file name. Keyword matching uses `query` plus your expansion terms in `also` " +
        "(synonyms, related concepts, visual descriptors), OR-ed so screenshots matching more terms rank " +
        "higher. When semantic search is set up, results also match by meaning (the `query` is embedded " +
        "locally) and the two rankings are fused; each hit says whether it `matched_by` keywords, meaning or " +
        "both, with its meaning `similarity`. `semantic.note` explains when meaning matching didn't run. " +
        "Without query terms it lists screenshots matching the filters, newest first.",
      inputSchema: {
        query: z.string().max(500).optional().describe('The user\'s words. "Quoted phrases" match exactly.'),
        also: z
          .array(z.string().max(80))
          .max(30)
          .optional()
          .describe("Expansion terms or phrases: synonyms, related concepts, visual descriptors."),
        content_type: z.enum(CONTENT_TYPES).optional(),
        tags: z.array(z.string()).max(5).optional().describe("Only screenshots carrying all of these tags."),
        untagged: z.boolean().optional().describe("Only screenshots with no tags."),
        after: z.string().optional().describe("Captured on/after: YYYY, YYYY-MM, YYYY-MM-DD or ISO time."),
        before: z.string().optional().describe("Captured before (exclusive), same formats."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
        offset: z.number().int().min(0).optional(),
        mode: z
          .enum(SEARCH_MODES)
          .optional()
          .describe("auto (default): keywords plus meaning when available. keyword or semantic: one kind only."),
        include_images: z
          .number()
          .int()
          .min(0)
          .max(6)
          .optional()
          .describe("Attach thumbnails of the top N results so you can check them visually (default 0)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, also, content_type, tags, untagged, after, before, limit, offset, mode, include_images }) => {
      try {
        const found = await library.search({
          query, also, contentType: content_type, tags, untagged, after, before, limit, offset, mode,
        });
        const result = json(found);
        await attachThumbnails(library, result, found.results.map((hit) => hit.id), include_images);
        return result;
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "get_related_screenshots",
    {
      title: "Related screenshots",
      description:
        "Screenshots related to one screenshot, strongest first, each with the reasons that connect them: " +
        "similar subject (meaning, when semantic search is set up), looks alike or near-duplicate (visual " +
        "fingerprint), shared tags, names or topics, captured minutes apart, or the same folder. Use for " +
        "\"more like this\", \"what else did I save about this?\" and spotting duplicates.",
      inputSchema: {
        id: z.string().describe("The screenshot to start from."),
        limit: z.number().int().min(1).max(30).optional().describe("Default 8."),
        include_images: z
          .number()
          .int()
          .min(0)
          .max(6)
          .optional()
          .describe("Attach thumbnails of the top N related screenshots (default 0)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, limit, include_images }) => {
      try {
        const related = library.related(id, { limit });
        const result = json(related);
        await attachThumbnails(library, result, related.results.map((hit) => hit.id), include_images);
        return result;
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "setup_semantic_search",
    {
      title: "Set up semantic search",
      description:
        "Starts the one-time download that enables search by meaning and better related screenshots: " +
        `Google's EmbeddingGemma model (under the Gemma Terms of Use) and ONNX Runtime, about ${DOWNLOAD_MB} MB, which ` +
        "then run on this Mac. Only call this after the user agrees; tell them the size and the license " +
        "first. Returns at once; the download continues in the background (watch get_status), and existing " +
        "screenshots are indexed automatically when it finishes. Safe to call again after a failure. If the " +
        "user says no, call it with `declined: true` instead so it isn't offered again.",
      inputSchema: {
        declined: z.boolean().optional().describe("The user said no: remember that and download nothing."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ declined }) => {
      try {
        return json(library.setupSemantic({ declined }));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "rebuild_index",
    {
      title: "Rebuild the search index",
      description:
        "Rebuilds the keyword search index from the stored screenshot details. With `semantic: true` it also " +
        "discards every meaning vector and re-embeds all screenshots in the background (about a minute per " +
        "thousand). Nothing the user or Claude wrote is lost. Use when search seems out of date or after a " +
        "problem; it is never needed in normal use.",
      inputSchema: {
        semantic: z.boolean().optional().describe("Also rebuild the semantic (meaning) index."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ semantic }) => {
      try {
        return json(await library.rebuildIndex({ semantic }));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "get_library_stats",
    {
      title: "Library overview",
      description:
        "What the user has been screenshotting: totals, captures per month, content types, top topics, " +
        "entities and source apps, optionally within a date range. Use for questions like \"what have I been " +
        "saving lately?\" and for the first-run overview.",
      inputSchema: {
        after: z.string().optional().describe("YYYY, YYYY-MM, YYYY-MM-DD or ISO time."),
        before: z.string().optional().describe("Exclusive upper bound, same formats."),
        top: z.number().int().min(1).max(100).optional().describe("Items per ranked list (default 15)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ after, before, top }) => {
      try {
        return json(library.stats({ after, before, top }));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "open_screenshot",
    {
      title: "Open original screenshot",
      description:
        "Opens the original screenshot file on the user's Mac in its default app (usually Preview), or " +
        "reveals it in Finder. A screenshot from Photos opens as an exported copy (it has no file to " +
        "reveal). Use when the user wants to see or use the actual image.",
      inputSchema: {
        id: z.string(),
        reveal: z.boolean().optional().describe("Reveal in Finder instead of opening (default false)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, reveal }) => {
      try {
        return json(await library.open(id, reveal));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "list_tags",
    {
      title: "List tags",
      description:
        "The user's tags with descriptions and counts: how many screenshots carry each tag, split into " +
        "added (by the user or Finder), confirmed (accepted suggestions) and suggested (Claude's, unconfirmed).",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return json(library.listTags());
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "create_tags",
    {
      title: "Create tags",
      description:
        "Adds tags to the user's vocabulary, each with a one-line description of what belongs in it (this " +
        "keeps later suggestions consistent). Only create tags the user asked for or agreed to. Existing " +
        "names are reused, and their descriptions updated.",
      inputSchema: {
        tags: z
          .array(z.object({ name: z.string().min(1).max(40), description: z.string().max(200).optional() }))
          .min(1)
          .max(30),
        proposed_by_ai: z.boolean().optional().describe("True when you proposed these tags and the user approved."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ tags, proposed_by_ai }) => {
      try {
        return json(library.createTags(tags, proposed_by_ai ? "ai" : "user"));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "edit_tag",
    {
      title: "Edit a tag",
      description:
        "Rename a tag (renaming onto an existing tag merges them), change its description, merge it into " +
        "another tag, delete it, or confirm or reject all of its pending suggestions at once. Only on the " +
        "user's request.",
      inputSchema: {
        name: z.string().describe("The tag to change."),
        rename_to: z.string().max(40).optional(),
        description: z.string().max(200).optional().describe('"" clears it.'),
        merge_into: z.string().optional().describe("Move this tag's screenshots into that tag, then remove this one."),
        delete: z.boolean().optional().describe("Remove the tag from the vocabulary and from every screenshot."),
        confirm_suggestions: z.boolean().optional().describe("Accept every pending suggestion of this tag."),
        reject_suggestions: z.boolean().optional().describe("Reject every pending suggestion of this tag."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ name, rename_to, description, merge_into, delete: del, confirm_suggestions, reject_suggestions }) => {
      try {
        return json(
          library.editTag(name, {
            renameTo: rename_to,
            description,
            mergeInto: merge_into,
            delete: del,
            confirmSuggestions: confirm_suggestions,
            rejectSuggestions: reject_suggestions,
          }),
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "tag_screenshots",
    {
      title: "Tag screenshots (user)",
      description:
        "Applies the user's tagging decision to screenshots. `add` puts tags on, creating tags that don't " +
        "exist yet and confirming any matching suggestions. `remove` takes tags off and records the user's " +
        "rejection, so the tag won't be suggested for those screenshots again. Use this only for what the " +
        "user asked; use suggest_tags for your own guesses.",
      inputSchema: {
        ids: z.array(z.string()).min(1).max(200),
        add: z.array(z.string().min(1).max(40)).max(10).optional(),
        remove: z.array(z.string().min(1).max(40)).max(10).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ ids, add, remove }) => {
      try {
        return json(library.tagScreenshots(ids, { add, remove }));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "suggest_tags",
    {
      title: "Suggest tags (Claude)",
      description:
        "Records your tag suggestions for screenshots. Only existing tags can be suggested, and anything the " +
        "user already decided, including rejections, is left untouched. Include every screenshot you " +
        "considered, with an empty list when nothing fits, so it isn't offered for tagging again.",
      inputSchema: {
        suggestions: z
          .array(
            z.object({
              id: z.string(),
              tags: z.array(z.string().min(1).max(40)).max(8),
              confidence: z.number().min(0).max(1).optional(),
            }),
          )
          .min(1)
          .max(100),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ suggestions }) => {
      try {
        return json(library.suggestTags(suggestions));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "get_tagging_batch",
    {
      title: "Get screenshots to tag",
      description:
        "Text-only summaries of analyzed screenshots that haven't been considered for tags yet: description, " +
        "reason saved, topics, file name and folder, plus current and rejected tags. Also returns the tag " +
        "vocabulary. No images, so tagging is cheap. Answer with suggest_tags.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Default 40."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) => {
      try {
        const vocabularyNow = library.tagVocabulary();
        if (!vocabularyNow.length) {
          return failure(new Error("There are no tags yet. Propose some to the user and create_tags first."));
        }
        return json({ tag_vocabulary: vocabularyNow, ...library.taggingBatch(limit) });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "edit_screenshot",
    {
      title: "Edit screenshot details",
      description:
        "Applies the user's own edits to a screenshot. You can override the short description, detailed " +
        "description or likely reason saved; add personal notes; add or remove search keywords; or hide " +
        "the screenshot (`ignored`). Edits override Claude's analysis, are searchable, and survive " +
        "re-analysis. Pass null or \"\" for a text field to go back to Claude's version.",
      inputSchema: {
        id: z.string(),
        short_description: z.string().max(200).nullable().optional(),
        detailed_description: z.string().max(2000).nullable().optional(),
        likely_reason_saved: z.string().max(400).nullable().optional(),
        notes: z.string().max(4000).nullable().optional().describe("The user's own notes about this screenshot."),
        add_keywords: z.array(z.string().min(1).max(60)).max(25).optional(),
        remove_keywords: z.array(z.string().min(1).max(60)).max(25).optional(),
        ignored: z.boolean().optional().describe("Hide from search, stats and analysis (false to restore)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, ...input }) => {
      try {
        return json(library.edit(id, input));
      } catch (err) {
        return failure(err);
      }
    },
  );

  return server;
}

export async function runServer(library: Library = Library.open()): Promise<void> {
  // Keep meaning vectors current in the background, starting with anything
  // changed while the server wasn't running.
  library.semantic.autoRefresh = true;
  library.semantic.schedule();
  cleanUpAbandonedDownloads(library.config);
  const server = createServer(library);
  await server.connect(new StdioServerTransport());
  const shutdown = () => {
    library.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
