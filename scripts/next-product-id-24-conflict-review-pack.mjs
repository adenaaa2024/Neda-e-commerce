/**
 * NEXT-PRODUCT-ID-24 — Read-only ambiguous/conflict review pack (42 unresolved FBA rows).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function loadEnvLocal() {
  const p = path.join(REPO_ROOT, ".env.local");
  const text = fs.readFileSync(p, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([^#=]+)=(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

function loadDirectUrl() {
  const text = fs.readFileSync(path.join(REPO_ROOT, ".env.local"), "utf8");
  const line = text.split(/\r?\n/).find((l) => l.startsWith("DIRECT_POSTGRES_URL="));
  return line.slice("DIRECT_POSTGRES_URL=".length).trim();
}

function runIdUtc() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function escCsv(v) {
  if (v == null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function mapReasonToCategory(primaryReason) {
  const r = primaryReason ?? "";
  if (r === "f2_cross_product_conflict") return "cross_product_conflict";
  if (r === "f3_shape_invalid_alongside_valid") return "dirty_identifier";
  if (r === "f3_products_sku_collision") return "duplicate_sku";
  if (r.startsWith("rank_") && r.includes("identifier_map_hit")) return "identifier_collision_or_fanout";
  if (r.startsWith("rank_") && r.includes("products_direct_hit")) return "multi_match_ambiguity";
  if (r === "upload_provenance_unresolved") return "lineage_gap";
  if (r === "no_high_confidence_identifier") return "multi_match_ambiguity";
  if (r === "all_identifiers_shape_invalid") return "dirty_identifier";
  if (r === "no_identifier_no_title" || r === "title_only_no_identifier") return "missing_identifier";
  return "other";
}

function riskFromCategory(cat, conflictCount) {
  if (cat === "cross_product_conflict") return conflictCount > 2 ? "critical" : "high";
  if (cat === "duplicate_sku") return "high";
  if (cat === "identifier_collision_or_fanout") return "high";
  if (cat === "dirty_identifier") return "medium";
  if (cat === "lineage_gap") return "medium";
  if (cat === "multi_match_ambiguity") return "high";
  if (cat === "missing_identifier") return "low";
  return "medium";
}

function suggestAction(cat, primaryReason) {
  if (cat === "cross_product_conflict") return "owner_pick_product_or_merge; optional map cleanup after decision";
  if (cat === "duplicate_sku") return "align_sku_to_canonical_product_or_rename_source_row";
  if (cat === "identifier_collision_or_fanout") return "map_cleanup_or_disambiguate_identifier_scope";
  if (cat === "dirty_identifier") return "fix_source_identifier_then_reimport_or_manual_map";
  if (cat === "lineage_gap") return "repair_upload_linkage_then_re_resolve";
  if (cat === "multi_match_ambiguity") return "manual_pick_target_product; document_match_policy";
  if (cat === "missing_identifier") return "enrich_identifiers_or_quarantine_row";
  return "manual_review";
}

async function main() {
  loadEnvLocal();
  const runId = runIdUtc();
  const outDir = path.join(REPO_ROOT, ".cursor/audit-reports/next-product-id-24", runId);
  fs.mkdirSync(path.join(outDir, "logs"), { recursive: true });
  const logs = [];
  const log = (event, data = {}) => logs.push(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));

  log("start", { runId, auditPrompt: "NEXT-PRODUCT-ID-24" });

  const client = new pg.Client({ connectionString: loadDirectUrl(), ssl: { rejectUnauthorized: false } });
  await client.connect();

  const { rows: cntRow } = await client.query(`
    SELECT COUNT(*)::int AS c FROM public.amazon_fba_inventory WHERE resolved_product_id IS NULL
  `);
  const unresolvedCount = cntRow[0].c;
  log("unresolved_count", { unresolvedCount });

  const { rows: ur } = await client.query(`
    SELECT id, organization_id, store_id, sku, fnsku, asin, product_name,
           resolved_product_id, identifier_resolution_status,
           source_upload_id, updated_at
    FROM public.amazon_fba_inventory
    WHERE resolved_product_id IS NULL
    ORDER BY id
  `);

  const { rows: global } = await client.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL AND identifier_resolution_status = 'resolved')::int AS resolved
    FROM public.amazon_fba_inventory
  `);

  await client.end();

  const dryParent = path.join(outDir, "live-dry-run");
  fs.mkdirSync(dryParent, { recursive: true });
  const relDry = path.relative(REPO_ROOT, dryParent);
  const dr = spawnSync(
    "npx",
    ["tsx", "scripts/product-seed-dry-run-report.ts", "--source-table=amazon_fba_inventory", `--output-dir=${relDry}`],
    { cwd: REPO_ROOT, encoding: "utf8", shell: true, env: { ...process.env } },
  );
  if (dr.status !== 0) {
    log("dry_run_fail", { stderr: dr.stderr?.slice(0, 2000) });
    fs.writeFileSync(path.join(outDir, "logs", "product-id-24.ndjson"), logs.join("\n") + "\n");
    throw new Error(`dry-run failed: ${dr.stderr}`);
  }
  log("dry_run_ok");

  const subdirs = fs.readdirSync(dryParent, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  if (subdirs.length !== 1) throw new Error(`expected one dry-run subdir, got ${subdirs.join(",")}`);
  const ndPath = path.join(dryParent, subdirs[0], "01-rows.ndjson");
  const ndMap = new Map();
  for (const line of fs.readFileSync(ndPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o.source_table === "amazon_fba_inventory") ndMap.set(o.source_row_id, o);
  }

  const client2 = new pg.Client({ connectionString: loadDirectUrl(), ssl: { rejectUnauthorized: false } });
  await client2.connect();

  const allConflictIds = new Set();
  const rows = [];
  for (const r of ur) {
    const nd = ndMap.get(r.id);
    const primary = nd?.primary_reason ?? "unknown_not_in_dry_run";
    const cat = mapReasonToCategory(primary);
    const cids = nd?.conflict_product_ids ?? [];
    const ccount = Array.isArray(cids) ? cids.length : 0;
    for (const id of cids || []) if (id) allConflictIds.add(id);
    rows.push({
      ...r,
      nd,
      primary_reason: primary,
      category: cat,
      conflict_product_ids: cids,
      conflict_count: ccount,
      bucket_id: nd?.bucket_id,
      risk: riskFromCategory(cat, ccount),
      suggested_action: suggestAction(cat, primary),
      id_sig: `${r.organization_id}|${r.store_id}|${String(r.asin ?? "").trim().toUpperCase()}|${String(r.sku ?? "").trim()}|${String(r.fnsku ?? "").trim().toUpperCase()}`,
    });
  }

  const titles = new Map();
  if (allConflictIds.size > 0) {
    const ids = [...allConflictIds];
    const { rows: pr } = await client2.query(
      `SELECT id, product_name, sku, asin FROM public.products
       WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [ids],
    );
    for (const p of pr) titles.set(p.id, p);
  }
  await client2.end();

  const bySig = new Map();
  for (const r of rows) {
    if (!bySig.has(r.id_sig)) bySig.set(r.id_sig, []);
    bySig.get(r.id_sig).push(r);
  }

  const byCat = {};
  for (const r of rows) {
    byCat[r.category] = (byCat[r.category] ?? 0) + 1;
  }

  const classHdr = [
    "source_row_id",
    "organization_id",
    "store_id",
    "seller_sku",
    "asin",
    "fnsku",
    "product_name",
    "bucket_id",
    "primary_reason",
    "review_category",
    "risk_level",
    "conflict_product_count",
    "conflict_product_ids_json",
    "suggested_action",
    "confidence_notes",
  ];
  const classLines = [classHdr.join(",")].concat(
    rows.map((r) =>
      [
        r.id,
        r.organization_id,
        r.store_id,
        r.sku,
        r.asin,
        r.fnsku,
        r.product_name,
        r.bucket_id ?? "",
        r.primary_reason,
        r.category,
        r.risk,
        r.conflict_count,
        JSON.stringify(r.conflict_product_ids ?? []),
        r.suggested_action,
        r.nd?.secondary_reasons?.length ? `secondary:${r.nd.secondary_reasons.join(";")}` : "",
      ]
        .map(escCsv)
        .join(","),
    ),
  );
  fs.writeFileSync(path.join(outDir, "conflict-classification.csv"), classLines.join("\n") + "\n", "utf8");

  const grpHdr = [
    "normalized_id_signature",
    "row_count",
    "member_source_row_ids",
    "distinct_primary_reasons",
    "max_risk",
    "sample_asin",
    "sample_sku",
  ];
  const grpLines = [grpHdr.join(",")].concat(
    [...bySig.entries()].map(([sig, members]) => {
      const reasons = [...new Set(members.map((m) => m.primary_reason))];
      const risks = members.map((m) => m.risk);
      const maxRisk = risks.includes("critical")
        ? "critical"
        : risks.includes("high")
          ? "high"
          : risks.includes("medium")
            ? "medium"
            : "low";
      return [
        sig,
        members.length,
        members.map((m) => m.id).join(";"),
        reasons.join("|"),
        maxRisk,
        members[0].asin,
        members[0].sku,
      ]
        .map(escCsv)
        .join(",");
    }),
  );
  fs.writeFileSync(path.join(outDir, "grouped-review-pack.csv"), grpLines.join("\n") + "\n", "utf8");

  const ptLines = ["source_row_id,conflict_product_id,product_name,product_sku,product_asin,risk_level"];
  for (const r of rows) {
    for (const pid of r.conflict_product_ids || []) {
      const t = titles.get(pid);
      ptLines.push(
        [
          r.id,
          pid,
          t?.product_name ?? "",
          t?.sku ?? "",
          t?.asin ?? "",
          r.risk,
        ]
          .map(escCsv)
          .join(","),
      );
    }
  }
  fs.writeFileSync(path.join(outDir, "probable-targets.csv"), ptLines.join("\n") + "\n", "utf8");

  const criticalRows = rows.filter((r) => r.risk === "critical");
  const highRows = rows.filter((r) => r.risk === "high");
  const quarantineCandidates = rows.filter(
    (r) => r.category === "dirty_identifier" || r.category === "missing_identifier" || r.category === "lineage_gap",
  );

  fs.writeFileSync(
    path.join(outDir, "unresolved-42-summary.md"),
    `# Unresolved 42 — summary (NEXT-PRODUCT-ID-24)

**Run ID:** \`${runId}\`

## Live counts

| Metric | Value |
|--------|------:|
| Total \`amazon_fba_inventory\` | **${global[0].total}** |
| Resolved (strict) | **${global[0].resolved}** |
| Unresolved (this pack) | **${unresolvedCount}** |

## Classification distribution (review_category)

${Object.entries(byCat)
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `- **${k}:** ${v}`)
  .join("\n")}

## Grouping

- **Distinct normalized identifier signatures:** **${bySig.size}** (see \`grouped-review-pack.csv\`)

## Highest-risk

- **Critical:** ${criticalRows.length} row(s)  
- **High:** ${highRows.length} row(s)

## Quarantine / hold candidates

Rows flagged for **dirty identifier**, **missing identifier**, or **lineage gap:** **${quarantineCandidates.length}** (do not auto-resolve — see \`risk-analysis.md\`).
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "manual-review-actions.md"),
    `# Manual review actions

| review_category | suggested_action pattern |
|-----------------|---------------------------|
| cross_product_conflict | Owner selects canonical \`products.id\`; optional PIM merge; then scoped resolver UPDATE + map alignment |
| duplicate_sku | Reconcile seller SKU vs catalog SKU collision (rename listing or retire duplicate product) |
| identifier_collision_or_fanout | Clean \`product_identifier_map\` duplicates or narrow store scope; re-run dry-run |
| dirty_identifier | Fix upstream SKU/ASIN in source report or exclude row until shape-valid |
| lineage_gap | Restore \`source_upload_id\` → \`raw_report_uploads\` linkage; re-import slice |
| multi_match_ambiguity | Pick single target product; document rationale |
| missing_identifier | Quarantine or enrich identifiers from alternate source |

**No auto-resolve:** all 42 rows require explicit owner or analyst action before any DML.
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "risk-analysis.md"),
    `# Risk analysis

## By risk_level

| Level | Count |
|-------|------:|
| critical | ${rows.filter((r) => r.risk === "critical").length} |
| high | ${rows.filter((r) => r.risk === "high").length} |
| medium | ${rows.filter((r) => r.risk === "medium").length} |
| low | ${rows.filter((r) => r.risk === "low").length} |

## Likely manually resolvable (single dominant product)

Rows with **exactly one** conflict product id: **${rows.filter((r) => r.conflict_count === 1).length}** — still needs human confirm (identifier mismatch vs data error).

## Multi-way conflicts

Rows with **≥3** conflict product ids: **${rows.filter((r) => r.conflict_count >= 3).length}** — highest governance load.

## Quarantine / defer

- **Dirty / missing / lineage:** **${quarantineCandidates.length}** rows — resolve data before resolver writeback.
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "future-ai-review-opportunities.md"),
    `# Future AI review opportunities

Use **only** as advisory after deterministic rules and owner policy — never auto-write.

1. **Cross-product ASIN families** — suggest merge graph from sales velocity + title similarity (high human value, high risk if automated).
2. **SKU token repair** — propose normalized SKU when pattern matches known vendor prefix rules.
3. **Duplicate ASIN within org** — cluster presentation for analyst UI (read-only clustering).

This pack stays **read-only**; any AI integration belongs in a separate governance prompt with redaction and audit logging.
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "next-step-recommendation.md"),
    `# Next-step recommendation

> **NEXT-PRODUCT-ID-25** — Owner triage execution: per-row decision CSV signed off; optional scoped \`UPDATE amazon_fba_inventory\` + \`product_identifier_map\` adjustments **only** for approved PKs; transactional; no broad resolver; no Amazon/OpenAI in execution path.

Pre-work: complete \`conflict-classification.csv\` review with owner column \`approved_action\` / \`target_product_id\`.

Dry-run output for traceability: \`${path.relative(REPO_ROOT, ndPath).replace(/\\/g, "/")}\`.
`,
    "utf8",
  );

  const manifest = {
    auditPrompt: "NEXT-PRODUCT-ID-24",
    runId,
    unresolvedRowCount: unresolvedCount,
    distinctNormalizedSignatures: bySig.size,
    classificationDistribution: byCat,
    dryRunNdjson: path.relative(REPO_ROOT, ndPath).replace(/\\/g, "/"),
    countsMatchExpected42: unresolvedCount === 42,
    validation: {
      noDbWrites: true,
      noResolverUpdates: true,
      noProductCreates: true,
      noMapMutation: true,
      noMigrations: true,
      noAmazonApi: true,
      noOpenAi: true,
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  log("complete", { signatures: bySig.size, unresolvedCount });
  fs.writeFileSync(path.join(outDir, "logs", "product-id-24.ndjson"), logs.join("\n") + "\n", "utf8");

  console.log(outDir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
