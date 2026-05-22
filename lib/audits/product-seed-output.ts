/**
 * NEXT-18B — NDJSON / CSV / JSON writers for product-seed audit reports.
 *
 * Pure I/O helpers. No Supabase imports. No classification logic. Each writer
 * is a thin wrapper over node:fs that:
 *   - Streams NDJSON line-by-line (no in-memory buffering of the full file).
 *   - Buffers small CSV/JSON outputs (roll-up, fan-out, conflicts, validation).
 *   - Records a manifest at the start of the run + a summary at the end.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type RunMetadata = {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  cliArgs: Record<string, string | number | boolean | null>;
  envHash: string;
  nodeVersion: string;
  supabaseJsVersion: string | null;
  generatorGitSha: string | null;
};

export function mkRunId(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return iso;
}

export function mkRunDir(baseDir: string, runId: string): string {
  const full = path.join(baseDir, runId);
  fs.mkdirSync(full, { recursive: true });
  fs.mkdirSync(path.join(full, "logs"), { recursive: true });
  fs.mkdirSync(path.join(full, "logs", "per-table"), { recursive: true });
  return full;
}

/**
 * Append-only NDJSON writer. Each `write(obj)` produces one `JSON.stringify(obj) + "\n"` line.
 * Caller MUST `close()` at the end.
 */
export class NDJsonWriter {
  private stream: fs.WriteStream;
  private count = 0;

  constructor(filePath: string) {
    this.stream = fs.createWriteStream(filePath, { flags: "w", encoding: "utf8" });
  }

  write(obj: unknown): void {
    this.stream.write(JSON.stringify(obj) + "\n");
    this.count++;
  }

  get lineCount(): number {
    return this.count;
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}

function csvEscape(value: unknown): string {
  if (value == null) return "";
  let s: string;
  if (typeof value === "string") s = value;
  else if (typeof value === "number" || typeof value === "boolean") s = String(value);
  else s = JSON.stringify(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function writeCsv(
  filePath: string,
  headers: readonly string[],
  rows: readonly Record<string, unknown>[],
): void {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

export function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function writeManifest(dir: string, meta: RunMetadata): void {
  writeJson(path.join(dir, "manifest.json"), meta);
}

export function writeRunSummary(dir: string, summary: unknown): void {
  writeJson(path.join(dir, "run-summary.json"), summary);
}

export function writeValidationChecks(dir: string, checks: unknown): void {
  writeJson(path.join(dir, "05-validation-checks.json"), checks);
}

/** SHA-256 of a string returned as 64-char lowercase hex. */
export function sha256Hex(input: string): string {
  const crypto = require("node:crypto") as typeof import("node:crypto");
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}
