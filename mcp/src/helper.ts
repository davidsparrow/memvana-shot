import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { ImageMetadata } from "./dates.ts";

const execFileAsync = promisify(execFile);

export interface HelperVersion {
  name: string;
  version: string;
  ocrRevision: number;
  classifyRevision: number;
  featurePrintRevision: number;
  os: string;
}

export interface ExtractJob {
  id: string;
  path: string;
}

export interface ExtractSuccess {
  ok: true;
  id: string;
  path: string;
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
  uti: string | null;
  metadata: ImageMetadata;
  thumb?: { path: string; width: number; height: number };
  ocr?: { text: string; confidence: number; observationCount: number };
  labels?: Array<{ label: string; confidence: number }>;
  featurePrint?: { revision: number; elementType: string; elementCount: number; base64: string };
  elapsedMs: number;
}

export interface ExtractFailure {
  ok: false;
  id?: string;
  path?: string;
  error: string;
}

export type ExtractResult = ExtractSuccess | ExtractFailure;

export interface ExtractOptions {
  thumbDir: string;
  maxDim?: number;
  concurrency?: number;
}

export async function helperVersion(helper: string): Promise<HelperVersion> {
  const { stdout } = await execFileAsync(helper, ["version"], { timeout: 15_000 });
  return JSON.parse(stdout) as HelperVersion;
}

/**
 * Streams jobs through `shot-helper extract`, calling onResult as each image
 * finishes (completion order, not input order).
 */
export async function runExtract(
  helper: string,
  jobs: ExtractJob[],
  options: ExtractOptions,
  onResult: (result: ExtractResult) => void,
): Promise<void> {
  const args = ["extract", "--thumb-dir", options.thumbDir];
  if (options.maxDim) args.push("--max-dim", String(options.maxDim));
  if (options.concurrency) args.push("--concurrency", String(options.concurrency));
  await streamJobs(helper, args, jobs, (line) => {
    let parsed: ExtractResult;
    try {
      parsed = JSON.parse(line) as ExtractResult;
    } catch {
      parsed = { ok: false, error: `unparseable helper output: ${line.slice(0, 200)}` };
    }
    onResult(parsed);
  });
}

/** Reads each file's Finder tags. Files that can't be read are left out. */
export async function readFinderTags(helper: string, jobs: ExtractJob[]): Promise<Map<string, string[]>> {
  const tags = new Map<string, string[]>();
  await streamJobs(helper, ["finder-tags"], jobs, (line) => {
    try {
      const r = JSON.parse(line) as { id: string; ok: boolean; tags?: string[] };
      if (r.ok && r.id) tags.set(r.id, r.tags ?? []);
    } catch {
      // ignore unparseable lines
    }
  });
  return tags;
}

/** Runs a helper command that reads job lines on stdin and writes one JSON line per job. */
async function streamJobs(
  helper: string,
  args: string[],
  jobs: ExtractJob[],
  onLine: (line: string) => void,
): Promise<void> {
  if (jobs.length === 0) return;
  const child = spawn(helper, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });

  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const consumed = (async () => {
    try {
      for await (const line of lines) {
        if (line.trim()) onLine(line);
      }
    } catch (err) {
      child.kill();
      throw err;
    }
  })();

  // The helper may exit early (e.g. bad arguments); its exit code reports why.
  child.stdin.on("error", () => {});
  child.stdin.end(jobs.map((j) => JSON.stringify(j)).join("\n") + "\n");

  const [code] = await Promise.all([exited, consumed]);
  if (code !== 0) {
    throw new Error(`shot-helper ${args[0]} exited with code ${code}: ${stderr.trim()}`);
  }
}
