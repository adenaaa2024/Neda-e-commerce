/**
 * NEXT-STORAGE-04 — Quarantine / cleanup review report (read-only, local files only).
 *
 * Consumes a completed NEXT-STORAGE-02 inventory run. No Storage API, no DB, no mutations.
 *
 *   npx tsx scripts/storage-quarantine-review-report.ts --source-run-id=org-inv-fixed
 *   npx tsx scripts/storage-quarantine-review-report.ts --source-dir=.cursor/audit-reports/next-storage-02/org-inv-fixed --run-id=my-run
 *
 * Writes: .cursor/audit-reports/next-storage-04/<run_id>/
 */

import * as fs from "node:fs";
import * as path from "node:path";

type QuarantineBucket =
  | "keep_referenced"
  | "cache_candidate"
  | "test_artifact_candidate"
  | "orphan_review_required"
  | "unknown_do_not_touch"
  | "migrate_later"
  | "cleanup_later";

type InventoryNdRow = {
  bucket: string;
  object_name: string;
  classification: string;
  reference_status: string;
  risk_level: string;
  reason_codes: string[];
  recommended_action?: string;
};

type SourceManifest = {
  include_public_url_columns?: boolean;
  max_objects_per_bucket?: number;
  bucket_summary?: { bucket: string; listed: number; shallow?: boolean }[];
};

function isoRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

function escapeCsvCell(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function rowToCsvLine(cols: string[]): string {
  return cols.map((c) => escapeCsvCell(c)).join(",") + "\n";
}

function traceNdjson(logPath: string, rec: Record<string, unknown>): void {
  fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n", "utf8");
}

function parseArgs(argv: string[]): { runId: string | null; sourceDir: string | null; sourceRunId: string | null } {
  let runId: string | null = null;
  let sourceDir: string | null = null;
  let sourceRunId: string | null = null;
  for (const a of argv) {
    if (a.startsWith("--run-id=")) runId = a.slice("--run-id=".length).trim() || null;
    if (a.startsWith("--source-dir=")) sourceDir = a.slice("--source-dir=".length).trim() || null;
    if (a.startsWith("--source-run-id=")) sourceRunId = a.slice("--source-run-id=".length).trim() || null;
  }
  return { runId, sourceDir, sourceRunId };
}

function resolveSourceDir(cwd: string, args: ReturnType<typeof parseArgs>): string {
  if (args.sourceDir) {
    return path.isAbsolute(args.sourceDir) ? args.sourceDir : path.resolve(cwd, args.sourceDir);
  }
  if (args.sourceRunId) {
    return path.resolve(cwd, ".cursor", "audit-reports", "next-storage-02", args.sourceRunId);
  }
  throw new Error("Provide --source-dir=... or --source-run-id=<inventory_run_id>.");
}

function parseNdjsonLines(filePath: string): InventoryNdRow[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const out: InventoryNdRow[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as unknown as Record<string, unknown>;
      out.push({
        bucket: String(o.bucket ?? ""),
        object_name: String(o.object_name ?? ""),
        classification: String(o.classification ?? ""),
        reference_status: String(o.reference_status ?? ""),
        risk_level: String(o.risk_level ?? ""),
        reason_codes: Array.isArray(o.reason_codes) ? (o.reason_codes as unknown[]).map((x) => String(x)) : [],
        recommended_action: o.recommended_action != null ? String(o.recommended_action) : "",
      });
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function loadDbMatchSet(sourceDir: string, tracePath: string): Set<string> {
  const p = path.join(sourceDir, "04-db-reference-matches.csv");
  const set = new Set<string>();
  if (!fs.existsSync(p)) {
    traceNdjson(tracePath, { phase: "load_db_matches", count: 0, file: p, note: "missing" });
    return set;
  }
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]!);
    if (cols.length < 2) continue;
    set.add(`${cols[0]!}|${cols[1]!}`);
  }
  traceNdjson(tracePath, { phase: "load_db_matches", count: set.size, file: p });
  return set;
}

