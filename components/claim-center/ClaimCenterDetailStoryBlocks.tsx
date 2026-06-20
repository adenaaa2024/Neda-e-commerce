"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Calendar,
  ChevronRight,
  FileSearch,
  Lock,
  Package,
  Scale,
  Shield,
  Zap,
} from "lucide-react";

import type { ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";
import {
  claimCenterEvidenceGapSummary,
  claimCenterEventSummary,
  claimCenterMissingNextSummary,
  claimCenterMoneyStatusSummary,
  claimCenterPhysicalEventLabel,
  claimCenterPolicyEligibilitySummary,
  claimCenterReferenceStatusSummary,
  claimCenterSourceTypeLabel,
  formatClaimCenterMoney,
  resolveClaimCenterNextStep,
} from "@/lib/claims/center/claim-center-detail-story";
import { ClaimCenterTwinSourceChips } from "./ClaimCenterTwinSourceChips";
import {
  isSafeForProductStory,
  productLinkageQueueHref,
} from "@/lib/claims/center/claim-center-ui-copy";

import { ProductLinkageDisplayBlock } from "@/components/product-linkage/ProductLinkageDisplayBlock";

import { ClaimCenterBridgePhaseNotice } from "./ClaimCenterBridgePhaseNotice";
import { claimCenterBadgeTone } from "./claim-center-ui";
import { OrbitFraCarryForwardBanner } from "./OrbitFraCarryForwardBanner";
import { TridReferenceGraphPanel } from "./TridReferenceGraphPanel";

function DetailStoryBlock({
  index,
  title,
  icon,
  children,
  className = "",
  variant,
}: {
  index: number;
  title: string;
  icon: ReactNode;
  children: ReactNode;
  className?: string;
  variant: "desktop" | "mobile";
}) {
  return (
    <section
      className={`claim-center-card rounded-xl ${variant === "mobile" ? "p-4" : "p-4 lg:p-5"} ${className}`}
      aria-labelledby={`detail-block-${index}`}
    >
      <div className="mb-3 flex items-center gap-2 border-b pb-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-black/5 text-xs font-bold dark:bg-white/10">
          {index}
        </span>
        <span className="opacity-60">{icon}</span>
        <h3 id={`detail-block-${index}`} className="text-sm font-semibold">
          {title}
        </h3>
      </div>
      {children}
    </section>
  );
}

function FieldGrid({ children }: { children: ReactNode }) {
  return <dl className="grid gap-3 text-sm sm:grid-cols-2">{children}</dl>;
}

function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide opacity-55">{label}</dt>
      <dd className={`mt-0.5 font-medium ${mono ? "font-mono text-xs break-all" : ""}`}>{value}</dd>
    </div>
  );
}

