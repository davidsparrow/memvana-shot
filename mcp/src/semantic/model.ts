// The local embedding model behind semantic search, and the runtime that runs
// it. Neither is bundled: both are downloaded once, on the user's say-so,
// pinned to exact versions and verified by hash before use.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Config, modelsDir } from "../config.ts";

export interface ModelFile {
  path: string;
  size: number;
  sha256: string;
}

export interface RuntimePackage {
  name: string;
  url: string;
  size: number;
  /** npm's Subresource Integrity string for the tarball. */
  integrity: string;
  /** Tarball members to extract (everything else is other platforms). */
  members: string[];
}

const HF_REVISION = "5090578d9565bb06545b4552f76e6bc2c93e4a66";

/** Google's EmbeddingGemma 300M, 4-bit ONNX export (onnx-community), under the Gemma Terms of Use. */
export const MODEL = {
  id: "embeddinggemma-300m-q4",
  name: "EmbeddingGemma 300M",
  publisher: "Google",
  license: "Gemma Terms of Use",
  termsUrl: "https://ai.google.dev/gemma/terms",
  policyUrl: "https://ai.google.dev/gemma/prohibited_use_policy",
  /** Required wording for redistribution under the Gemma Terms (section 3.1). */
  notice: "Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms",
  baseUrl: `https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX/resolve/${HF_REVISION}`,
  dir: `embeddinggemma-300m-q4-${HF_REVISION.slice(0, 7)}`,
  onnx: "onnx/model_q4.onnx",
  dims: 768,
  /** Longer documents are truncated; screenshot details rarely need more. */
  maxTokens: 512,
  files: [
    { path: "onnx/model_q4.onnx", size: 519_322, sha256: "ad1dfee81a70f7944b9b9d1cc6e48075b832881cf33fab2f2b248be78f3f0043" },
    { path: "onnx/model_q4.onnx_data", size: 196_725_760, sha256: "599962c3143b040de2dd05e5975be3e9091dd067cacc6a8f7186e3203bab9e02" },
    { path: "tokenizer.json", size: 20_323_312, sha256: "4dda02faaf32bc91031dc8c88457ac272b00c1016cc679757d1c441b248b9c47" },
    { path: "tokenizer_config.json", size: 1_156_830, sha256: "3ca953eea6c3c9fcda9cf3df22949ff18b216f7c74bd6459230f3f1013953f3a" },
  ] satisfies readonly ModelFile[],
} as const;

const ORT_VERSION = "1.30.0";

/** ONNX Runtime for Node (MIT). Only the Apple Silicon binaries are kept. */
export const RUNTIME = {
  version: ORT_VERSION,
  dir: `onnxruntime-${ORT_VERSION}-darwin-arm64`,
  packages: [
    {
      name: "onnxruntime-common",
      url: `https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-${ORT_VERSION}.tgz`,
      size: 66_795,
      integrity: "sha512-7fdVWjAID1dVhH/G8qK3APARunV4VkBFoCQAP7qp4Wkab0mrorvmc+sqiT+mKXOzDqdjN5j+/Z9nb4gzNPWcyA==",
      members: ["package/package.json", "package/dist"],
    },
    {
      name: "onnxruntime-node",
      url: `https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-${ORT_VERSION}.tgz`,
      size: 113_507_888,
      integrity: "sha512-twhs1C2C/BFkz1yc5OY0KIU2GUq6DURO7hD4bx5Q2Qy3nAMJwRXW8xU3NVczE29VA9lolLOYepoD8fjTGOfIqw==",
      members: [
        "package/package.json",
        "package/dist",
        "package/bin/napi-v6/darwin/arm64/onnxruntime_binding.node",
        "package/bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib",
      ],
    },
  ] satisfies readonly RuntimePackage[],
} as const;

/** Bytes fetched by a first-time setup. */
export const DOWNLOAD_BYTES =
  MODEL.files.reduce((n, f) => n + f.size, 0) + RUNTIME.packages.reduce((n, p) => n + p.size, 0);

/** Space used once installed: the model files plus ONNX Runtime's Apple Silicon library. */
export const DISK_BYTES = MODEL.files.reduce((n, f) => n + f.size, 0) + 46_000_000;

/** Written last, so a half-finished download never looks installed. */
export const COMPLETE_MARKER = ".complete";

export function modelDir(config: Config): string {
  return join(modelsDir(config), MODEL.dir);
}

export function runtimeDir(config: Config): string {
  return join(modelsDir(config), RUNTIME.dir);
}

export function isInstalled(config: Config): boolean {
  return (
    existsSync(join(modelDir(config), COMPLETE_MARKER)) && existsSync(join(runtimeDir(config), COMPLETE_MARKER))
  );
}

/** ONNX Runtime ships macOS binaries for Apple Silicon only. */
export function platformSupport(): { supported: boolean; reason?: string } {
  if (process.platform === "darwin" && process.arch === "arm64") return { supported: true };
  return {
    supported: false,
    reason:
      process.platform === "darwin"
        ? "Semantic search needs an Apple Silicon Mac and the arm64 build of Node.js " +
          `(this Node.js is ${process.arch}). Keyword search works everywhere.`
        : "Semantic search needs macOS on Apple Silicon. Keyword search works everywhere.",
  };
}

// EmbeddingGemma was trained with these task prompts; using them matters.
export function queryPrompt(query: string): string {
  return `task: search result | query: ${query}`;
}

export function documentPrompt(title: string | null, text: string): string {
  return `title: ${title?.trim() || "none"} | text: ${text}`;
}
