import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import { embeddingDocuments } from "../src/semantic/documents.ts";
import { ProcessEmbedder } from "../src/semantic/embedder.ts";
import { download, installSemantic } from "../src/semantic/install.ts";
import { RUNTIME, isInstalled, platformSupport } from "../src/semantic/model.ts";
import { cosine } from "../src/semantic/vectors.ts";
import { FakeEmbedder, fakeVector } from "./fake-embedder.ts";
import { REPO_ROOT, type TempLibrary, analyzedLibrary, needsHelper, tempLibrary } from "./helpers.ts";

const CHIPS = "Screenshot 2025-08-03 at 4.15.22 PM.png";
const RECEIPT = "receipt.jpg";
const PICKLEBALL = "window-shadow.png";

let t: TempLibrary;
let fake: FakeEmbedder;
let ids: Map<string, string>;
const id = (file: string) => ids.get(file)!;

describe("semantic search", needsHelper, () => {
  beforeEach(async () => {
    fake = new FakeEmbedder();
    t = tempLibrary({ embedder: fake });
    ids = await analyzedLibrary(t);
    await t.library.semantic.refresh();
  });
  afterEach(() => t.cleanup());

  test("finds a screenshot by meaning when no keyword matches", async () => {
    const keyword = await t.library.search({ query: "crinkly wrapper", mode: "keyword" });
    assert.equal(keyword.total, 0);

    const found = await t.library.search({ query: "crinkly wrapper" });
    assert.deepEqual(found.semantic, { used: true });
    assert.equal(found.results[0]?.file, CHIPS);
    assert.deepEqual(found.results[0]?.matched_by, ["meaning"]);
    assert.ok((found.results[0]?.similarity ?? 0) > 0.5);
    assert.equal(found.total, 1, "screenshots with unrelated meaning are left out");
  });

  test("ranks screenshots matching both keywords and meaning first", async () => {
    const found = await t.library.search({ query: "brewing gear" });
    assert.equal(found.results[0]?.file, RECEIPT);
    assert.deepEqual(found.results[0]?.matched_by, ["keywords", "meaning"]);
    assert.equal(found.results[0]?.relevance, 1);
    assert.match(found.results[0]?.match ?? "", /«(brewing|gear)»/i);
  });

  test("filters apply to meaning matches too", async () => {
    assert.equal((await t.library.search({ query: "crinkly wrapper", contentType: "code" })).total, 0);
    t.library.tagScreenshots([id(RECEIPT)], { add: ["Kitchen"] });
    assert.equal((await t.library.search({ query: "crinkly wrapper", tags: ["Kitchen"] })).total, 0);
    t.library.edit(id(CHIPS), { ignored: true });
    assert.equal((await t.library.search({ query: "crinkly wrapper" })).total, 0);
  });

  test("only new or changed screenshots are re-embedded", async () => {
    assert.equal(fake.documentsEmbedded, 5);
    assert.deepEqual(
      [t.library.semantic.status().indexed, t.library.semantic.status().waiting],
      [5, 0],
    );

    const espresso = () => cosine(fakeVector("espresso"), t.library.semantic.vectors().get(id(CHIPS))!);
    assert.equal(espresso(), 0);
    t.library.edit(id(CHIPS), { notes: "Espresso tasting with the barista: pour-over coffee and brewing notes" });
    assert.equal(t.library.semantic.status().waiting, 1);
    assert.deepEqual(await t.library.semantic.refresh(), { embedded: 1, remaining: 0 });
    assert.equal(fake.documentsEmbedded, 6);
    assert.ok(espresso() > 0.4, "the note is part of the new vector");
  });

  test("tags, notes and file names are part of each screenshot's meaning", () => {
    t.library.tagScreenshots([id(RECEIPT)], { add: ["Kitchen remodel"] });
    t.library.edit(id(RECEIPT), { notes: "Gift for Sam" });
    const [doc] = embeddingDocuments(t.library.db, fake.model, [id(RECEIPT)]);
    assert.equal(doc?.title, "Order confirmation for a ceramic pour-over coffee set, $43.18");
    assert.match(doc!.text, /^Probably kept as proof of purchase\./);
    assert.match(doc!.text, /Notes: Gift for Sam/);
    assert.match(doc!.text, /Tags: Kitchen remodel/);
    assert.match(doc!.text, /File name: receipt/);
    assert.match(doc!.text, /Names: Ceramic Pour Over Set/);
  });

  test("rebuilding discards every vector and embeds them again", async () => {
    const rebuilt = await t.library.rebuildIndex({ semantic: true });
    assert.equal(rebuilt.keyword_index.screenshots, 5);
    assert.equal(rebuilt.semantic_search.indexed, 0);
    assert.equal(rebuilt.semantic_search.waiting, 5);
    await t.library.semantic.refresh();
    assert.equal(t.library.semantic.status().indexed, 5);
  });

  test("related screenshots: copies, shared tags and similar subjects, with reasons", async () => {
    copyFileSync(join(t.folder, CHIPS), join(t.folder, "chips copy.png"));
    await t.library.scan({ folder: t.folder });
    t.library.tagScreenshots([id(RECEIPT), id(PICKLEBALL)], { add: ["Projects"] });
    t.library.edit(id(PICKLEBALL), { notes: "Order receipt: proof of purchase. Bought and paid; order receipt saved." });
    const early = await t.library.search({ query: "chips" });
    assert.match(early.semantic?.note ?? "", /1 of 6 screenshots aren't indexed for meaning yet/);
    await t.library.semantic.refresh();

    const related = t.library.related(id(CHIPS));
    assert.deepEqual(related.signals, { meaning: true, visual: true });
    assert.equal(related.results[0]?.file, "chips copy.png");
    assert.equal(related.results[0]?.near_duplicate, true);
    assert.match(related.results[0]?.reasons[0] ?? "", /identical image/);
    assert.ok(!related.results.some((r) => r.file === RECEIPT), "unrelated screenshots are left out");

    const receipt = t.library.related(id(RECEIPT));
    const pickleball = receipt.results.find((r) => r.file === PICKLEBALL);
    assert.ok(pickleball);
    assert.ok(pickleball.reasons.includes("both tagged Projects"));
    assert.ok(pickleball.reasons.some((r) => /similar subject/.test(r)), pickleball.reasons.join("; "));

    assert.throws(() => t.library.related("nope"), /No screenshot/);
  });

  test("works through the MCP tools", async () => {
    const server = createServer(t.library);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    };

    const found = await call("search_screenshots", { query: "crinkly wrapper" });
    assert.equal(found.results[0].file, CHIPS);
    const related = await call("get_related_screenshots", { id: id(RECEIPT) });
    assert.equal(related.screenshot.id, id(RECEIPT));
    const status = await call("get_status", {});
    assert.equal(status.semantic_search.state, "ready");
    assert.equal(status.semantic_search.indexed, 5);
    const rebuilt = await call("rebuild_index", {});
    assert.equal(rebuilt.keyword_index.screenshots, 5);
    await client.close();
  });
});

