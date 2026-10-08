import { copyFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { type ExtractOptions, runExtract } from "../src/helper.ts";
import {
  type AssetJob,
  type PhotoAsset,
  type PhotoExtractResult,
  type PhotosAuthorization,
  type PhotosBridge,
  PhotosAccessError,
  hasAccess,
} from "../src/photos.ts";

export interface FakeAsset extends PhotoAsset {
  /** The image file standing in for the asset's bytes. */
  file: string;
  /** The name Photos reports. */
  filename: string;
}

/**
 * A Photos library made of files. Extraction runs the real shot-helper on
 * them, then adds what the bridge adds (asset, Photos file name, creation date).
 */
export class FakePhotos implements PhotosBridge {
  authorization: PhotosAuthorization;
  /** What the user answers when asked; undefined leaves the answer as is. */
  answer: PhotosAuthorization | undefined = "authorized";
  assets: FakeAsset[] = [];
  readonly helper: string;
  readonly calls: string[] = [];

  constructor(helper: string, authorization: PhotosAuthorization = "not_determined") {
    this.helper = helper;
    this.authorization = authorization;
  }

  /** Adds an asset backed by `file`, created at `created`. */
  add(file: string, created: string, overrides: Partial<FakeAsset> = {}): FakeAsset {
    const n = this.assets.length + 1;
    const asset: FakeAsset = {
      asset: `${n}0000000-AAAA-BBBB-CCCC-DDDDDDDDDDDD/L0/001`,
      created,
      modified: "2026-07-14T16:09:03.000Z",
      width: 100,
      height: 100,
      edited: false,
      favorite: false,
      file,
      filename: `IMG_${1000 + n}.PNG`,
      ...overrides,
    };
    this.assets.push(asset);
    return asset;
  }

  async status(): Promise<PhotosAuthorization> {
    this.calls.push("status");
    return this.authorization;
  }

  async authorize(): Promise<PhotosAuthorization> {
    this.calls.push("authorize");
    if (this.authorization === "not_determined" && this.answer) this.authorization = this.answer;
    return this.authorization;
  }

  async list(): Promise<PhotoAsset[]> {
    this.calls.push("list");
    this.requireAccess();
    return this.assets.map(({ file: _, filename: __, ...asset }) => ({ ...asset }));
  }

  async extract(jobs: AssetJob[], options: ExtractOptions, onResult: (r: PhotoExtractResult) => void) {
    this.calls.push("extract");
    this.requireAccess();
    const byAsset = new Map(this.assets.map((a) => [a.asset, a]));
    const assetOf = new Map(jobs.map((j) => [j.id, byAsset.get(j.asset)]));
    const missing = jobs.filter((j) => !byAsset.has(j.asset));
    for (const job of missing) onResult({ ok: false, id: job.id, asset: job.asset, error: "not in the Photos library any more" });
    const present = jobs.filter((j) => byAsset.has(j.asset));
    await runExtract(this.helper, present.map((j) => ({ id: j.id, path: byAsset.get(j.asset)!.file })), options, (r) => {
      const asset = r.id ? assetOf.get(r.id) : undefined;
      if (!r.ok) return onResult(r);
      onResult({ ...r, asset: asset!.asset, filename: asset!.filename, created: asset!.created });
    });
  }

  async exportImages(jobs: AssetJob[], dir: string): Promise<Map<string, string>> {
    this.calls.push("export");
    this.requireAccess();
    const paths = new Map<string, string>();
    for (const job of jobs) {
      const asset = this.assets.find((a) => a.asset === job.asset);
      if (!asset) continue;
      mkdirSync(join(dir, job.id), { recursive: true });
      const path = join(dir, job.id, basename(asset.file));
      copyFileSync(asset.file, path);
      paths.set(job.id, path);
    }
    return paths;
  }

  private requireAccess(): void {
    if (!hasAccess(this.authorization)) throw new PhotosAccessError(this.authorization);
  }
}
