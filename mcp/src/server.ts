import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Library, STATUSES } from "./library.ts";
import { VERSION } from "./version.ts";

const INSTRUCTIONS = `Memvana Shot keeps a local, persistent index of the user's screenshots on their Mac.
Call get_status first when you need to know whether the library is set up. scan_screenshots discovers new
or changed files in registered folders and runs on-device extraction (OCR, labels, thumbnails) in batches.
Screenshots are personal: show only what the user asks about, and never claim to have seen an image you
have not retrieved with get_screenshot.`;

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
        "Full record for one screenshot: dates, dimensions, source file, OCR text, Vision labels and " +
        "metadata, plus the thumbnail image so you can actually look at it.",
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
