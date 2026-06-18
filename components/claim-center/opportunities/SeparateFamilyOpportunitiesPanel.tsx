"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Layers3, Loader2, ShieldAlert, ShieldCheck } from "lucide-react";

import { claimCenterBadgeTone } from "@/components/claim-center/claim-center-ui";
import { useClaimCenter } from "@/components/claim-center/ClaimCenterRootClient";
import type {
  GeneratorFamilySupport,
  SeparateFamilyCandidatePreview,
} from "@/lib/claims/opportunities/separate-family-candidate-generator-contract-v1";

type Payload = {
  mode: "preview" | "execute";
  suggestions_input_count: number;
  candidates: SeparateFamilyCandidatePreview[];
  family_counts: Record<string, number>;
  blockers_by_family: Record<string, Record<string, number>>;
  writeable_count: number;
  unsupported_families: string[];
  generator_support_matrix: GeneratorFamilySupport[];
  removal_pilot_open_gap_total: number | null;
  removal_pilot_claim_count: number;
  approval_status: { approved: boolean; approval_key: string; approval_path: string; block_reason: string | null };
};

function money(v: number | null): string {
  return v == null ? "—" : `$${v.toFixed(2)}`;
}

function CandidateCard({ c }: { c: SeparateFamilyCandidatePreview }) {
  return (
    <div className="rounded-xl border p-3 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-bold leading-tight">{c.family_display_name}</p>
          <p className="font-mono text-[10px] opacity-55">{c.recommended_claim_family}</p>
        </div>
        <span className={claimCenterBadgeTone(c.confidence === "medium" ? "info" : "neutral")}>{c.confidence}</span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] opacity-85">
        <dt className="opacity-55">Source</dt>
        <dd className="text-right font-mono">{c.source_table ?? "—"}</dd>
        <dt className="opacity-55">Source row</dt>
        <dd className="truncate text-right font-mono" title={c.source_row_id ?? ""}>{c.source_row_id ?? "—"}</dd>
        <dt className="opacity-55">Event</dt>
        <dd className="truncate text-right" title={c.event_type_reason ?? ""}>{c.event_type_reason ?? "—"}</dd>
        <dt className="opacity-55">Event date</dt>
        <dd className="text-right tabular-nums">{c.event_date ? c.event_date.slice(0, 10) : "—"}</dd>
        <dt className="opacity-55">Product</dt>
        <dd className="text-right font-mono">{c.product_identity.fnsku ?? c.product_identity.sku ?? c.product_identity.asin ?? "—"}</dd>
        <dt className="opacity-55">Qty</dt>
        <dd className="text-right tabular-nums">{c.quantity ?? "—"}</dd>
        <dt className="opacity-55">Observed amount</dt>
        <dd className="text-right tabular-nums">{money(c.amount)}</dd>
        <dt className="opacity-55">Basis</dt>
        <dd className="text-right">{c.claim_amount_basis}</dd>
        <dt className="opacity-55">Expected claim</dt>
        <dd className="text-right font-bold tabular-nums">{money(c.expected_claim_amount)}</dd>
        <dt className="opacity-55">Reimbursement</dt>
        <dd className="text-right">{c.reimbursement_matching_status}</dd>
      </dl>
      <p className="mt-2 rounded-md bg-black/[0.03] px-2 py-1 text-[10px] leading-snug opacity-70 dark:bg-white/[0.04]">
        {c.separate_from_removal_reason}
      </p>
      {c.blockers.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {c.blockers.map((b) => (
            <span key={b} className={claimCenterBadgeTone("warning")}>{b}</span>
          ))}
        </div>
      ) : (
        <p className="mt-1.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">Writeable (no blockers)</p>
      )}
    </div>
  );
}