function loadOrphanSet(sourceDir: string, tracePath: string): Set<string> {
  const p = path.join(sourceDir, "05-orphan-candidates.csv");
  const set = new Set<string>();
  if (!fs.existsSync(p)) {
    traceNdjson(tracePath, { phase: "load_orphan_csv", count: 0, file: p, note: "missing" });
    return set;
  }
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]!);
    if (cols.length < 2) continue;
    set.add(`${cols[0]!}|${cols[1]!}`);
  }
  traceNdjson(tracePath, { phase: "load_orphan_csv", count: set.size, file: p });
  return set;
}

function loadManifest(sourceDir: string): SourceManifest | null {
  const p = path.join(sourceDir, "manifest.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as SourceManifest;
  } catch {
    return null;
  }
}

/** Optional NEXT-STORAGE-02 rollup for cross-check (read-only). */
function loadClassificationRollup(sourceDir: string): { classification: string; count: number }[] {
  const p = path.join(sourceDir, "03-classification-rollup.csv");
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
  const out: { classification: string; count: number }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]!);
    if (cols.length < 2) continue;
    const n = Number(cols[1]);
    out.push({ classification: cols[0]!, count: Number.isFinite(n) ? n : 0 });
  }
  return out;
}

function bucketListingMayBeCapped(manifest: SourceManifest | null, bucket: string): boolean {
  const max = manifest?.max_objects_per_bucket;
  if (max == null || !manifest?.bucket_summary) return false;
  const row = manifest.bucket_summary.find((b) => b.bucket === bucket);
  return row != null && row.listed >= max;
}

function isEvidenceOrPhotoRelated(row: InventoryNdRow): boolean {
  const full = `${row.bucket}/${row.object_name}`.toLowerCase();
  const sensBuckets = new Set(["media", "manifests", "claim-reports", "incident-photos", "profiles", "logos"]);
  if (sensBuckets.has(row.bucket)) return true;
  const sensClass = new Set([
    "return_photo_evidence",
    "package_photo_evidence",
    "pallet_photo_evidence",
    "claim_evidence",
    "claim_report_pdf",
    "manifest_or_packing_slip",
  ]);
  if (sensClass.has(row.classification)) return true;
  if (
    /incident|claim|evidence|photo|label|manifest|pallet|return|bol|shipping/i.test(full) &&
    row.bucket !== "raw-reports"
  ) {
    return true;
  }
  return false;
}

function isMediaUrlScanCapped(manifest: SourceManifest | null, bucket: string): boolean {
  if (!manifest) return false;
  if (manifest.include_public_url_columns === true) return false;
  return ["media", "manifests", "incident-photos", "claim-reports"].includes(bucket);
}

function isTestArtifactPath(row: InventoryNdRow): boolean {
  const p = row.object_name.toLowerCase();
  return (
    p.includes(".emptyfolderplaceholder") ||
    /\/test\/|\/scratch\/|^test[-/]/i.test(p) ||
    p.includes("/dev/")
  );
}

function hasCanonicalStoreSegment(row: InventoryNdRow): boolean {
  const parts = row.object_name.split("/").filter(Boolean);
  if (parts.length < 3) return false;
  const seg = parts[1]!;
  if (seg === "org-level") return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg);
}

function noDbMatchInSample(row: InventoryNdRow): boolean {
  return row.reason_codes.some((c) => c.includes("no_db_match_in_sample"));
}

function jsonbOrPrefixCorrelationIncomplete(row: InventoryNdRow): boolean {
  if (row.reference_status === "cache") return true;
  if (row.reference_status === "unknown_not_checked" || row.reference_status === "skipped") return true;
  return row.reason_codes.some(
    (c) => c.includes("no_db_prefix_match") || c.includes("url_columns_skipped") || c.includes("jsonb"),
  );
}

function isReferenced(row: InventoryNdRow, inDbCsv: boolean): boolean {
  return row.reference_status === "referenced" || inDbCsv;
}

type QuarantineMeta = {
  bucket: QuarantineBucket;
  policy_dependency: string;
  safe_after_condition: string;
  required_human_approval: boolean;
  quarantine_recommended_action: string;
};