describe("semantic search before setup", needsHelper, () => {
  beforeEach(async () => {
    t = tempLibrary();
    ids = await analyzedLibrary(t);
  });
  afterEach(() => t.cleanup());

  test("search falls back to keywords and says why; status offers setup", async () => {
    const found = await t.library.search({ query: "packaging inspiration" });
    assert.equal(found.results[0]?.file, CHIPS);
    assert.equal(found.semantic?.used, false);
    await assert.rejects(t.library.search({ query: "crinkly wrapper", mode: "semantic" }));

    const status = await t.library.status();
    if (platformSupport().supported) {
      assert.match(found.semantic?.note ?? "", /setup_semantic_search/);
      assert.equal(status.semantic_search.state, "not_set_up");
      assert.ok(status.semantic_search.download!.total_mb > 300);
      assert.ok(status.next_steps.some((s) => /Semantic search .* isn't set up.*Gemma Terms of Use/.test(s)));

      t.library.setupSemantic({ declined: true });
      const after = await t.library.status();
      assert.equal(after.semantic_search.declined, true);
      assert.ok(!after.next_steps.some((s) => /Semantic search/.test(s)), "a no is remembered");
    } else {
      assert.equal(status.semantic_search.state, "unsupported");
    }

    const related = t.library.related(id(CHIPS));
    assert.equal(related.signals.meaning, false);
    assert.match(related.note ?? "", /isn't set up/);
  });
});

describe("model download", () => {
  const dir = mkdtempSync(join(tmpdir(), "memvana-shot-dl-"));
  const bytes = Buffer.from("model weights ".repeat(1000));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const serve = (body: Buffer, status = 200) => async () => new Response(status === 200 ? body : null, { status });

  test("verifies size and hash, and leaves nothing behind on failure", async () => {
    const dest = join(dir, "file.bin");
    await download("https://example.test/f", dest, { size: bytes.length, sha256 }, undefined, serve(bytes));
    assert.deepEqual(readFileSync(dest), bytes);
    await download("https://example.test/f", dest, { size: bytes.length, integrity }, undefined, serve(bytes));

    const tampered = Buffer.from(bytes);
    tampered[0] = 0;
    await assert.rejects(
      download("https://example.test/f", dest, { size: bytes.length, sha256 }, undefined, serve(tampered)),
      /checksum mismatch/,
    );
    assert.equal(existsSync(dest), false);
    await assert.rejects(
      download("https://example.test/f", dest, { size: 5, sha256 }, undefined, serve(bytes)),
      /expected 5 bytes/,
    );
    await assert.rejects(
      download("https://example.test/f", dest, { size: 5, sha256 }, undefined, serve(bytes, 404)),
      /HTTP 404/,
    );
  });

  test("a failed setup cleans up, including downloads abandoned by earlier processes", async () => {
    const models = join(dir, "models");
    mkdirSync(join(models, `${RUNTIME.dir}.partial-999999`), { recursive: true });
    const config = { home: dir, pluginRoot: REPO_ROOT, modelsDir: models };
    await assert.rejects(installSemantic(config, undefined, serve(bytes, 503)), /HTTP 503/);
    assert.deepEqual(readdirSync(models), []);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("embedding process", () => {
  const dir = mkdtempSync(join(tmpdir(), "memvana-shot-embedder-"));
  // A stand-in for bin/embedder.ts that speaks the same protocol.
  const entry = join(dir, "fake-embedder.mjs");
  writeFileSync(
    entry,
    `import { createInterface } from "node:readline";
     if (process.argv.includes("--fail")) { console.log(JSON.stringify({ ready: false, error: "bad model" })); process.exit(1); }
     console.log(JSON.stringify({ ready: true }));
     for await (const line of createInterface({ input: process.stdin })) {
       const { id, texts } = JSON.parse(line);
       if (texts.some((t) => t.includes("crash"))) process.exit(3);
       const vectors = texts.map((t) => Buffer.from(new Float32Array([t.length, 1]).buffer).toString("base64"));
       console.log(JSON.stringify({ id, ok: true, vectors }));
     }`,
  );
  const config = { home: dir, pluginRoot: REPO_ROOT, modelsDir: dir };

  test("formats prompts, survives a crash, and restarts on demand", async () => {
    const embedder = new ProcessEmbedder(config, { entry, idleMs: 20 });
    const [query] = await embedder.embedQueries(["abc"]);
    assert.equal(query?.[0], "task: search result | query: abc".length);
    const [doc] = await embedder.embedDocuments([{ title: null, text: "xyz" }]);
    assert.equal(doc?.[0], "title: none | text: xyz".length);

    await assert.rejects(embedder.embedQueries(["crash"]), /embedding process stopped \(exit 3\)/);
    assert.equal((await embedder.embedQueries(["again"]))[0]?.[1], 1, "a new process starts");
    await new Promise((resolve) => setTimeout(resolve, 60)); // idle timeout stops it
    assert.equal((await embedder.embedQueries(["after idle"])).length, 1);
    embedder.close();
  });

  test("reports a model that fails to load", async () => {
    const failing = join(dir, "failing.mjs");
    writeFileSync(failing, `process.argv.push("--fail"); await import(${JSON.stringify(entry)});`);
    const embedder = new ProcessEmbedder(config, { entry: failing });
    await assert.rejects(embedder.embedQueries(["x"]), /failed to load: bad model/);
    embedder.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

// Runs the real EmbeddingGemma model when it's installed, e.g.
// MEMVANA_SHOT_MODELS=~/Library/Application\ Support/Memvana\ Shot/models npm test
const realModels = process.env.MEMVANA_SHOT_MODELS;
const realModel =
  realModels && isInstalled({ home: "", pluginRoot: REPO_ROOT, modelsDir: realModels })
    ? {}
    : { skip: "EmbeddingGemma isn't installed (set MEMVANA_SHOT_MODELS to a models folder)" };

describe("EmbeddingGemma (real model)", { ...needsHelper, ...realModel }, () => {
  beforeEach(async () => {
    t = tempLibrary({ modelsDir: realModels });
    ids = await analyzedLibrary(t);
  });
  afterEach(() => t.cleanup());

  test("finds screenshots by meaning", async () => {
    assert.deepEqual(await t.library.semantic.refresh(), { embedded: 5, remaining: 0 });
    const top = async (query: string) =>
      (await t.library.search({ query, mode: "semantic" })).results[0]?.file;
    assert.equal(await top("interesting packaging"), CHIPS);
    assert.equal(await top("proof I paid for something"), RECEIPT);
    assert.equal(await top("ideas for a sports product"), PICKLEBALL);
    assert.equal(await top("programming snippets"), "code/IMG_2041.PNG");
    assert.equal(await top("bolsa de papas fritas"), CHIPS, "works across languages");
  });
});
