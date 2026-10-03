// Works out when a screenshot was captured, from the best evidence available.

export type CaptureSource = "exif" | "xmp" | "tiff" | "png" | "filename" | "file";

export interface CaptureDate {
  iso: string;
  source: CaptureSource;
}

export interface ImageMetadata {
  exifDateTimeOriginal?: string;
  exifOffsetTimeOriginal?: string;
  exifUserComment?: string;
  xmpDateCreated?: string;
  xmpCreateDate?: string;
  xmpUserComment?: string;
  tiffDateTime?: string;
  tiffMake?: string;
  tiffModel?: string;
  tiffSoftware?: string;
  pngCreationTime?: string;
  pngSoftware?: string;
}

export interface FileTimes {
  birthtimeMs?: number;
  mtimeMs?: number;
}

const MIN_YEAR = 1995;

export function inferCaptureDate(
  metadata: ImageMetadata,
  fileName: string,
  times: FileTimes,
): CaptureDate | undefined {
  const candidates: Array<[CaptureSource, string | undefined]> = [
    ["exif", exifToIso(metadata.exifDateTimeOriginal, metadata.exifOffsetTimeOriginal)],
    ["xmp", isoish(metadata.xmpDateCreated) ?? isoish(metadata.xmpCreateDate)],
    ["tiff", exifToIso(metadata.tiffDateTime)],
    ["png", isoish(metadata.pngCreationTime)],
    ["filename", dateFromFileName(fileName)],
  ];
  for (const [source, iso] of candidates) {
    if (iso && plausible(iso)) return { iso, source };
  }
  for (const ms of [times.birthtimeMs, times.mtimeMs]) {
    if (ms && ms > 0) {
      const iso = new Date(ms).toISOString();
      if (plausible(iso)) return { iso, source: "file" };
    }
  }
  return undefined;
}

/** "2025:02:14 09:30:00" (+ optional "-08:00") → ISO in UTC. No offset means local time. */
export function exifToIso(value?: string, offset?: string): string | undefined {
  const m = value?.trim().match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  const tz = offset && /^[+-]\d{2}:\d{2}$/.test(offset.trim()) ? offset.trim() : "";
  return toIso(`${y}-${mo}-${d}T${h}:${mi}:${s}${tz}`);
}

/** ISO-like strings ("2025-02-14T09:30:00", with or without offset), or RFC 1123. */
function isoish(value?: string): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/.test(v) || /^[A-Z][a-z]{2}, /.test(v)) {
    return toIso(v);
  }
  return exifToIso(v);
}

const FILENAME_PATTERNS: RegExp[] = [
  // macOS / CleanShot: "Screenshot 2025-08-03 at 4.15.22 PM", "Screen Shot 2019-05-01 at 15.04.22"
  /(?:screenshot|screen shot|cleanshot)\s+(\d{4})-(\d{2})-(\d{2})\s+at\s+(\d{1,2})\.(\d{2})\.(\d{2})(?:[\s ]*([ap]m))?/i,
  // Android: "Screenshot_20240501-102213", "Screenshot_2024-05-01-10-22-13-123_com.app"
  /screenshot_(\d{4})-?(\d{2})-?(\d{2})[-_](\d{2})-?(\d{2})-?(\d{2})/i,
  // Generic timestamp: "2024-05-01 10.22.13", "2024-05-01_10-22-13", "20240501_102213"
  /(?<!\d)(\d{4})-?(\d{2})-?(\d{2})[ _T-](\d{2})[.:\-]?(\d{2})[.:\-]?(\d{2})(?!\d)/,
];

/** Reads a capture time out of common screenshot file names, as local time. */
export function dateFromFileName(fileName: string): string | undefined {
  for (const pattern of FILENAME_PATTERNS) {
    const m = fileName.match(pattern);
    if (!m) continue;
    const [, y, mo, d, hRaw, mi, s, meridiem] = m;
    let h = Number(hRaw);
    if (meridiem) {
      const pm = meridiem.toLowerCase() === "pm";
      if (h === 12) h = pm ? 12 : 0;
      else if (pm) h += 12;
    }
    if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31 || h > 23) continue;
    const iso = toIso(`${y}-${mo}-${d}T${String(h).padStart(2, "0")}:${mi}:${s}`);
    if (iso) return iso;
  }
  return undefined;
}

function toIso(value: string): string | undefined {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function plausible(iso: string): boolean {
  const year = Number(iso.slice(0, 4));
  return year >= MIN_YEAR && Date.parse(iso) <= Date.now() + 24 * 3600 * 1000;
}
