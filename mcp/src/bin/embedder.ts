// The embedding model runs in this separate process, bundled to
// mcp/dist/embedder.mjs. The model and tokenizer take about 500 MB, so the MCP
// server starts this process when it needs vectors and stops it when idle,
// and a native crash here can't take the server down.
//
//   node embedder.mjs --model-dir DIR --runtime-dir DIR [--threads 2] [--max-tokens 512]
//   stdout first:  {"ready": true, "dims": 768}  or  {"ready": false, "error": "..."}
//   stdin:         {"id": 1, "texts": ["already prompt-formatted text", ...]}
//   stdout:        {"id": 1, "ok": true, "vectors": ["<base64 float32>", ...]}

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { Tokenizer } from "@huggingface/tokenizers";

// The slice of the onnxruntime-node API used here.
interface OrtTensor {
  data: Float32Array;
  dims: readonly number[];
}
interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
}
interface Ort {
  Tensor: new (type: "int64", data: BigInt64Array, dims: number[]) => unknown;
  InferenceSession: { create(path: string, options?: Record<string, unknown>): Promise<OrtSession> };
}

const { values } = parseArgs({
  options: {
    "model-dir": { type: "string" },
    "runtime-dir": { type: "string" },
    onnx: { type: "string", default: "onnx/model_q4.onnx" },
    threads: { type: "string", default: "2" },
    "max-tokens": { type: "string", default: "512" },
  },
});

const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
const maxTokens = Number(values["max-tokens"]);

let ort: Ort;
let tokenizer: Tokenizer;
let session: OrtSession;
try {
  const modelDir = values["model-dir"];
  const runtimeDir = values["runtime-dir"];
  if (!modelDir || !runtimeDir) throw new Error("--model-dir and --runtime-dir are required");
  ort = createRequire(join(runtimeDir, "index.js"))("onnxruntime-node") as Ort;
  tokenizer = new Tokenizer(
    JSON.parse(readFileSync(join(modelDir, "tokenizer.json"), "utf8")),
    JSON.parse(readFileSync(join(modelDir, "tokenizer_config.json"), "utf8")),
  );
  session = await ort.InferenceSession.create(join(modelDir, values.onnx), {
    intraOpNumThreads: Number(values.threads),
    interOpNumThreads: 1,
  });
  write({ ready: true });
} catch (err) {
  write({ ready: false, error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}

/** Embeds a batch; returns unit-length vectors. */
async function embed(texts: string[]): Promise<Float32Array[]> {
  const encoded = texts.map((text): number[] => {
    const ids: number[] = tokenizer.encode(text).ids;
    // Keep the closing special token when truncating.
    return ids.length > maxTokens ? [...ids.slice(0, maxTokens - 1), ids[ids.length - 1]!] : ids;
  });
  const width = Math.max(...encoded.map((ids) => ids.length));
  const inputIds = new BigInt64Array(texts.length * width); // padding id is 0
  const mask = new BigInt64Array(texts.length * width);
  encoded.forEach((ids, row) => {
    ids.forEach((id, col) => {
      inputIds[row * width + col] = BigInt(id);
      mask[row * width + col] = 1n;
    });
  });
  const output = await session.run({
    input_ids: new ort.Tensor("int64", inputIds, [texts.length, width]),
    attention_mask: new ort.Tensor("int64", mask, [texts.length, width]),
  });
  const embedding = output.sentence_embedding!;
  const dims = embedding.dims[1]!;
  return texts.map((_, row) => {
    const v = embedding.data.slice(row * dims, (row + 1) * dims);
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  });
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  let id: unknown;
  try {
    const request = JSON.parse(line) as { id: unknown; texts: string[] };
    id = request.id;
    const vectors = await embed(request.texts);
    write({ id, ok: true, vectors: vectors.map((v) => Buffer.from(v.buffer).toString("base64")) });
  } catch (err) {
    write({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
