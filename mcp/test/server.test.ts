import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import { VERSION } from "../src/version.ts";
import { REPO_ROOT, type TempLibrary, needsHelper, tempLibrary } from "./helpers.ts";

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
  test("exposes the V0 tools", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "get_screenshot",
      "get_status",
      "list_screenshots",
      "scan_screenshots",
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

describe("versions", () => {
  test("package.json, plugin.json and the server agree", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    const plugin = JSON.parse(readFileSync(join(REPO_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(pkg.version, VERSION);
    assert.equal(plugin.version, VERSION);
  });
});
