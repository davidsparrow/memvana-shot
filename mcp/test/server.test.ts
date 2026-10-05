import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import { VERSION } from "../src/version.ts";
import { FIXTURE_ANALYSES, REPO_ROOT, type TempLibrary, needsHelper, tempLibrary } from "./helpers.ts";

let t: TempLibrary;
let client: Client;

beforeEach(async () => {
  t = tempLibrary();
  const server = createServer(t.library);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
});
afterEach(async () => {
  await client.close();
  t.cleanup();
});

const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "";

describe("MCP server", () => {
  test("exposes the tools", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "create_tags",
      "edit_screenshot",
      "edit_tag",
      "get_analysis_batch",
      "get_library_stats",
      "get_related_screenshots",
      "get_screenshot",
      "get_status",
      "get_tagging_batch",
      "list_screenshots",
      "list_tags",
      "open_screenshot",
      "rebuild_index",
      "save_analyses",
      "scan_screenshots",
      "search_screenshots",
      "setup_semantic_search",
      "suggest_tags",
      "tag_screenshots",
    ]);
  });

  test("reports tool errors as isError results", async () => {
    const missing = await client.callTool({ name: "get_screenshot", arguments: { id: "nope" } });
    assert.equal(missing.isError, true);
    assert.match(text(missing), /No screenshot/);
  });

  test("scan → list → get returns OCR and the thumbnail image", needsHelper, async () => {
    const scan = await client.callTool({ name: "scan_screenshots", arguments: { folder: t.folder } });
    assert.equal(scan.isError, undefined);
    assert.equal(JSON.parse(text(scan)).extraction.succeeded, 5);

    const list = JSON.parse(text(await client.callTool({ name: "list_screenshots", arguments: { limit: 10 } })));
    const chips = list.find((r: { file: string }) => r.file.startsWith("Screenshot 2025-08-03"));
    assert.ok(chips);

    const got = await client.callTool({ name: "get_screenshot", arguments: { id: chips.id } });
    assert.match(JSON.parse(text(got)).ocr.text, /KETTLE COOKED/);
    const image = (got.content as Array<{ type: string; mimeType?: string; data?: string }>).find(
      (c) => c.type === "image",
    );
    assert.equal(image?.mimeType, "image/jpeg");
    assert.ok((image?.data ?? "").length > 1000);

    const noImage = await client.callTool({ name: "get_screenshot", arguments: { id: chips.id, include_image: false } });
    assert.equal((noImage.content as unknown[]).length, 1);
  });
});

type Block = { type: string; text?: string; data?: string; mimeType?: string };
const blocks = (result: Awaited<ReturnType<Client["callTool"]>>) => result.content as Block[];

describe("MCP analysis and search tools", needsHelper, () => {
  test("analysis round trip: batch with images and guide, save, then search", async () => {
    await client.callTool({ name: "scan_screenshots", arguments: { folder: t.folder } });

    const batch = await client.callTool({ name: "get_analysis_batch", arguments: { limit: 2 } });
    const content = blocks(batch);
    assert.equal(JSON.parse(content[0]!.text!).batch_size, 2);
    assert.match(content[1]!.text!, /How to analyze screenshots/);
    assert.equal(content.filter((c) => c.type === "image").length, 2);
    const batchIds = content
      .filter((c) => c.text?.startsWith("Screenshot "))
      .map((c) => c.text!.split("\n")[0]!.slice("Screenshot ".length));
    assert.equal(batchIds.length, 2);

    const quiet = await client.callTool({ name: "get_analysis_batch", arguments: { limit: 1, include_guide: false } });
    assert.ok(!blocks(quiet).some((c) => c.text?.includes("How to analyze")));

    const listed = JSON.parse(text(await client.callTool({ name: "list_screenshots", arguments: { limit: 10 } })));
    const analyses = listed.map((r: { id: string; file: string }) => ({ id: r.id, ...FIXTURE_ANALYSES[r.file] }));
    const saved = await client.callTool({ name: "save_analyses", arguments: { analyses, model: "test" } });
    assert.deepEqual(JSON.parse(text(saved)), { saved: 5, errors: [], remaining: 0 });

    const search = await client.callTool({
      name: "search_screenshots",
      arguments: { query: "snack bag design", also: ["packaging"], include_images: 1 },
    });
    const found = JSON.parse(text(search));
    assert.equal(found.results[0].file, "Screenshot 2025-08-03 at 4.15.22 PM.png");
    assert.equal(blocks(search).filter((c) => c.type === "image").length, 1);

    const stats = JSON.parse(text(await client.callTool({ name: "get_library_stats", arguments: {} })));
    assert.equal(stats.totals.analyzed, 5);
  });

  test("save_analyses rejects analyses that break the schema", async () => {
    const bad = await client.callTool({
      name: "save_analyses",
      arguments: { analyses: [{ id: "x", short_description: "only this" }] },
    });
    assert.equal(bad.isError, true);
  });

  test("open_screenshot opens the original file, or reveals it", async () => {
    const opened: Array<[string, boolean]> = [];
    t.library.opener = async (path, reveal) => {
      opened.push([path, reveal]);
    };
    await client.callTool({ name: "scan_screenshots", arguments: { folder: t.folder } });
    const [first] = JSON.parse(text(await client.callTool({ name: "list_screenshots", arguments: { limit: 1 } })));
    await client.callTool({ name: "open_screenshot", arguments: { id: first.id } });
    await client.callTool({ name: "open_screenshot", arguments: { id: first.id, reveal: true } });
    assert.equal(opened.length, 2);
    assert.ok(opened[0]![0].startsWith(t.folder));
    assert.deepEqual(opened.map(([, reveal]) => reveal), [false, true]);

    const missing = await client.callTool({ name: "open_screenshot", arguments: { id: "nope" } });
    assert.equal(missing.isError, true);
  });
});

