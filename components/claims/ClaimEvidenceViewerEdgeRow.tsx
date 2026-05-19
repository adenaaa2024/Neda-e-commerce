"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";

import { EDGE_TYPE_LABELS, type ClaimEvidencePreviewEdge } from "@/lib/claim-evidence-preview";
import {
  formatLinkageConfidence,
  resolutionStatusBadgeClass,
  resolutionStatusLabel,
} from "@/lib/scanner-product-linkage-ui";

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function EdgeRow({ edge, organizationId }: { edge: ClaimEvidencePreviewEdge; organizationId: string }) {
  const typeLabel = EDGE_TYPE_LABELS[edge.edge_type] ?? edge.edge_type;
  const refLabel =
    edge.reference_kind === "internal_trid_key"
      ? `TRID ${edge.reference_value ?? "—"}`
      : edge.reference_value
        ? `${edge.reference_kind ?? "ref"}: ${edge.reference_value}`
        : null;
  const productId =
    edge.edge_type === "slip_line_to_product" && edge.to_source_row_id !== "unresolved"
      ? edge.to_source_row_id
      : null;
  const resStatus = edge.reference_kind === "identifier_resolution_status" ? edge.reference_value : null;

  return (
    <div className="rounded-md border border-slate-200/80 bg-white px-2 py-1.5 dark:border-slate-700 dark:bg-slate-950/40">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="font-medium text-slate-800 dark:text-slate-100">{typeLabel}</span>
        <span className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {edge.to_source_table}
        </span>
        <span className="text-slate-500">conf {pct(edge.confidence_score)}</span>
        {edge.ambiguity_group_key ? (
          <span className="rounded border border-violet-300/60 bg-violet-50 px-1 text-[10px] text-violet-800 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-200">
            ambiguous #{edge.ambiguity_rank ?? "?"}
          </span>
        ) : null}
      </div>
      {refLabel ? <p className="mt-0.5 font-mono text-[10px] text-sky-700 dark:text-sky-300">{refLabel}</p> : null}
      {resStatus ? (
        <span
          className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${resolutionStatusBadgeClass(resStatus)}`}
        >
          {resolutionStatusLabel(resStatus)}
          {edge.confidence_score != null ? ` · ${formatLinkageConfidence(edge.confidence_score)}` : null}
        </span>
      ) : null}
      {productId ? (
        <Link
          href={`/dashboard/products?organization_id=${encodeURIComponent(organizationId)}&highlight=${encodeURIComponent(productId)}`}
          className="mt-1 inline-flex items-center gap-0.5 text-[10px] font-medium text-sky-600 hover:underline dark:text-sky-400"
        >
          Product {productId.slice(0, 8)}…
          <ExternalLink className="h-3 w-3" />
        </Link>
      ) : null}
      <p className="mt-1 text-[10px] text-muted-foreground">{edge.edge_reason}</p>
    </div>
  );
}
