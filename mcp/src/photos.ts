// Talks to the Photos bridge inside "Memvana Shot.app" (native/Sources/shot-helper/Photos.swift).
//
// macOS grants Photos access to an app, so the bridge must be started by
// LaunchServices (`open`), not spawned as a child: as a child, the request
// would be attributed to whichever app hosts Claude. `open` can't pipe, so
// jobs go in and results come out through files in a scratch directory, and
// results are read while the app is still writing them.

import { execFile } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import type { ExtractFailure, ExtractOptions, ExtractSuccess } from "./helper.ts";

const execFileAsync = promisify(execFile);

export type PhotosAuthorization = "not_determined" | "restricted" | "denied" | "authorized" | "limited" | "unknown";

/** One asset in the Screenshots album, as listed by the bridge. */
export interface PhotoAsset {
  /** PhotoKit local identifier. */
  asset: string;
  created: string | null;
  modified: string | null;
  width: number;
  height: number;
  /** Edited in Photos; extraction uses the edited version. */
  edited: boolean;
  favorite: boolean;
}

export interface AssetJob {
  id: string;
  asset: string;
}

export type PhotoExtractResult =
  | (ExtractSuccess & { asset: string; filename: string | null; created: string | null })
  | (ExtractFailure & { asset?: string });

/** What the library needs from the Photos library. Swappable for tests. */
export interface PhotosBridge {
  /** The current permission, without asking. */
  status(): Promise<PhotosAuthorization>;
  /** Shows the macOS permission prompt if the user hasn't answered it yet. */
  authorize(): Promise<PhotosAuthorization>;
  /** The Screenshots album, newest first. */
  list(): Promise<PhotoAsset[]>;
  /** On-device extraction, like `shot-helper extract`, reading images from Photos. */
  extract(jobs: AssetJob[], options: ExtractOptions, onResult: (result: PhotoExtractResult) => void): Promise<void>;
  /** Writes each asset's image under `dir`; returns job id → file path. */
  exportImages(jobs: AssetJob[], dir: string): Promise<Map<string, string>>;
}

/** Thrown when Photos access is off (never asked, denied, or restricted). */
export class PhotosAccessError extends Error {
  readonly authorization: PhotosAuthorization;

  constructor(authorization: PhotosAuthorization) {
    super(`Memvana Shot doesn't have access to Photos (${authorization})`);
    this.authorization = authorization;
  }
}

export function hasAccess(authorization: PhotosAuthorization): boolean {
  return authorization === "authorized" || authorization === "limited";
}

/** Runs `open` with the given arguments, failing after timeoutMs. */
export type Launcher = (args: string[], timeoutMs: number) => Promise<void>;

const openLauncher: Launcher = async (args, timeoutMs) => {
  try {
    await execFileAsync("open", args, { timeout: timeoutMs });
  } catch (err) {
    // When the app finishes before `open` starts waiting, `open -W` fails
    // with "Unable to block on applications". The done line decides success.
    const stderr = String((err as { stderr?: string }).stderr ?? "");
    if (!stderr.includes("Unable to block on applications")) throw err;
  }
};

const MINUTE = 60_000;

export class AppBridge implements PhotosBridge {
  readonly appPath: string;
  /** Parent of the per-call scratch directories. */
  readonly scratchRoot: string;
  private readonly launch: Launcher;

  constructor(appPath: string, scratchRoot: string, launch: Launcher = openLauncher) {
    this.appPath = appPath;
    this.scratchRoot = scratchRoot;
    this.launch = launch;
  }

  async status(): Promise<PhotosAuthorization> {
    const done = await this.run("status", [], { timeoutMs: MINUTE });
    return done.authorization as PhotosAuthorization;
  }

  async authorize(): Promise<PhotosAuthorization> {
    // Brought to the front so the permission prompt is seen; the user may take a while.
    const done = await this.run("authorize", [], { timeoutMs: 10 * MINUTE, foreground: true });
    return done.authorization as PhotosAuthorization;
  }

  async list(): Promise<PhotoAsset[]> {
    const assets: PhotoAsset[] = [];
    await this.run("list", [], { timeoutMs: 5 * MINUTE, onLine: (line) => assets.push(line as unknown as PhotoAsset) });
    return assets;
  }

