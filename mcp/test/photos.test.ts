import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { resolveHelper } from "../src/config.ts";
import { AppBridge, type Launcher, PhotosAccessError } from "../src/photos.ts";
import { FakePhotos } from "./fake-photos.ts";
import { REPO_ROOT, type TempLibrary, analyzedLibrary, needsHelper, tempLibrary } from "./helpers.ts";

const RECEIPT = "receipt.jpg"; // its EXIF says 2025-02-14
const CHIPS = "Screenshot 2025-08-03 at 4.15.22 PM.png";

let t: TempLibrary | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

/** A temp library whose Photos library holds copies of the given fixture screenshots. */
function withPhotos(files: string[] = [RECEIPT, CHIPS]): { t: TempLibrary; photos: FakePhotos } {
  const photos = new FakePhotos(resolveHelper({ home: "", pluginRoot: REPO_ROOT })!);
  t = tempLibrary({ photos });
  files.forEach((file, i) => photos.add(join(t!.folder, file), `2026-0${i + 1}-02T10:00:00.000Z`));
  return { t, photos };
}

const photoRows = (t: TempLibrary) =>
  t.library.list({ limit: 200, includeMissing: true }).filter((r) => t.library.get(r.id)?.photo_asset_id);

describe("Photos library", needsHelper, () => {
  test("connecting asks for access, then scans and extracts the Screenshots album", async () => {
    const { t, photos } = withPhotos();
    const before = await t.library.status();
    assert.deepEqual(before.photos, { available: true, connected: false, authorization: "not_determined", screenshots: undefined, fix: undefined });
    assert.match(before.next_steps.join(" "), /connect the Photos library/);

    const result = await t.library.connectPhotos();
    assert.equal(result.connected, true);
    assert.ok(result.connected && "succeeded" in result.extraction);
    assert.deepEqual(result.sources, [
      { kind: "photos", location: "Photos library", discovered: 2, added: 2, changed: 0, returned: 0, missing: 0 },
    ]);
    assert.equal(result.extraction.succeeded, 2);

    const receipt = t.library.get(photoRows(t).find((r) => r.file === "IMG_1001.PNG")!.id)!;
    assert.equal(receipt.source.kind, "photos");
    assert.equal(receipt.file_path, null);
    assert.equal(receipt.photo_asset_id, photos.assets[0]!.asset);
    assert.equal(receipt.captured_at, "2026-01-02T10:00:00.000Z", "Photos' date beats the image's EXIF");
    assert.equal(receipt.captured_at_source, "photos");
    assert.equal(receipt.status, "extracted");
    assert.ok(receipt.thumb_path && existsSync(receipt.thumb_path));

    const chips = await t.library.search({ query: "tortilla" });
    assert.deepEqual(chips.results.map((r) => r.file), ["IMG_1002.PNG"]);
    const assetIdWords = await t.library.search({ query: "dddddddddddd" });
    assert.equal(assetIdWords.results.length, 0, "Photos asset ids never become searchable names");

    const after = await t.library.status();
    assert.equal(after.photos.connected, true);
    assert.equal(after.photos.screenshots, 2);
    assert.deepEqual(photos.calls.filter((c) => c === "authorize"), ["authorize"]);
  });

  test("a refusal is reported with a fix, and can open System Settings", async () => {
    const { t, photos } = withPhotos();
    photos.answer = "denied";
    const opened: string[] = [];
    t.library.opener = async (path) => {
      opened.push(path);
    };
    const result = await t.library.connectPhotos({ openSettings: true });
    assert.equal(result.connected, false);
    assert.ok(!result.connected);
    assert.equal(result.authorization, "denied");
    assert.match(result.fix, /System Settings > Privacy & Security > Photos/);
    assert.equal(result.settings_opened, true);
    assert.deepEqual(opened, ["x-apple.systempreferences:com.apple.preference.security?Privacy_Photos"]);
    assert.equal((await t.library.status()).photos.connected, false);
    await assert.rejects(t.library.scan({ photos: true }), /isn't connected yet/);
  });

  test("rescans pick up new, edited, removed and returning screenshots, not sync noise", async () => {
    const { t, photos } = withPhotos();
    await t.library.connectPhotos();
    const [receipt, chips] = photos.assets;

    receipt!.modified = "2026-09-01T00:00:00.000Z"; // e.g. iCloud touched it; the image is the same
    let scan = await t.library.scan();
    assert.deepEqual([scan.sources[0]!.added, scan.sources[0]!.changed], [0, 0]);
    assert.ok("processed" in scan.extraction);
    assert.equal(scan.extraction.processed, 0);

    Object.assign(chips!, { edited: true, modified: "2026-09-02T00:00:00.000Z", width: 90 }); // cropped in Photos
    photos.add(join(t.folder, "window-shadow.png"), "2026-09-03T10:00:00.000Z");
    scan = await t.library.scan();
    assert.deepEqual([scan.sources[0]!.added, scan.sources[0]!.changed], [1, 1]);
    assert.ok("processed" in scan.extraction);
    assert.equal(scan.extraction.processed, 2, "the edited and the new screenshot");

    photos.assets.splice(0, 1); // deleted (or hidden) in Photos
    scan = await t.library.scan();
    assert.equal(scan.sources[0]!.missing, 1);
    assert.equal(t.library.list({ limit: 200 }).length, 2);

    photos.assets.unshift(receipt!); // restored from Recently Deleted
    scan = await t.library.scan();
    assert.equal(scan.sources[0]!.returned, 1);
    assert.equal(t.library.list({ limit: 200 }).length, 3);
  });

  test("turning access off later leaves the library intact", async () => {
    const { t, photos } = withPhotos();
    await t.library.connectPhotos({ extractLimit: 1 });
    photos.authorization = "denied";

    const scan = await t.library.scan();
    assert.equal(scan.sources[0]!.unavailable, true);
    assert.match(scan.sources[0]!.reason ?? "", /Photos access is off \(denied\)/);
    assert.equal(t.library.list({ limit: 200 }).length, 2, "nothing marked missing");
    assert.ok(!photos.calls.slice(-1).includes("extract"), "no extraction attempted while access is off");

    // A folder scan doesn't check Photos first, so extraction finds out itself.
    const folderScan = await t.library.scan({ folder: t.folder });
    assert.ok("photos_unavailable" in folderScan.extraction);
    assert.match(folderScan.extraction.photos_unavailable ?? "", /weren't extracted/);
    assert.equal(folderScan.extraction.succeeded, 5, "folder screenshots still get extracted");

    const status = await t.library.status();
    assert.match(status.photos.fix ?? "", /turn on Memvana Shot/);
    assert.match(status.next_steps.join(" "), /Photos is connected but unavailable/);
  });

  test("opening a screenshot from Photos opens an exported copy", async () => {
    const { t, photos } = withPhotos();
    await t.library.connectPhotos();
    const opened: Array<[string, boolean]> = [];
    t.library.opener = async (path, reveal) => {
      opened.push([path, reveal]);
    };
    const id = photoRows(t)[0]!.id;
    const result = await t.library.open(id, true);
    assert.ok(result.opened.startsWith(join(t.config.home, "tmp", "open")));
    assert.ok(existsSync(result.opened));
    assert.match(result.note ?? "", /no file to show in Finder/);
    assert.deepEqual(opened, [[result.opened, false]]);

    photos.assets = photos.assets.filter((a) => a.asset !== t.library.get(id)!.photo_asset_id);
    await t.library.scan();
    await assert.rejects(t.library.open(id), /no longer in the Photos Screenshots album/);
  });

  test("a screenshot moved from a folder into Photos keeps its id and analysis", async () => {
    const { t, photos } = withPhotos([]);
    const ids = await analyzedLibrary(t);
    const moved = join(mkdtempSync(join(tmpdir(), "memvana-photos-")), RECEIPT);
    copyFileSync(join(t.folder, RECEIPT), moved);
    rmSync(join(t.folder, RECEIPT));
    await t.library.scan(); // the folder copy goes missing
    photos.add(moved, "2026-01-02T10:00:00.000Z");

    const result = await t.library.connectPhotos();
    assert.ok(result.connected && "relinked" in result.extraction);
    assert.equal(result.extraction.relinked, 1);
    const record = t.library.get(ids.get(RECEIPT)!)!;
    assert.equal(record.source.kind, "photos");
    assert.equal(record.photo_asset_id, photos.assets[0]!.asset);
    assert.equal(record.file_name, "IMG_1001.PNG");
    assert.equal(record.missing_since, null);
    assert.equal(record.status, "analyzed");
    assert.equal(t.library.list({ limit: 200, includeMissing: true }).length, 5, "no duplicate record");
    rmSync(join(moved, ".."), { recursive: true, force: true });
  });
});

describe("AppBridge", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A launcher that plays the app: `respond` gets the parsed arguments and writes its output. */
  function fakeOpen(
    respond: (call: { args: string[]; command: string; input: string; write: (text: string) => void; stderr: (text: string) => void }) => Promise<void> | void,
  ): { launch: Launcher; calls: string[][] } {
    const calls: string[][] = [];
    const launch: Launcher = async (args) => {
      calls.push(args);
      const value = (flag: string) => args[args.indexOf(flag) + 1]!;
      const tail = args.slice(args.indexOf("--args") + 1);
      await respond({
        args: tail,
        command: tail[1]!,
        input: readFileSync(value("--stdin"), "utf8"),
        write: (text) => writeFileSync(value("--stdout"), text, { flag: "a" }),
        stderr: (text) => writeFileSync(value("--stderr"), text, { flag: "a" }),
      });
    };
    return { launch, calls };
  }

  function bridge(launch: Launcher): AppBridge {
    root = mkdtempSync(join(tmpdir(), "memvana-bridge-"));
    return new AppBridge("/Applications/Memvana Shot.app", join(root, "tmp"), launch);
  }

  test("runs commands in the background through `open` and reads lines as they arrive", async () => {
    const { launch, calls } = fakeOpen(async ({ write }) => {
      write('{"asset":"A","created":null,"modified":null,"width":1,"height":2,"edited":false,"favorite":false}\n{"asset":"B"');
      await new Promise((r) => setTimeout(r, 300)); // the reader sees half a line first
      write(',"created":null,"modified":null,"width":3,"height":4,"edited":true,"favorite":false}\n{"done":true,"count":2}\n');
    });
    const b = bridge(launch);
    const assets = await b.list();
    assert.deepEqual(assets.map((a) => [a.asset, a.width, a.edited]), [["A", 1, false], ["B", 3, true]]);
    assert.deepEqual(calls[0]!.slice(0, 6), ["-W", "-n", "-g", "-j", "-a", "/Applications/Memvana Shot.app"]);
    assert.deepEqual(readdirSync(join(root, "tmp")), [], "scratch files are removed");
  });

  test("authorize brings the app forward for the permission prompt", async () => {
    const { launch, calls } = fakeOpen(({ write }) => write('{"done":true,"authorization":"authorized"}\n'));
    assert.equal(await bridge(launch).authorize(), "authorized");
    assert.ok(!calls[0]!.includes("-g"));
    assert.deepEqual(calls[0]!.slice(-2), ["photos", "authorize"]);
  });

  test("extract sends jobs on stdin and options as arguments", async () => {
    let seen: { args: string[]; input: string } | undefined;
    const { launch } = fakeOpen(({ args, input, write }) => {
      seen = { args, input };
      write('{"id":"x","ok":false,"asset":"A","error":"gone"}\n{"id":"y","ok":false,"asset":"B","error":"gone"}\n{"done":true}\n');
    });
    const results: string[] = [];
    await bridge(launch).extract(
      [{ id: "x", asset: "A" }, { id: "y", asset: "B" }],
      { thumbDir: "/thumbs", maxDim: 512 },
      (r) => results.push(r.id!),
    );
    assert.deepEqual(seen!.args, ["photos", "extract", "--thumb-dir", "/thumbs", "--max-dim", "512"]);
    assert.deepEqual(seen!.input.trim().split("\n").map((l) => JSON.parse(l)), [{ id: "x", asset: "A" }, { id: "y", asset: "B" }]);
    assert.deepEqual(results, ["x", "y"]);
  });

  test("a run without a done line fails with the app's message", async () => {
    const { launch } = fakeOpen(({ write, stderr }) => {
      write('{"asset":"A"}\n');
      stderr("shot-helper: photos commands must be started with `open`\n");
    });
    await assert.rejects(bridge(launch).list(), /stopped before finishing "photos list": photos commands must be started/);
  });

  test("no access is a PhotosAccessError", async () => {
    const { launch } = fakeOpen(({ write }) =>
      write('{"done":true,"error":"not_authorized","authorization":"denied"}\n'),
    );
    await assert.rejects(bridge(launch).list(), (err: unknown) => {
      assert.ok(err instanceof PhotosAccessError);
      assert.equal(err.authorization, "denied");
      return true;
    });
  });
});
