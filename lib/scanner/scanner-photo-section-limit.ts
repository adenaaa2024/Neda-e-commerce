/** Max photos per operator scanner photo section (item modal + box docs). */
export const OPERATOR_SCANNER_PHOTO_SECTION_MAX = 3;

export const SCANNER_PHOTO_MAX_HELPER = "Maximum 3 photos.";

export function capScannerPhotoUrls(urls: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of urls) {
    const s = String(raw ?? "").trim();
    if (!s || !/^https?:\/\//i.test(s)) continue;
    if (out.includes(s)) continue;
    out.push(s);
    if (out.length >= OPERATOR_SCANNER_PHOTO_SECTION_MAX) break;
  }
  return out;
}
