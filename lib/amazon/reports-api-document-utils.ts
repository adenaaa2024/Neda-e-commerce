/**
 * Pure helpers for Reports API document bytes (safe for unit tests — no server-only).
 */

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function md5HexFromSha256Prefix(sha256: string): string {
  return sha256.slice(0, 32);
}

export function decompressReportDocument(buf: Buffer, compressionAlgorithm: string | null): Buffer {
  const algo = (compressionAlgorithm ?? "").trim().toUpperCase();
  if (algo === "GZIP" || (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b)) {
    return gunzipSync(buf);
  }
  return buf;
}

export function parseCsvHeadersFromText(text: string): string[] {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  return firstLine.split("\t").length > 1
    ? firstLine.split("\t").map((h) => h.trim())
    : firstLine.split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
}
