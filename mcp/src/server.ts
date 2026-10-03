import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ANALYSIS_GUIDE, AnalysisInput, CONTENT_TYPES } from "./analysis.ts";
import { Library, STATUSES } from "./library.ts";
import { VERSION } from "./version.ts";

const INSTRUCTIONS = `Memvana Shot keeps a local, persistent index of the user's screenshots on their Mac.
Pipeline: scan_screenshots (discover + on-device OCR/thumbnails) → get_analysis_batch / save_analyses (you look
at each screenshot and record what it is and why it was likely saved) → search_screenshots and
get_library_stats answer questions. Call get_status when unsure what to do next; it lists next steps.
Search with the user's words in \`query\` plus your own synonyms and visual descriptors in \`also\`.
Screenshots are personal: never repeat secrets (passwords, codes, account numbers) and never claim to have
seen an image you have not retrieved.`;

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
}

export function createServer(library: Library): McpServer {
  const server = new McpServer({ name: "memvana-shot", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "get_status",
    {
      title: "Library status",
      description:
        "Where the screenshot library lives, whether the native helper is ready, registered folders, " +
        "and how many screenshots are pending, extracted, analyzed, missing or in error. " +
        "When no folders are registered it suggests likely screenshot folders.",
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
        "Finds new, changed and removed screenshots in registered folders (or registers `folder` first), " +
        "then runs on-device extraction (OCR, Vision labels, thumbnail, visual fingerprint) on up to " +
        "`extract_limit` pending screenshots, newest first. Only new or changed files are processed, so it " +
        "is cheap to call repeatedly. Nothing is uploaded and no files are modified.",
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe("Folder to register and scan (absolute or ~/ path). Omit to rescan registered folders."),
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
    async ({ folder, extract_limit }, extra) => {
      try {
        const progressToken = extra._meta?.progressToken;
        const summary = await library.scan({
          folder,
          extractLimit: extract_limit,
          onProgress: progressToken === undefined
            ? undefined
            : (done, total) => {
                void extra.sendNotification({
                  method: "notifications/progress",
                  params: { progressToken, progress: done, total, message: `Extracted ${done}/${total}` },
                });
              },
        });
        return json(summary);
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
        "Full record for one screenshot: dates, dimensions, source file, OCR text, Vision labels, metadata " +
        "and the saved analysis (if any), plus the thumbnail image so you can actually look at it.",
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
        const header = {
          batch_size: items.length,
          remaining_after_this_batch: remaining,
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
        "Full-text search over each screenshot's description, likely reason saved, topics, keywords, entities, " +
        "OCR text, Vision labels and file name, ranked by relevance. Put the user's words in `query`. Put " +
        "your own expansion in `also`: synonyms, related concepts and visual descriptors, so conceptual " +
        "searches work even when the words never appear in the screenshot. Terms are OR-ed; screenshots " +
        "matching more terms rank higher. Without query terms it lists screenshots matching the filters, " +
        "newest first.",
      inputSchema: {
        query: z.string().max(500).optional().describe('The user\'s words. "Quoted phrases" match exactly.'),
        also: z
          .array(z.string().max(80))
          .max(30)
          .optional()
          .describe("Expansion terms or phrases: synonyms, related concepts, visual descriptors."),
        content_type: z.enum(CONTENT_TYPES).optional(),
        after: z.string().optional().describe("Captured on/after: YYYY, YYYY-MM, YYYY-MM-DD or ISO time."),
        before: z.string().optional().describe("Captured before (exclusive), same formats."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
        offset: z.number().int().min(0).optional(),
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
    async ({ query, also, content_type, after, before, limit, offset, include_images }) => {
      try {
        const found = library.search({ query, also, contentType: content_type, after, before, limit, offset });
        const result = json(found);
        for (const hit of found.results.slice(0, include_images ?? 0)) {
          const thumb = library.get(hit.id, { ocrMaxChars: 0 })?.thumb_path;
          if (!thumb) continue;
          try {
            const data = await readFile(thumb);
            result.content.push({ type: "text", text: `Thumbnail for ${hit.id}:` });
            result.content.push({ type: "image", data: data.toString("base64"), mimeType: "image/jpeg" });
          } catch {
            // A missing thumbnail just means no preview for this hit.
          }
        }
        return result;
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
        "reveals it in Finder. Use when the user wants to see or use the actual file.",
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

  return server;
}

export async function runServer(library: Library = Library.open()): Promise<void> {
  const server = createServer(library);
  await server.connect(new StdioServerTransport());
  const shutdown = () => {
    library.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
