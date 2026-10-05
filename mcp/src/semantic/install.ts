// Downloads the embedding model and ONNX Runtime into the models directory.
// Every file is checked against a pinned hash, and each part is assembled in
// a scratch directory that is renamed into place only when complete.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { promisify } from "node:util";
import type { Config } from "../config.ts";
import { COMPLETE_MARKER, DOWNLOAD_BYTES, MODEL, RUNTIME, modelDir, runtimeDir } from "./model.ts";

const execFileAsync = promisify(execFile);

/** A download that stalls this long is abandoned (and can be retried). */
const STALL_MS = 60_000;

export interface InstallProgress {
  /** What is downloading now. */
  file: string;
  received: number;
  total: number;
}

export interface Expected {
  size: number;
  /** Hex SHA-256 (Hugging Face files) … */
  sha256?: string;
  /** … or an npm integrity string ("sha512-<base64>"). */
  integrity?: string;
}

/** Downloads whatever is missing. Safe to call again after a failure. */
export async function installSemantic(
  config: Config,
  onProgress?: (p: InstallProgress) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let received = 0;
  const report = (file: string) => (bytes: number) => {
    received += bytes;
    onProgress?.({ file, received, total: DOWNLOAD_BYTES });
  };

  await assemble(runtimeDir(config), async (dir) => {
    for (const pkg of RUNTIME.packages) {
      const tarball = join(dir, `${pkg.name}.tgz`);
      await download(pkg.url, tarball, pkg, report(pkg.name), fetchImpl);
      const dest = join(dir, "node_modules", pkg.name);
      mkdirSync(dest, { recursive: true });
      await execFileAsync("tar", ["-xzf", tarball, "-C", dest, "--strip-components", "1", ...pkg.members], {
        timeout: 120_000,
      });
      rmSync(tarball);
    }
  });
  received = RUNTIME.packages.reduce((n, p) => n + p.size, 0); // downloaded now or earlier

  await assemble(modelDir(config), async (dir) => {
    for (const file of MODEL.files) {
      const dest = join(dir, file.path);
      mkdirSync(dirname(dest), { recursive: true });
      await download(`${MODEL.baseUrl}/${file.path}`, dest, file, report(file.path), fetchImpl);
    }
    writeFileSync(join(dir, "NOTICE"), `${MODEL.notice}\nProhibited uses: ${MODEL.policyUrl}\n`);
  });
}

/** Builds `dest` in a scratch directory unless it is already complete. */
async function assemble(dest: string, build: (dir: string) => Promise<void>): Promise<void> {
  if (existsSync(join(dest, COMPLETE_MARKER))) return;
  removeAbandoned(dest);
  const scratch = `${dest}.partial-${process.pid}`;
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  try {
    await build(scratch);
    writeFileSync(join(scratch, COMPLETE_MARKER), new Date().toISOString() + "\n");
    rmSync(dest, { recursive: true, force: true }); // a stale, incomplete copy
    renameSync(scratch, dest);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Removes what interrupted downloads left behind. */
export function cleanUpAbandonedDownloads(config: Config): void {
  removeAbandoned(runtimeDir(config));
  removeAbandoned(modelDir(config));
}

/** Deletes scratch directories left by downloads whose process has gone (e.g. Claude quit mid-download). */
function removeAbandoned(dest: string): void {
  const prefix = `${basename(dest)}.partial-`;
  let entries: string[];
  try {
    entries = readdirSync(dirname(dest));
  } catch {
    return; // the models folder doesn't exist yet
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const pid = Number(entry.slice(prefix.length));
    if (pid === process.pid || isRunning(pid)) continue;
    rmSync(join(dirname(dest), entry), { recursive: true, force: true });
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Streams url to dest, verifying size and hash; deletes dest and throws on any mismatch. */
export async function download(
  url: string,
  dest: string,
  expected: Expected,
  onBytes: (n: number) => void = () => {},
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const controller = new AbortController();
  let stall = setTimeout(() => controller.abort(), STALL_MS);
  const hash = createHash(expected.integrity ? expected.integrity.split("-")[0]! : "sha256");
  let size = 0;
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        clearTimeout(stall);
        stall = setTimeout(() => controller.abort(), STALL_MS);
        hash.update(chunk);
        size += chunk.length;
        onBytes(chunk.length);
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as ReadableStream), meter, createWriteStream(dest));
    if (size !== expected.size) throw new Error(`expected ${expected.size} bytes, got ${size}`);
    const ok = expected.integrity
      ? `${expected.integrity.split("-")[0]}-${hash.digest("base64")}` === expected.integrity
      : hash.digest("hex") === expected.sha256;
    if (!ok) throw new Error("checksum mismatch");
  } catch (err) {
    rmSync(dest, { force: true });
    const reason = controller.signal.aborted ? "download stalled" : err instanceof Error ? err.message : String(err);
    throw new Error(`Couldn't download ${url}: ${reason}`);
  } finally {
    clearTimeout(stall);
  }
}
