import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dateFromFileName, exifToIso, inferCaptureDate } from "../src/dates.ts";

const local = (s: string) => new Date(s).toISOString(); // parse as local time, like the code under test

describe("exifToIso", () => {
  test("applies the EXIF offset", () => {
    assert.equal(exifToIso("2025:02:14 09:30:00", "-08:00"), "2025-02-14T17:30:00.000Z");
  });
  test("treats a missing offset as local time", () => {
    assert.equal(exifToIso("2025:02:14 09:30:00"), local("2025-02-14T09:30:00"));
  });
  test("rejects junk", () => {
    assert.equal(exifToIso("yesterday"), undefined);
    assert.equal(exifToIso(undefined), undefined);
  });
});

describe("dateFromFileName", () => {
  const cases: Array<[string, string | undefined]> = [
    ["Screenshot 2025-08-03 at 4.15.22 PM.png", local("2025-08-03T16:15:22")],
    ["Screenshot 2025-08-03 at 12.05.00 AM.png", local("2025-08-03T00:05:00")],
    ["Screenshot 2025-08-03 at 12.05.00 PM.png", local("2025-08-03T12:05:00")],
    ["Screen Shot 2019-05-01 at 15.04.22.png", local("2019-05-01T15:04:22")],
    ["CleanShot 2024-01-09 at 09.10.11@2x.png", local("2024-01-09T09:10:11")],
    ["Screenshot_20240501-102213.png", local("2024-05-01T10:22:13")],
    ["Screenshot_2024-05-01-10-22-13-123_com.android.chrome.jpg", local("2024-05-01T10:22:13")],
    ["export 2023-11-30 08.00.59.png", local("2023-11-30T08:00:59")],
    ["IMG_2041.PNG", undefined],
    ["Screenshot 2025-13-03 at 4.15.22 PM.png", undefined],
  ];
  for (const [name, expected] of cases) {
    test(name, () => assert.equal(dateFromFileName(name), expected));
  }
});

describe("inferCaptureDate", () => {
  test("prefers EXIF over XMP, filename and file times", () => {
    const result = inferCaptureDate(
      { exifDateTimeOriginal: "2025:02:14 09:30:00", exifOffsetTimeOriginal: "+00:00", xmpDateCreated: "2020-01-01T00:00:00" },
      "Screenshot 2021-01-01 at 1.00.00 PM.png",
      { birthtimeMs: Date.parse("2022-01-01") },
    );
    assert.deepEqual(result, { iso: "2025-02-14T09:30:00.000Z", source: "exif" });
  });
  test("falls back to the filename, then file birthtime", () => {
    assert.equal(inferCaptureDate({}, "Screenshot 2021-01-01 at 1.00.00 PM.png", {})?.source, "filename");
    const fromFile = inferCaptureDate({}, "IMG_1.PNG", { birthtimeMs: Date.parse("2022-03-04T05:06:07Z") });
    assert.deepEqual(fromFile, { iso: "2022-03-04T05:06:07.000Z", source: "file" });
  });
  test("ignores implausible dates", () => {
    assert.equal(inferCaptureDate({ exifDateTimeOriginal: "1970:01:01 00:00:00" }, "x.png", {}), undefined);
    assert.equal(inferCaptureDate({ exifDateTimeOriginal: "2999:01:01 00:00:00" }, "x.png", {}), undefined);
  });
});