function assignQuarantine(
  row: InventoryNdRow,
  inDbCsv: boolean,
  inOrphanCsv: boolean,
  manifest: SourceManifest | null,
): QuarantineMeta {
  const ref = isReferenced(row, inDbCsv);
  const evidence = isEvidenceOrPhotoRelated(row);
  const urlCap = isMediaUrlScanCapped(manifest, row.bucket);
  const listCap = bucketListingMayBeCapped(manifest, row.bucket);
  const noSample = noDbMatchInSample(row);
  const jsonbIncomplete = jsonbOrPrefixCorrelationIncomplete(row);
  const correlationWeak = noSample || jsonbIncomplete || urlCap || listCap;

  const safeHuman = "human_approval_required";
  const terminal = "upload_terminal";
  const retention = "retention_satisfied_per_tenant_policy";
  const noSession = "no_active_session";

  const forceReviewOrUnknown = (): QuarantineMeta => {
    if (inOrphanCsv) {
      return {
        bucket: "orphan_review_required",
        policy_dependency: "cleanup_review_required;allowed_cleanup_roles;audit_log",
        safe_after_condition: `${terminal};${retention};expanded_correlation_complete;${safeHuman}`,
        required_human_approval: true,
        quarantine_recommended_action: "queue_human_orphan_review",
      };
    }
    return {
      bucket: "unknown_do_not_touch",
      policy_dependency: "expanded_db_correlation;jsonb_url_extraction;media_url_scan_not_capped",
      safe_after_condition: `full_reference_audit_completed;${safeHuman}`,
      required_human_approval: true,
      quarantine_recommended_action: "no_automated_action_pending_correlation",
    };
  };

  const testPath = isTestArtifactPath(row);
  if (testPath) {
    const dbMissingOrWeak = !ref && (noSample || correlationWeak);
    if (evidence || dbMissingOrWeak) {
      return forceReviewOrUnknown();
    }
    return {
      bucket: "test_artifact_candidate",
      policy_dependency: "cleanup_review_required;allowed_cleanup_roles",
      safe_after_condition: `${safeHuman};not_referenced_by_production_job;${retention}`,
      required_human_approval: true,
      quarantine_recommended_action: "review_test_or_placeholder_then_cleanup_with_approval",
    };
  }

  if (ref) {
    if (row.classification === "pim_scan_cache") {
      return {
        bucket: "cache_candidate",
        policy_dependency: "pim_cache_retention_days;storage_cache_ttl_hours;cleanup_review_required",
        safe_after_condition: `${terminal};${retention};${noSession};${safeHuman}`,
        required_human_approval: true,
        quarantine_recommended_action: "apply_cache_ttl_then_cleanup_with_approval",
      };
    }
    if (row.classification === "chunked_upload_part") {
      return {
        bucket: "cleanup_later",
        policy_dependency: "raw_report_retention_days;cleanup_review_required;allowed_cleanup_roles",
        safe_after_condition: `merge_completed_and_verified;${terminal};${retention};no_active_import_session;${safeHuman}`,
        required_human_approval: true,
        quarantine_recommended_action: "verify_merge_terminal_then_cleanup_with_approval",
      };
    }
    if (
      row.bucket === "raw-reports" &&
      (row.classification === "production_raw_report_input" ||
        row.classification === "pim_merge_or_test_artifact" ||
        /\.(csv|txt|xlsx)$/i.test(row.object_name)) &&
      !hasCanonicalStoreSegment(row)
    ) {
      return {
        bucket: "migrate_later",
        policy_dependency: "default_store_policy_inheritance;storage_path_builder_rollout",
        safe_after_condition: `canonical_path_migration_plan_approved;db_metadata_remap_completed;verification_passed;${safeHuman}`,
        required_human_approval: true,
        quarantine_recommended_action: "plan_path_migration_no_delete_until_remap",
      };
    }
    return {
      bucket: "keep_referenced",
      policy_dependency: "none_until_retention_policy_attached",
      safe_after_condition: `${retention}_only_with_future_policy_and_audit`,
      required_human_approval: false,
      quarantine_recommended_action: "keep",
    };
  }

  if (inOrphanCsv) {
    return {
      bucket: "orphan_review_required",
      policy_dependency: "cleanup_review_required;allowed_cleanup_roles;audit_log",
      safe_after_condition: `expanded_correlation_proves_unreferenced;${retention};${safeHuman}`,
      required_human_approval: true,
      quarantine_recommended_action: "queue_human_orphan_review",
    };
  }

  if (row.reference_status === "unknown_not_checked" || row.reference_status === "skipped") {
    return {
      bucket: "unknown_do_not_touch",
      policy_dependency: "expanded_db_correlation;full_table_scan",
      safe_after_condition: `full_reference_audit_completed;${safeHuman}`,
      required_human_approval: true,
      quarantine_recommended_action: "needs_full_db_reference_check",
    };
  }

  if (row.reference_status === "cache") {
    return {
      bucket: "unknown_do_not_touch",
      policy_dependency: "raw_report_uploads_metadata.storage_prefix_resync;jsonb_correlation",
      safe_after_condition: `prefix_match_revalidated_in_inventory;${safeHuman}`,
      required_human_approval: true,
      quarantine_recommended_action: "resolve_prefix_or_jsonb_correlation",
    };
  }

  if (evidence || urlCap) {
    return {
      bucket: "unknown_do_not_touch",
      policy_dependency:
        "include_public_url_columns_full_scan;jsonb_gallery_urls;claim_evidence_columns;scanner_photo_retention_days",
      safe_after_condition: `correlation_complete_not_capped;legal_review_if_evidence;${safeHuman}`,
      required_human_approval: true,
      quarantine_recommended_action: "no_automated_action_sensitive_or_url_scan_incomplete",
    };
  }

  if (row.bucket === "raw-reports" && row.reference_status === "unreferenced_candidate") {
    return {
      bucket: "orphan_review_required",
      policy_dependency: "cleanup_review_required",
      safe_after_condition: `db_reference_double_check;import_session_not_resumable;${safeHuman}`,
      required_human_approval: true,
      quarantine_recommended_action: "queue_human_raw_report_review",
    };
  }

  return {
    bucket: "unknown_do_not_touch",
    policy_dependency: "expanded_inventory_scope;per_store_prefix",
    safe_after_condition: `${safeHuman};no_automated_delete`,
    required_human_approval: true,
    quarantine_recommended_action: "no_automated_action_default_unknown",
  };
}

