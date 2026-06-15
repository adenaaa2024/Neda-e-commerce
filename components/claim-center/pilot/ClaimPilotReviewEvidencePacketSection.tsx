"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Loader2, ShieldAlert } from "lucide-react";

import type { ClaimEvidencePacketV1, ClaimEvidencePacketV1Payload } from "@/lib/claims/evidence/claim-evidence-packet-v1";
import {
  EVIDENCE_PACKET_API_PATH,
  EVIDENCE_PACKET_READINESS_BADGE_LABELS,
  deriveEvidencePacketReadinessBadge,
  evidencePacketApiParams,
  productIdentityLabel,
  type EvidencePacketReadinessBadge,
} from "@/lib/claims/pilot/claim-evidence-packet-ui-contract";
import { formatPilotMoney } from "@/lib/claims/pilot/claim-pilot-review-ui-contract";

type Props = {
  candidateId: string;
  intakeRunId: string | null;
  fetchJson: <T>(path: string, extra?: Record<string, string>) => Promise<T>;
};

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-55">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium break-words">{value}</dd>
    </div>
  );
}

function badgeStyles(badge: EvidencePacketReadinessBadge): string {
  switch (badge) {
    case "ready_for_case_planning":
      return "bg-emerald-500/15 text-emerald-900 dark:text-emerald-100 border-emerald-500/30";
    case "needs_evidence_review":
      return "bg-amber-500/15 text-amber-900 dark:text-amber-100 border-amber-500/30";
    case "blocked":
      return "bg-red-500/15 text-red-900 dark:text-red-100 border-red-500/30";
  }
}

function BadgeIcon({ badge }: { badge: EvidencePacketReadinessBadge }) {
  if (badge === "ready_for_case_planning") return <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />;
  if (badge === "needs_evidence_review") return <AlertTriangle className="h-3.5 w-3.5" aria-hidden />;
  return <ShieldAlert className="h-3.5 w-3.5" aria-hidden />;
}