export function ClaimCenterDetailStickyHeader({ row }: { row: ClaimCenterV1Row }) {
  const windowTone =
    row.canonical_window.status === "expired"
      ? "danger"
      : row.canonical_window.status === "closing_soon"
        ? "warning"
        : "neutral";

  return (
    <div className="sticky top-0 z-10 -mx-1 mb-4 rounded-xl border border-black/10 bg-inherit/95 px-4 py-3 backdrop-blur-sm dark:border-white/10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide opacity-60">Opportunity summary</p>
          <p className="truncate text-lg font-bold">{row.v1_status_label}</p>
          <p className="mt-0.5 text-xs opacity-70">{claimCenterEventSummary(row)}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-xs opacity-60">Exposure</p>
          <p className="text-xl font-bold tabular-nums">{formatClaimCenterMoney(row)}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className={claimCenterBadgeTone(windowTone)}>
          <Calendar className="mr-1 inline h-3 w-3" />
          {row.canonical_window.deadline ?? "No deadline"}
          {row.canonical_window.days_remaining != null ? ` · ${row.canonical_window.days_remaining}d` : ""}
        </span>
        {row.badges.slice(0, 5).map((b, i) => (
          <span key={`${b.kind}-${i}`} className={claimCenterBadgeTone(b.tone)}>
            {b.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function EventBlock({ row, variant }: { row: ClaimCenterV1Row; variant: "desktop" | "mobile" }) {
  return (
    <DetailStoryBlock index={1} title="Event" icon={<Zap className="h-4 w-4" />} variant={variant}>
      <p className="mb-3 text-xs leading-relaxed opacity-75">What happened — warehouse physical return context.</p>
      {row.source_kind === "orbit_fra" ? <OrbitFraCarryForwardBanner row={row} /> : null}
      <ClaimCenterTwinSourceChips row={row} className="mb-3" />
      <FieldGrid>
        <Field label="Physical event" value={claimCenterPhysicalEventLabel(row)} />
        <Field
          label="Claim type"
          value={row.physical_return_display?.physical_family_label ?? row.claim_family?.replace(/_/g, " ") ?? "—"}
        />
        <Field label="Source type" value={claimCenterSourceTypeLabel(row)} />
        <Field label="Event date" value={row.event_date ?? row.created_at ?? "—"} />
        <Field label="Money status" value={claimCenterMoneyStatusSummary(row)} />
        <Field label="Expected recovery" value={formatClaimCenterMoney(row)} />
        <Field label="Filing deadline" value={row.canonical_window.deadline ?? "—"} />
        <Field label="Lifecycle" value={row.lifecycle_status_label ?? row.v1_status_label} />
        <Field label="Claim reason" value={row.claim_reason ?? "—"} />
      </FieldGrid>
    </DetailStoryBlock>
  );
}

function ProductBlock({ row, variant }: { row: ClaimCenterV1Row; variant: "desktop" | "mobile" }) {
  const linked = row.product_linkage?.is_resolved;
  const safeStory = isSafeForProductStory(row);

  return (
    <DetailStoryBlock index={2} title="Product" icon={<Package className="h-4 w-4" />} variant={variant}>
      <p className="mb-3 text-xs leading-relaxed opacity-75">
        Catalog linkage state — read-only. No product writes from Claim Center.
      </p>
      {!linked ? (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p>
            <strong>Product not matched.</strong>{" "}
            {row.product_unresolved_reason ?? "Resolve catalog linkage before trusting cost or sale price context."}
          </p>
        </div>
      ) : null}
      <FieldGrid>
        <Field label="Link state" value={linked ? "Resolved" : "Unresolved"} />
        <Field label="SKU" value={row.sku ?? "—"} mono />
        <Field label="ASIN" value={row.asin ?? "—"} mono />
        <Field label="FNSKU" value={row.fnsku ?? "—"} mono />
      </FieldGrid>
      {row.product_linkage ? (
        <div className="mt-3">
          <ProductLinkageDisplayBlock linkage={row.product_linkage} compact />
        </div>
      ) : null}
      <div className="mt-3">
        {safeStory && row.product_story_href ? (
          <Link
            href={row.product_story_href}
            className="inline-flex min-h-[44px] items-center gap-1 text-sm font-medium underline opacity-90"
          >
            Open product in catalog <ChevronRight className="h-4 w-4" />
          </Link>
        ) : (
          <Link
            href={productLinkageQueueHref(row)}
            className="inline-flex min-h-[44px] items-center gap-1 text-sm font-medium underline opacity-90"
          >
            Open Product Match queue <ChevronRight className="h-4 w-4" />
          </Link>
        )}
      </div>
    </DetailStoryBlock>
  );
}

function EvidenceBlock({ row, variant }: { row: ClaimCenterV1Row; variant: "desktop" | "mobile" }) {
  const status = (row.evidence_status ?? "unknown").replace(/_/g, " ");

  return (
    <DetailStoryBlock index={3} title="Evidence" icon={<FileSearch className="h-4 w-4" />} variant={variant}>
      <p className="mb-3 text-xs leading-relaxed opacity-75">
        Evidence completeness and gaps — preview-only. No PDF generation or submission from Claim Center V1.
      </p>
      <FieldGrid>
        <Field
          label="Proof status"
          value={row.evidence_status === "missing" ? "Proof missing" : <span className="capitalize">{status}</span>}
        />
        <Field label="Gap summary" value={claimCenterEvidenceGapSummary(row)} />
      </FieldGrid>
      {row.orbit_evidence_summary ? (
        <p className="mt-3 rounded-lg bg-black/5 px-3 py-2 text-xs dark:bg-white/5">
          <span className="font-semibold">ORBIT report source:</span> {row.orbit_evidence_summary}
        </p>
      ) : null}
      <p className="mt-3 text-xs opacity-60">
        Photos, operator notes, and report imports are summarized here. Use Claim Engine for full evidence graph after
        the write bridge opens.
      </p>
    </DetailStoryBlock>
  );
}

function ReferenceBlock({
  row,
  variant,
  organizationId,
}: {
  row: ClaimCenterV1Row;
  variant: "desktop" | "mobile";
  organizationId: string;
}) {
  return (
    <DetailStoryBlock index={4} title="Reference story &amp; product TRID" icon={<Shield className="h-4 w-4" />} variant={variant}>
      <p className="mb-3 text-xs leading-relaxed opacity-75">
        Amazon reference IDs, TRID timeline (SC proof vs internal), and reference story — why this candidate exists,
        what references support it, what is missing, and whether it can become a claim. No writes.
      </p>
      <FieldGrid>
        <Field label="TRID status" value={claimCenterReferenceStatusSummary(row)} />
        <Field label="Primary Amazon ref" value={row.amazon_reference_id ?? "—"} mono />
        <Field label="Reference ID" value={row.reference_id ?? "—"} mono />
        <Field label="Reference type" value={row.reference_type ?? "—"} />
        <Field
          label="Edge count"
          value={`${row.reference_edge_count} materialized${row.ambiguity_pending ? " · ambiguity pending" : ""}`}
        />
      </FieldGrid>
      <div className="mt-3 [&_.claim-center-card]:mb-0 [&_.claim-center-card]:border-0 [&_.claim-center-card]:bg-transparent [&_.claim-center-card]:p-0">
        <TridReferenceGraphPanel row={row} organizationId={organizationId} embedded />
      </div>
    </DetailStoryBlock>
  );
}

function PolicyBlock({ row, variant }: { row: ClaimCenterV1Row; variant: "desktop" | "mobile" }) {
  return (
    <DetailStoryBlock index={5} title="Rules used" icon={<Scale className="h-4 w-4" />} variant={variant}>
      <p className="mb-3 text-xs leading-relaxed opacity-75">
        Effective rules applied to this opportunity (read-only). Full reference is available from admin utilities.
      </p>
      {row.orbit_external_case_status ? (
        <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
          <p className="font-semibold">External / imported status</p>
          <p className="mt-1 opacity-90">
            Observed status <strong>{row.orbit_external_case_status}</strong> — not Menorix filing state.
          </p>
        </div>
      ) : null}
      <FieldGrid>
        <Field label="Policy status" value={row.eligibility_display?.label ?? row.canonical_window.status.replace(/_/g, " ")} />
        <Field label="Deadline" value={row.canonical_window.deadline ?? "—"} />
        <Field label="Eligibility detail" value={claimCenterPolicyEligibilitySummary(row)} />
        <Field label="Automation" value={row.automation_allowed ? "Allowed" : "Not allowed"} />
      </FieldGrid>
    </DetailStoryBlock>
  );
}

function NextStepBlock({ row, variant }: { row: ClaimCenterV1Row; variant: "desktop" | "mobile" }) {
  const step = resolveClaimCenterNextStep(row);

  return (
    <DetailStoryBlock index={6} title="Next step" icon={<Lock className="h-4 w-4" />} variant={variant}>
      <p className="mb-3 text-sm font-semibold">{step.headline}</p>
      <p className="mb-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs">
        <span className="font-semibold">What is missing next: </span>
        {claimCenterMissingNextSummary(row)}
      </p>
      <div className="space-y-3 text-xs leading-relaxed">
        <div className="rounded-lg bg-emerald-500/10 px-3 py-2">
          <p className="font-semibold text-emerald-900 dark:text-emerald-100">What you can review now</p>
          <p className="mt-1 opacity-90">{step.reviewNow}</p>
        </div>
        <div className="rounded-lg border border-slate-500/25 bg-slate-500/10 px-3 py-2">
          <p className="font-semibold">Locked for now</p>
          <p className="mt-1 opacity-90">{step.lockedActions}</p>
        </div>
        <div className="rounded-lg bg-black/[0.03] px-3 py-2 dark:bg-white/[0.04]">
          <p className="font-semibold">After the filing bridge</p>
          <p className="mt-1 opacity-85">{step.afterBridge}</p>
        </div>
      </div>
      {step.safeHref && step.safeLabel ? (
        <div className="mt-4">
          <Link
            href={step.safeHref}
            className="inline-flex min-h-[44px] w-full items-center justify-center rounded-xl border px-4 text-sm font-medium opacity-90 hover:opacity-100"
          >
            {step.safeLabel}
          </Link>
        </div>
      ) : null}
      <p className="mt-3 text-[11px] opacity-55">
        Legacy workflows (Claim Engine, returns pool) are in the <strong>Legacy tools</strong> menu only — not primary
        actions on this screen.
      </p>
      {variant === "mobile" ? (
        <div className="mt-3">
          <ClaimCenterBridgePhaseNotice compact />
        </div>
      ) : null}
    </DetailStoryBlock>
  );
}

export function ClaimCenterDetailStory({
  row,
  variant,
}: {
  row: ClaimCenterV1Row;
  variant: "desktop" | "mobile";
}) {
  const blocks = (
    <>
      <EventBlock row={row} variant={variant} />
      <ProductBlock row={row} variant={variant} />
      <EvidenceBlock row={row} variant={variant} />
      <ReferenceBlock row={row} variant={variant} organizationId={row.organization_id} />
      <PolicyBlock row={row} variant={variant} />
      <NextStepBlock row={row} variant={variant} />
    </>
  );

  if (variant === "mobile") {
    return (
      <div className="space-y-4">
        <ClaimCenterDetailStickyHeader row={row} />
        {blocks}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ClaimCenterDetailStickyHeader row={row} />
      <div className="grid gap-4 xl:grid-cols-2">
        <EventBlock row={row} variant={variant} />
        <ProductBlock row={row} variant={variant} />
        <EvidenceBlock row={row} variant={variant} />
        <ReferenceBlock row={row} variant={variant} organizationId={row.organization_id} />
        <div className="xl:col-span-2">
          <PolicyBlock row={row} variant={variant} />
        </div>
        <div className="xl:col-span-2">
          <NextStepBlock row={row} variant={variant} />
        </div>
      </div>
    </div>
  );
}
