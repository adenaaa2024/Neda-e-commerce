/**
 * RETURN-ITEMS-FBM-RESOLVER-EXECUTE-V188
 *
 * Apply `set_resolved` proposals from a V183 FBM dry-run (pinned run id).
 * Requires V181 resolver backfill approval on staging.
 *
 *   npx tsx scripts/return-items-fbm-resolver-execute-v188.ts --dry-run-run-id=20260522T140100Z --run-id=<id>
 *   npx tsx scripts/return-items-fbm-resolver-execute-v188.ts --dry-run-run-id=20260522T140100Z --run-id=<id> --execute
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/return-items-fbm-resolver-execute-v188";
const V181_APPROVAL = ".cursor/operator-approvals/return-items-resolver-backfill-v181-approval.md";
const V188_APPROVAL = ".cursor/operator-approvals/return-items-fbm-resolver-execute-v188-approval.md";
const V183_BASE = ".cursor/audit-reports/return-items-fbm-aware-dry-run-v183";
const BD5BF0D6 = "bd5bf0d6-500a-4696-80c6-7c0e65f539b6";

type ProposalRow = {
  return_item_id: string;
  apply_kind: string;
  before: {
    resolved_product_id: string | null;
    resolved_catalog_product_id: string | null;
    identifier_resolution_status: string | null;
    identifier_resolution_confidence: number | null;
  };
  proposed: {
    resolved_product_id: string | null;
    resolved_catalog_product_id: string | null;
    identifier_resolution_status: string | null;
    identifier_resolution_confidence: number | null;
  };
  product_exists: boolean;
  policy_aligns_with_scanner: boolean;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function dryRunRunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--dry-run-run-id="));
  if (!a) throw new Error("--dry-run-run-id=<v183 run_id> required");
  return a.split("=")[1]!.trim();
}

function readV181Approval(): boolean {
  return /APPROVED_TO_RUN_RETURN_ITEMS_RESOLVER_BACKFILL_STAGING\s*=\s*true/i.test(
    fs.readFileSync(path.join(process.cwd(), V181_APPROVAL), "utf8"),
  );
}

function readV188Approval(): boolean {
  const p = path.join(process.cwd(), V188_APPROVAL);
  if (!fs.existsSync(p)) return false;
  return /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(fs.readFileSync(p, "utf8"));
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function n(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const dryRunRunId = dryRunRunIdArg();
  const execute = process.argv.includes("--execute");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const stagingRef = getStagingProjectRef({ loadEnv: false });
  if (!dbUrl || stagingRef !== STAGING_REF || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    throw new Error(`Staging guard failed (expected ${STAGING_REF})`);
  }

  const proposalPath = path.join(process.cwd(), V183_BASE, dryRunRunId, "proposal-rows.json");
  if (!fs.existsSync(proposalPath)) {
    throw new Error(`Missing dry-run proposals: ${proposalPath}`);
  }
  const allProposals = JSON.parse(fs.readFileSync(proposalPath, "utf8")) as ProposalRow[];
  const toApply = allProposals.filter((p) => p.apply_kind === "set_resolved");

  if (toApply.length === 0) {
    throw new Error("No set_resolved proposals in pinned dry-run");
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const liveRows = await client.query(
    `SELECT id::text, organization_id::text, store_id::text, sku, fnsku, asin,
            resolved_product_id::text, resolved_catalog_product_id::text,
            identifier_resolution_status, identifier_resolution_confidence::text, deleted_at
     FROM public.return_items WHERE id = ANY($1::uuid[])`,
    [toApply.map((p) => p.return_item_id)],
  );
  const liveById = new Map(liveRows.rows.map((r: { id: string }) => [r.id, r]));

  const preimageHeaders = [
    "id",
    "sku",
    "fnsku",
    "asin",
    "resolved_product_id",
    "resolved_catalog_product_id",
    "identifier_resolution_status",
    "identifier_resolution_confidence",
    "deleted_at",
  ];
  const csvLines = [preimageHeaders.join(",")];
  for (const p of toApply) {
    const live = liveById.get(p.return_item_id) as Record<string, unknown> | undefined;
    if (!live) throw new Error(`return_item ${p.return_item_id} not found`);
    csvLines.push(preimageHeaders.map((h) => csvEscape(live[h])).join(","));
  }
  fs.writeFileSync(path.join(outDir, "preimage-return-items.csv"), csvLines.join("\n"), "utf8");

  const bd5Preimage = liveById.get(BD5BF0D6);
  if (bd5Preimage) {
    fs.writeFileSync(path.join(outDir, "preimage-bd5bf0d6.json"), JSON.stringify(bd5Preimage, null, 2));
  }

  const verification: Array<Record<string, unknown>> = [];
  for (const p of toApply) {
    const live = liveById.get(p.return_item_id) as Record<string, unknown>;
    const blockers: string[] = [];
    const alreadyApplied =
      n(live.resolved_product_id) === n(p.proposed.resolved_product_id) &&
      n(live.identifier_resolution_status) === n(p.proposed.identifier_resolution_status) &&
      num(live.identifier_resolution_confidence) === (p.proposed.identifier_resolution_confidence ?? null);

    if (live.deleted_at != null) blockers.push("row_deleted");
    if (!p.product_exists) blockers.push("product_missing_in_dry_run");
    if (!p.policy_aligns_with_scanner) blockers.push("scanner_policy_misaligned");
    if (!alreadyApplied && n(live.resolved_product_id) !== n(p.before.resolved_product_id)) {
      blockers.push("before_resolved_product_id_drift");
    }
    if (!alreadyApplied && n(live.identifier_resolution_status) !== n(p.before.identifier_resolution_status)) {
      blockers.push("before_status_drift");
    }
    if (!p.proposed.resolved_product_id) blockers.push("no_proposed_product_id");

    const prod = await client.query(`SELECT 1 FROM public.products WHERE id = $1::uuid AND deleted_at IS NULL`, [
      p.proposed.resolved_product_id,
    ]);
    if ((prod.rowCount ?? 0) === 0) blockers.push("proposed_product_not_in_db");

    verification.push({
      return_item_id: p.return_item_id,
      apply_kind: p.apply_kind,
      proposed_product_id: p.proposed.resolved_product_id,
      already_applied: alreadyApplied,
      blockers,
      ok: alreadyApplied || blockers.length === 0,
    });
  }
  fs.writeFileSync(path.join(outDir, "verification.json"), JSON.stringify(verification, null, 2));

  const blocked = verification.filter((v) => !v.ok);
  if (blocked.length > 0 && execute) {
    throw new Error(`Execute blocked: ${JSON.stringify(blocked)}`);
  }

  if (!execute) {
    fs.writeFileSync(
      path.join(outDir, "plan-summary.md"),
      [
        "# FBM resolver execute V188 — plan",
        "",
        `- dry-run source: \`${dryRunRunId}\``,
        `- set_resolved count: **${toApply.length}**`,
        `- ids: ${toApply.map((p) => `\`${p.return_item_id}\``).join(", ")}`,
        `- V181 approval: **${readV181Approval()}**`,
        `- V188 approval: **${readV188Approval()}**`,
        "",
        "Run with `--execute` when approvals are true.",
      ].join("\n"),
    );
    await client.end();
    console.log(JSON.stringify({ mode: "plan", set_resolved: toApply.length, verification }, null, 2));
    return;
  }

  if (!readV181Approval()) {
    throw new Error(`V181 approval required: ${V181_APPROVAL}`);
  }
  if (!readV188Approval()) {
    throw new Error(`V188 approval required: set APPROVED_TO_RUN_STAGING=true in ${V188_APPROVAL}`);
  }

  const alreadyDone = verification.filter((v) => v.already_applied);
  if (alreadyDone.length === toApply.length) {
    const postBd5 = (
      await client.query(
        `SELECT id::text, resolved_product_id::text, identifier_resolution_status,
                identifier_resolution_confidence::text, asin
         FROM public.return_items WHERE id = $1::uuid`,
        [BD5BF0D6],
      )
    ).rows[0];
    const manifest = {
      prompt: "RETURN-ITEMS-FBM-RESOLVER-EXECUTE-V188",
      run_id: runId,
      staging_ref: STAGING_REF,
      dry_run_run_id: dryRunRunId,
      mode: "execute_idempotent_skip",
      set_resolved_planned: toApply.length,
      applied: 0,
      note: "All proposals already applied on staging",
      bd5bf0d6_post: postBd5,
    };
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(
      path.join(outDir, "execute-summary.md"),
      [
        "# FBM resolver execute V188 — idempotent",
        "",
        "bd5bf0d6 already has proposed resolver state; no UPDATE issued.",
        "",
        `Prior execute: \`20260522T150000Z\``,
      ].join("\n"),
    );
    await client.end();
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  let applied = 0;
  const appliedIds: string[] = [];
  for (const p of toApply) {
    const ver = verification.find((v) => v.return_item_id === p.return_item_id);
    if (ver?.already_applied) continue;
    const r = await client.query(
      `UPDATE public.return_items t
       SET resolved_product_id = $2::uuid,
           resolved_catalog_product_id = $3::uuid,
           identifier_resolution_status = $4,
           identifier_resolution_confidence = $5,
           updated_at = now()
       FROM public.products pr
       WHERE t.id = $1::uuid
         AND t.deleted_at IS NULL
         AND pr.id = $2::uuid
       RETURNING t.id::text`,
      [
        p.return_item_id,
        p.proposed.resolved_product_id,
        p.proposed.resolved_catalog_product_id,
        p.proposed.identifier_resolution_status,
        p.proposed.identifier_resolution_confidence,
      ],
    );
    if ((r.rowCount ?? 0) === 1) {
      applied += 1;
      appliedIds.push(p.return_item_id);
    }
  }

  const postBd5 = (
    await client.query(
      `SELECT id::text, resolved_product_id::text, identifier_resolution_status,
              identifier_resolution_confidence::text
       FROM public.return_items WHERE id = $1::uuid`,
      [BD5BF0D6],
    )
  ).rows[0];

  const rollbackSql = toApply
    .map((p) => {
      const rp = p.before.resolved_product_id == null ? "NULL" : `'${p.before.resolved_product_id}'::uuid`;
      const rc =
        p.before.resolved_catalog_product_id == null ? "NULL" : `'${p.before.resolved_catalog_product_id}'::uuid`;
      const st =
        p.before.identifier_resolution_status == null
          ? "NULL"
          : `'${p.before.identifier_resolution_status}'`;
      const conf =
        p.before.identifier_resolution_confidence == null
          ? "NULL"
          : String(p.before.identifier_resolution_confidence);
      return `UPDATE public.return_items SET resolved_product_id=${rp}, resolved_catalog_product_id=${rc}, identifier_resolution_status=${st}, identifier_resolution_confidence=${conf}, updated_at=now() WHERE id='${p.return_item_id}'::uuid;`;
    })
    .join("\n");

  fs.writeFileSync(path.join(outDir, "rollback.sql"), `-- V188 rollback\n${rollbackSql}\n`);

  const manifest = {
    prompt: "RETURN-ITEMS-FBM-RESOLVER-EXECUTE-V188",
    run_id: runId,
    staging_ref: STAGING_REF,
    dry_run_run_id: dryRunRunId,
    mode: "execute",
    set_resolved_planned: toApply.length,
    applied,
    applied_ids: appliedIds,
    bd5bf0d6_post: postBd5,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "execute-summary.md"),
    [
      "# FBM resolver execute V188",
      "",
      `- Applied **${applied}** / ${toApply.length} set_resolved proposals`,
      `- Source dry-run: \`${dryRunRunId}\``,
      `- bd5bf0d6 resolved_product_id: \`${postBd5?.resolved_product_id ?? "n/a"}\``,
      `- Preimage: \`preimage-return-items.csv\`, \`preimage-bd5bf0d6.json\``,
    ].join("\n"),
  );

  await client.end();
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