/** Never promote to cache/cleanup/migrate/test when correlation or evidence rules forbid automation labels. */
function enforceConservativeLabels(
  row: InventoryNdRow,
  meta: QuarantineMeta,
  inDbCsv: boolean,
  inOrphanCsv: boolean,
  manifest: SourceManifest | null,
): QuarantineMeta {
  const actionable: QuarantineBucket[] = ["cache_candidate", "cleanup_later", "migrate_later", "test_artifact_candidate"];
  if (!actionable.includes(meta.bucket)) return meta;

  const ref = isReferenced(row, inDbCsv);
  const evidence = isEvidenceOrPhotoRelated(row);
  const urlCap = isMediaUrlScanCapped(manifest, row.bucket);
  const noSample = noDbMatchInSample(row);
  const jsonbIncomplete = jsonbOrPrefixCorrelationIncomplete(row);
  const dbRefMissing = !ref && (noSample || !inDbCsv);
  const capOrIncomplete = urlCap || jsonbIncomplete || bucketListingMayBeCapped(manifest, row.bucket);

  if (
    dbRefMissing ||
    jsonbIncomplete ||
    (urlCap && ["media", "manifests", "incident-photos", "claim-reports"].includes(row.bucket)) ||
    (evidence && !ref) ||
    (capOrIncomplete && evidence)
  ) {
    if (inOrphanCsv) {
      return {
        bucket: "orphan_review_required",
        policy_dependency: "cleanup_review_required;conservative_override_incomplete_evidence_or_db",
        safe_after_condition:
          "upload_terminal;retention_satisfied;expanded_correlation_complete;human_approval_required",
        required_human_approval: true,
        quarantine_recommended_action: "queue_human_orphan_review_conservative_override",
      };
    }
    return {
      bucket: "unknown_do_not_touch",
      policy_dependency: "expanded_db_correlation;jsonb_url_extraction;media_url_scan_not_capped",
      safe_after_condition: "full_reference_audit_completed;human_approval_required",
      required_human_approval: true,
      quarantine_recommended_action: "no_automated_action_conservative_override",
    };
  }

  return meta;
}