describe("MCP tag and edit tools", needsHelper, () => {
  test("create, tag, suggest, edit and filter through the protocol", async () => {
    await client.callTool({ name: "scan_screenshots", arguments: { folder: t.folder } });
    const listed = JSON.parse(text(await client.callTool({ name: "list_screenshots", arguments: { limit: 10 } })));
    const analyses = listed.map((r: { id: string; file: string }) => ({ id: r.id, ...FIXTURE_ANALYSES[r.file] }));
    await client.callTool({ name: "save_analyses", arguments: { analyses } });
    const id = (file: string) => listed.find((r: { file: string }) => r.file === file).id as string;

    const noVocab = await client.callTool({ name: "get_tagging_batch", arguments: {} });
    assert.equal(noVocab.isError, true);

    await client.callTool({
      name: "create_tags",
      arguments: { tags: [{ name: "Coffee", description: "Coffee gear and orders" }], proposed_by_ai: true },
    });
    const batch = JSON.parse(text(await client.callTool({ name: "get_tagging_batch", arguments: { limit: 10 } })));
    assert.deepEqual(batch.tag_vocabulary, [{ name: "Coffee", description: "Coffee gear and orders" }]);
    assert.equal(batch.items.length, 5);

    const suggestions = batch.items.map((i: { id: string; file_name: string }) => ({
      id: i.id,
      tags: i.file_name === "receipt.jpg" ? ["Coffee"] : [],
    }));
    const suggested = JSON.parse(text(await client.callTool({ name: "suggest_tags", arguments: { suggestions } })));
    assert.equal(suggested.suggested, 1);

    await client.callTool({ name: "tag_screenshots", arguments: { ids: [id("receipt.jpg")], add: ["Coffee", "Kitchen"] } });
    const tags = JSON.parse(text(await client.callTool({ name: "list_tags", arguments: {} })));
    assert.deepEqual(
      tags.map((tag: { name: string; confirmed: number; added: number }) => [tag.name, tag.confirmed, tag.added]),
      [["Coffee", 1, 0], ["Kitchen", 0, 1]],
    );

    const edited = await client.callTool({
      name: "edit_screenshot",
      arguments: { id: id("receipt.jpg"), notes: "Gift for Sam", short_description: null },
    });
    assert.equal(JSON.parse(text(edited)).details.notes, "Gift for Sam");

    const found = JSON.parse(
      text(await client.callTool({ name: "search_screenshots", arguments: { query: "gift", tags: ["coffee"] } })),
    );
    assert.equal(found.results[0].file, "receipt.jpg");
    assert.deepEqual(found.results[0].tags, ["Coffee", "Kitchen"]);

    const renamed = await client.callTool({ name: "edit_tag", arguments: { name: "Kitchen", merge_into: "Coffee" } });
    assert.equal(JSON.parse(text(renamed)).merged_into, "Coffee");
  });
});

describe("versions", () => {
  test("package.json, plugin.json and the server agree", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    const plugin = JSON.parse(readFileSync(join(REPO_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(pkg.version, VERSION);
    assert.equal(plugin.version, VERSION);
  });
});