  async extract(
    jobs: AssetJob[],
    options: ExtractOptions,
    onResult: (result: PhotoExtractResult) => void,
  ): Promise<void> {
    if (jobs.length === 0) return;
    const args = ["--thumb-dir", options.thumbDir];
    if (options.maxDim) args.push("--max-dim", String(options.maxDim));
    if (options.concurrency) args.push("--concurrency", String(options.concurrency));
    // Images only in iCloud are downloaded first, so allow for slow ones.
    await this.run("extract", args, {
      input: jobs,
      timeoutMs: 2 * MINUTE + jobs.length * 15_000,
      onLine: (line) => onResult(line as unknown as PhotoExtractResult),
    });
  }

  async exportImages(jobs: AssetJob[], dir: string): Promise<Map<string, string>> {
    const paths = new Map<string, string>();
    if (jobs.length === 0) return paths;
    await this.run("export", ["--dir", dir], {
      input: jobs,
      timeoutMs: 2 * MINUTE + jobs.length * 30_000,
      onLine: (line) => {
        if (line.ok && typeof line.id === "string") paths.set(line.id, String(line.path));
      },
    });
    return paths;
  }

  /** Runs one bridge command and returns its done line. */
  private async run(
    command: string,
    args: string[],
    options: {
      input?: AssetJob[];
      timeoutMs: number;
      foreground?: boolean;
      onLine?: (line: Record<string, unknown>) => void;
    },
  ): Promise<Record<string, unknown>> {
    mkdirSync(this.scratchRoot, { recursive: true });
    const dir = mkdtempSync(join(this.scratchRoot, "photos-"));
    try {
      const input = join(dir, "in.jsonl");
      const output = join(dir, "out.jsonl");
      const errors = join(dir, "err.log");
      writeFileSync(input, (options.input ?? []).map((j) => JSON.stringify(j) + "\n").join(""));
      writeFileSync(output, "");

      let done: Record<string, unknown> | undefined;
      const tail = new LineTail(output, (text) => {
        let line: Record<string, unknown>;
        try {
          line = JSON.parse(text);
        } catch {
          return; // a malformed line can't be attributed to a job
        }
        if (line.done === true) done = line;
        else options.onLine?.(line);
      });
      const background = options.foreground ? [] : ["-g", "-j"];
      const timer = setInterval(() => tail.read(), 250);
      try {
        await this.launch(
          ["-W", "-n", ...background, "-a", this.appPath, "--stdin", input, "--stdout", output, "--stderr", errors,
            "--args", "photos", command, ...args],
          options.timeoutMs,
        );
      } finally {
        clearInterval(timer);
        tail.read();
        tail.end();
      }

      if (!done) {
        const stderr = readText(errors).replace(/^shot-helper: /, "").trim();
        throw new Error(`Memvana Shot stopped before finishing "photos ${command}"${stderr ? `: ${stderr}` : ""}`);
      }
      if (done.error === "not_authorized") throw new PhotosAccessError(done.authorization as PhotosAuthorization);
      return done;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Reads complete lines appended to a file since the last read. */
class LineTail {
  private offset = 0;
  private pending = "";
  private readonly decoder = new StringDecoder("utf8");
  private readonly path: string;
  private readonly onLine: (line: string) => void;

  constructor(path: string, onLine: (line: string) => void) {
    this.path = path;
    this.onLine = onLine;
  }

  read(): void {
    const fd = openSync(this.path, "r");
    try {
      const size = fstatSync(fd).size;
      if (size <= this.offset) return;
      const chunk = Buffer.alloc(size - this.offset);
      readSync(fd, chunk, 0, chunk.length, this.offset);
      this.offset = size;
      this.pending += this.decoder.write(chunk);
    } finally {
      closeSync(fd);
    }
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) this.onLine(line);
  }

  /** Delivers a last line that has no newline. */
  end(): void {
    this.pending += this.decoder.end();
    if (this.pending.trim()) this.onLine(this.pending);
    this.pending = "";
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