function writePolicyMatrix(outPath: string): void {
  const rows: string[][] = [
    ["rule_id", "applies_to_bucket", "description", "policy_settings_keys", "violation_risk"],
    [
      "QS04-001",
      "raw-reports",
      "Chunk parts: cleanup only after merge verified, retention, and approval (never delete-safe automatically).",
      "raw_report_retention_days;cleanup_review_required;allowed_cleanup_roles",
      "Breaks import resume if removed early",
    ],
    [
      "QS04-002",
      "raw-reports",
      "PIM cache: TTL + terminal session + human approval before cleanup.",
      "pim_cache_retention_days;storage_cache_ttl_hours;cleanup_review_required",
      "Breaks PIM replay if deleted early",
    ],
    [
      "QS04-003",
      "media,manifests,claim-reports,incident-photos,profiles,logos",
      "Evidence / public URL objects: full URL + JSONB correlation; capped scans ⇒ unknown or human orphan queue only.",
      "include_public_url_columns;claim_evidence_retention_days;scanner_photo_retention_days;cleanup_review_required",
      "False orphan if correlation incomplete",
    ],
    [
      "QS04-004",
      "all",
      "No automated delete-safe marking; audit + role gate for any cleanup execution (out of scope for this report).",
      "allowed_cleanup_roles;audit_log_storage_cleanup",
      "Compliance and tenant trust",
    ],
  ];
  fs.writeFileSync(
    outPath,
    rowToCsvLine(rows[0]!) + rows.slice(1).map((r) => rowToCsvLine(r)).join(""),
    "utf8",
  );
}