export function SeparateFamilyOpportunitiesPanel({ variant }: { variant: "opportunities" | "support" }) {
  const { fetchJson, storeId } = useClaimCenter();
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!storeId) {
      setPayload(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<Payload>("/api/claims/center/separate-family-opportunities");
      setPayload(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load separate-family opportunities.");
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [fetchJson, storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const families = useMemo(() => {
    const groups = new Map<string, SeparateFamilyCandidatePreview[]>();
    for (const c of payload?.candidates ?? []) {
      const arr = groups.get(c.recommended_claim_family) ?? [];
      arr.push(c);
      groups.set(c.recommended_claim_family, arr);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [payload?.candidates]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm opacity-70">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading separate-family opportunities…
      </div>
    );
  }
  if (error) {
    return (
      <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-800 dark:text-red-200">
        {error}
      </p>
    );
  }
  if (!payload) return null;

  if (variant === "support") {
    return (
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide opacity-70">
          <Layers3 className="h-4 w-4" /> Separate-family candidate generator support
        </h2>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-left text-xs">
            <thead className="bg-black/[0.03] dark:bg-white/[0.04]">
              <tr className="text-[11px] uppercase opacity-60">
                <th className="px-3 py-2">Family</th>
                <th className="px-3 py-2">Amount basis</th>
                <th className="px-3 py-2">Required source</th>
                <th className="px-3 py-2">Evidence rule</th>
                <th className="px-3 py-2">Policy</th>
                <th className="px-3 py-2">Preview count</th>
              </tr>
            </thead>
            <tbody>
              {payload.generator_support_matrix.map((s) => (
                <tr key={s.family_key} className="border-t">
                  <td className="px-3 py-2 align-top">
                    <p className="font-semibold leading-tight">{s.display_name}</p>
                    <p className="font-mono text-[10px] opacity-55">{s.family_key}</p>
                  </td>
                  <td className="px-3 py-2 align-top text-[11px]">{s.basis}</td>
                  <td className="px-3 py-2 align-top text-[11px] opacity-80">
                    <p className="font-mono">{s.required_source_table ?? "—"}</p>
                    <p className="opacity-60">{s.required_source_group}</p>
                  </td>
                  <td className="px-3 py-2 align-top text-[11px] opacity-75">{s.evidence_rule}</td>
                  <td className="px-3 py-2 align-top">
                    <span className={claimCenterBadgeTone(s.policy_resolved ? "success" : "warning")}>
                      {s.policy_resolved ? "resolved" : "needs confirmation"}
                    </span>
                  </td>
                  <td className="px-3 py-2 align-top text-right font-bold tabular-nums">
                    {payload.family_counts[s.family_key] ?? 0}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div
        className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-xs ${
          payload.approval_status.approved
            ? "border-emerald-500/30 bg-emerald-500/10"
            : "border-amber-500/30 bg-amber-500/10"
        }`}
      >
        {payload.approval_status.approved ? (
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
        ) : (
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
        )}
        <div>
          <p className="font-semibold">
            Separate claim opportunities by family · {payload.mode.toUpperCase()} mode
            {payload.approval_status.approved ? " · write approved" : " · preview only (no writes)"}
          </p>
          <p className="mt-1 opacity-85">
            {payload.suggestions_input_count} cross-family suggestion(s) → {payload.candidates.length} de-duplicated
            candidate preview(s) · {payload.writeable_count} writeable · removal pilot open gap{" "}
            {money(payload.removal_pilot_open_gap_total)} across {payload.removal_pilot_claim_count} claims (unchanged).
          </p>
          {!payload.approval_status.approved ? (
            <p className="mt-1 font-mono text-[10px] opacity-70">
              To write claim_candidates: set {payload.approval_status.approval_key}=yes in{" "}
              {payload.approval_status.approval_path}
            </p>
          ) : null}
        </div>
      </div>

      {families.length === 0 ? (
        <p className="py-8 text-center text-sm opacity-70">No separate-family opportunities for this store.</p>
      ) : (
        families.map(([family, items]) => (
          <div key={family} className="space-y-2">
            <h3 className="flex items-center gap-2 text-sm font-bold">
              {items[0]?.family_display_name ?? family}
              <span className="text-[11px] font-normal opacity-60">({items.length})</span>
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((c) => (
                <CandidateCard key={c.preview_id} c={c} />
              ))}
            </div>
          </div>
        ))
      )}
    </section>
  );
}