function EvidencePacketContent({ packet }: { packet: ClaimEvidencePacketV1 }) {
  const badge = deriveEvidencePacketReadinessBadge(packet);
  const money = packet.money_lanes;

  return (
    <div className="space-y-4">
      <div
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${badgeStyles(badge)}`}
      >
        <BadgeIcon badge={badge} />
        {EVIDENCE_PACKET_READINESS_BADGE_LABELS[badge]}
      </div>

      <dl className="grid gap-3 sm:grid-cols-2">
        <Field label="Candidate ID" value={<span className="font-mono text-xs break-all">{packet.candidate_id}</span>} />
        <Field label="Packet ID" value={<span className="font-mono text-xs break-all">{packet.packet_id}</span>} />
        <Field label="Family V3" value={packet.family_key_v3 ?? "—"} />
        <Field label="Claim family" value={packet.claim_family ?? "—"} />
        <Field label="Source kind" value={packet.source_kind ?? "—"} />
        <Field
          label="Source event key"
          value={<span className="font-mono text-xs break-all">{packet.source_event_key ?? "—"}</span>}
        />
      </dl>

      <div>
        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">Product identity</h4>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Field label="Identifiers" value={productIdentityLabel(packet.product_identity)} />
          <Field label="Title" value={packet.product_identity.title ?? "—"} />
          <Field label="Linkage" value={packet.product_identity.linkage_status} />
        </dl>
      </div>

      <dl className="grid gap-3 sm:grid-cols-2">
        <Field label="Clean quantity" value={packet.quantity.clean_quantity ?? "—"} />
        <Field label="Quantity source" value={packet.quantity.quantity_source} />
        <Field label="Source event date" value={packet.date_gate.source_event_date ?? "—"} />
        <Field label="Effective date source" value={packet.date_gate.effective_date_source ?? "—"} />
        <Field label="Effective date value" value={packet.date_gate.effective_date_value ?? "—"} />
        <Field label="Date gate passed" value={packet.date_gate.date_gate_passed ? "Yes" : "No"} />
      </dl>

      <div>
        <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-55">Evidence summary</dt>
        <dd className="mt-1 rounded-lg bg-black/5 p-3 text-xs dark:bg-white/5">
          {packet.evidence_summary ?? "—"}
        </dd>
      </div>

      <div>
        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">
          Source row pointers ({packet.source_edges.length})
        </h4>
        {packet.source_edges.length === 0 ? (
          <p className="text-xs opacity-60">No source edges.</p>
        ) : (
          <ul className="space-y-2">
            {packet.source_edges.map((e, i) => (
              <li key={`${e.kind}-${e.table}-${e.row_id}-${i}`} className="rounded-lg bg-black/5 px-3 py-2 text-xs dark:bg-white/5">
                <span className="font-semibold">{e.kind}</span>
                <span className="mx-1 opacity-40">·</span>
                <span className="font-mono break-all">{e.table}:{e.row_id}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">
          Reference / TRID edges ({packet.reference_edges.length})
        </h4>
        {packet.reference_edges.length === 0 ? (
          <p className="text-xs opacity-60">No reference edges.</p>
        ) : (
          <ul className="space-y-2">
            {packet.reference_edges.map((e, i) => (
              <li
                key={`${e.reference_kind}-${e.reference_value}-${i}`}
                className="rounded-lg bg-black/5 px-3 py-2 text-xs dark:bg-white/5"
              >
                <span className="font-semibold">{e.reference_kind}</span>
                {e.edge_type ? (
                  <>
                    <span className="mx-1 opacity-40">·</span>
                    <span className="opacity-70">{e.edge_type}</span>
                  </>
                ) : null}
                <span className="mx-1 opacity-40">·</span>
                <span className="font-mono break-all">{e.reference_value}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-55">
          Evidence pointers ({packet.evidence_pointers.length})
        </dt>
        <pre className="mt-1 max-h-32 overflow-auto rounded-lg bg-black/5 p-3 text-[10px] dark:bg-white/5">
          {JSON.stringify(packet.evidence_pointers, null, 2)}
        </pre>
      </div>

      <div>
        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">Money lanes</h4>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Estimated Amazon payout"
            value={formatPilotMoney(money.estimated_amazon_payout, money.currency)}
          />
          <Field
            label="Observed reimbursement"
            value={formatPilotMoney(money.observed_reimbursement, money.currency)}
          />
          <Field
            label="Internal cost loss"
            value={formatPilotMoney(money.internal_cost_loss, money.currency)}
          />
          <Field label="Recovery value" value={formatPilotMoney(money.recovery_value, money.currency)} />
          <Field label="Expected amount" value={formatPilotMoney(money.expected_amount, money.currency)} />
          <Field
            label="Sale price (display only)"
            value={formatPilotMoney(money.sale_price_display_only, money.currency)}
          />
        </dl>
      </div>

      {packet.review_flags.length > 0 ? (
        <div>
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">Warnings</h4>
          <div className="flex flex-wrap gap-2">
            {packet.review_flags.map((f) => (
              <span
                key={f}
                className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-200"
              >
                {f}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {packet.blocker_flags.length > 0 ? (
        <div>
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">Blockers</h4>
          <div className="flex flex-wrap gap-2">
            {packet.blocker_flags.map((f) => (
              <span
                key={f}
                className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-800 dark:text-red-200"
              >
                {f}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <Field
        label="Ready for case creation"
        value={packet.readiness.ready_for_case_creation === "yes" ? "Yes" : "No"}
      />
    </div>
  );
}

export function ClaimPilotReviewEvidencePacketSection({ candidateId, intakeRunId, fetchJson }: Props) {
  const [packet, setPacket] = useState<ClaimEvidencePacketV1 | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPacket = useCallback(async () => {
    if (!candidateId) return;
    setLoading(true);
    setError(null);
    setPacket(null);
    try {
      const data = await fetchJson<ClaimEvidencePacketV1Payload>(
        EVIDENCE_PACKET_API_PATH,
        evidencePacketApiParams(candidateId, intakeRunId),
      );
      const found = data.packets?.[0] ?? null;
      if (!found) {
        setError("No evidence packet composed for this candidate.");
        return;
      }
      setPacket(found);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load evidence packet.");
    } finally {
      setLoading(false);
    }
  }, [candidateId, intakeRunId, fetchJson]);

  useEffect(() => {
    void loadPacket();
  }, [loadPacket]);

  return (
    <section className="rounded-xl border border-sky-500/20 bg-sky-500/5 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase opacity-70">Evidence packet</h3>
        <span className="text-[10px] opacity-50">read-only · no PDF</span>
      </div>
      <p className="mb-4 text-[11px] opacity-70">
        Composed via <code className="text-[10px]">{EVIDENCE_PACKET_API_PATH}</code>. Inspect readiness before case
        planning — no writes.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-xs opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading evidence packet…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-4 text-xs">
          <p className="font-semibold text-red-800 dark:text-red-200">Could not load evidence packet</p>
          <p className="mt-1 opacity-80">{error}</p>
          <button
            type="button"
            onClick={() => void loadPacket()}
            className="mt-3 rounded-lg border px-2 py-1 text-[10px] font-semibold opacity-80 hover:opacity-100"
          >
            Retry
          </button>
        </div>
      ) : packet ? (
        <EvidencePacketContent packet={packet} />
      ) : (
        <p className="py-4 text-xs opacity-60">No evidence packet available for this candidate.</p>
      )}
    </section>
  );
}