function orphanGroupKey(row: InventoryNdRow): string {
  const parts = row.object_name.split("/").filter(Boolean);
  const head = parts.slice(0, 2).join("/");
  return `${row.bucket}|${head || "(root)"}`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const sourceDir = resolveSourceDir(cwd, args);
  const runId = args.runId ?? isoRunId();
  const outDir = path.resolve(cwd, ".cursor", "audit-reports", "next-storage-04", runId);
  const logsDir = path.join(outDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const tracePath = path.join(logsDir, "quarantine-trace.ndjson");
  fs.writeFileSync(tracePath, "", "utf8");

  traceNdjson(tracePath, {
    phase: "start",
    sourceDir,
    outDir,
    validation: { storage_writes: 0, db_writes: 0, storage_mutations: 0, path_changes: 0, bucket_changes: 0 },
  });

  const ndPath = path.join(sourceDir, "01-storage-objects.ndjson");
  if (!fs.existsSync(ndPath)) {
    throw new Error(`Missing source file: ${ndPath}`);
  }

  const manifest = loadManifest(sourceDir);
  const rollup03 = loadClassificationRollup(sourceDir);
  traceNdjson(tracePath, { phase: "load_03_rollup", rows: rollup03.length });
  const rows = parseNdjsonLines(ndPath);
  const dbSet = loadDbMatchSet(sourceDir, tracePath);
  const orphanSet = loadOrphanSet(sourceDir, tracePath);

  const counts: Record<string, number> = {};
  const bump = (k: string) => {
    counts[k] = (counts[k] ?? 0) + 1;
  };

  const csvPath = path.join(outDir, "quarantine-candidates.csv");
  fs.writeFileSync(
    csvPath,
    rowToCsvLine([
      "quarantine_bucket",
      "storage_bucket",
      "path",
      "classification",
      "reference_status",
      "reason_codes",
      "recommended_action",
      "safe_after_condition",
      "required_human_approval",
      "policy_dependency",
      "risk_level",
      "in_db_reference_csv",
      "in_orphan_csv",
    ]),
    "utf8",
  );

  const riskyOrphanGroups = new Map<string, { count: number; max_risk: string }>();

  const unknownPatterns = new Map<string, number>();

  for (const row of rows) {
    const key = `${row.bucket}|${row.object_name}`;
    const inDb = dbSet.has(key);
    const inOrphan = orphanSet.has(key);
    let meta = assignQuarantine(row, inDb, inOrphan, manifest);
    meta = enforceConservativeLabels(row, meta, inDb, inOrphan, manifest);
    bump(meta.bucket);

    const invRec = row.recommended_action ?? "";
    fs.appendFileSync(
      csvPath,
      rowToCsvLine([
        meta.bucket,
        row.bucket,
        row.object_name,
        row.classification,
        row.reference_status,
        row.reason_codes.join(";"),
        invRec ? `${invRec} | ${meta.quarantine_recommended_action}` : meta.quarantine_recommended_action,
        meta.safe_after_condition,
        meta.required_human_approval ? "yes" : "no",
        meta.policy_dependency,
        row.risk_level,
        inDb ? "yes" : "no",
        inOrphan ? "yes" : "no",
      ]),
      "utf8",
    );

    if (meta.bucket === "orphan_review_required" && (row.risk_level === "high" || row.risk_level === "medium")) {
      const gk = orphanGroupKey(row);
      const cur = riskyOrphanGroups.get(gk) ?? { count: 0, max_risk: "low" };
      cur.count += 1;
      const rank = (r: string) => (r === "high" ? 3 : r === "medium" ? 2 : 1);
      if (rank(row.risk_level) > rank(cur.max_risk)) cur.max_risk = row.risk_level;
      riskyOrphanGroups.set(gk, cur);
    }
    if (meta.bucket === "unknown_do_not_touch") {
      const pat = row.classification || "unclassified";
      unknownPatterns.set(pat, (unknownPatterns.get(pat) ?? 0) + 1);
    }
  }

  writePolicyMatrix(path.join(outDir, "quarantine-policy-matrix.csv"));

  const riskySorted = [...riskyOrphanGroups.entries()]
    .map(([group, v]) => ({ group, ...v }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

  const summary = {
    run_id: runId,
    source_inventory_dir: sourceDir,
    read_only: true,
    no_storage_mutations: true,
    no_db_mutations: true,
    no_path_changes: true,
    no_bucket_changes: true,
    no_cleanup_execution: true,
    no_delete_safe_marking: true,
    total_objects: rows.length,
    quarantine_bucket_counts: counts,
    risky_orphan_groups_top: riskySorted,
    top_unknown_classification_patterns: [...unknownPatterns.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([pattern, n]) => ({ pattern, count: n })),
    source_manifest_hints: manifest
      ? {
          include_public_url_columns: manifest.include_public_url_columns ?? null,
          max_objects_per_bucket: manifest.max_objects_per_bucket ?? null,
        }
      : null,
    source_classification_rollup_03: rollup03,
    checks: [
      { id: "QS04-V1", passed: true, detail: "No Storage client; no network I/O; filesystem read of prior audit only." },
      { id: "QS04-V2", passed: true, detail: "No Supabase / SQL; zero DB writes." },
      { id: "QS04-V3", passed: true, detail: "No delete_safe column; no automated delete-safe marking." },
      { id: "QS04-V4", passed: true, detail: "Writes confined to .cursor/audit-reports/next-storage-04/<run_id>/." },
    ],
  };
  fs.writeFileSync(path.join(outDir, "quarantine-summary.json"), JSON.stringify(summary, null, 2), "utf8");

  traceNdjson(tracePath, { phase: "complete", total_rows: rows.length, quarantine_bucket_counts: counts });

  console.log(JSON.stringify({ runId, outDir, ...summary }, null, 2));
}

main();
