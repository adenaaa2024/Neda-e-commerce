"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Info, Loader2, Save } from "lucide-react";

import {
  CLAIM_CANDIDATE_TRIGGERS,
  CLAIMABLE_PHYSICAL_EVENTS,
  type ClaimCandidateIntakePolicy,
  type ClaimCandidateTrigger,
  type ClaimablePhysicalEvent,
} from "@/lib/claim-candidate-intake-policy";
import {
  CLAIM_CANDIDATE_TRIGGER_LABELS,
  CLAIMABLE_PHYSICAL_EVENT_LABELS,
  candidateIntakePolicyEqual,
} from "@/lib/claim-candidate-intake-policy-resolution";
import {
  CLAIM_SOURCE_KINDS,
  type ClaimIntakeSettings,
  type ClaimSourceKind,
} from "@/lib/claims/intake/claim-intake-types";
import { responsiveFormInput } from "@/lib/responsive-page-shell";
import {
  clearStoreClaimCandidateIntakePolicyAction,
  getClaimCandidateIntakePolicyBundleAction,
  saveCompanyClaimCandidateIntakePolicyAction,
  savePlatformClaimCandidateIntakePolicyAction,
  saveStoreClaimCandidateIntakePolicyAction,
} from "@/app/platform/settings/automation/claim-candidate-intake-policy-actions";
import type {
  ClaimCandidateIntakePolicyBundle,
  ClaimCandidateIntakePolicyScope,
} from "@/app/platform/settings/automation/claim-candidate-intake-policy-action-types";

const SOURCE_LABELS: Record<ClaimSourceKind, string> = {
  scanner_physical_review: "Scanner physical review",
  amazon_removal_api: "Amazon removal API",
  reimbursement: "Reimbursements",
  settlement: "Settlements",
  transaction: "Transactions",
  inventory_ledger: "Inventory ledger",
  safet: "SAFE-T",
  delayed_not_received: "Delayed / not received",
  shipment_discrepancy: "Shipment discrepancy",
  inbound_shipment: "Inbound shipments",
  manual_import: "Manual import",
  orbit_fra: "ORBIT-FRA",
};

type Props = {
  organizationId: string;
  /** Omit on company settings page (store automation layer skipped). */
  storeId?: string | null;
  editableScopes: ClaimCandidateIntakePolicyScope[];
  /** Company settings page passes actor profile id for permission gate. */
  actorProfileId?: string | null;
  /** Hide store tab when not on automation page. */
  showStoreScope?: boolean;
  className?: string;
};

function scopeLabel(scope: ClaimCandidateIntakePolicyScope): string {
  if (scope === "platform") return "Platform defaults";
  if (scope === "company") return "Company override";
  return "Store override";
}

export function ClaimCandidateIntakePolicyPanel(props: Props) {
  const {
    organizationId,
    storeId,
    editableScopes,
    actorProfileId,
    showStoreScope = true,
    className = "",
  } = props;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [bundle, setBundle] = useState<ClaimCandidateIntakePolicyBundle | null>(null);
  const [activeScope, setActiveScope] = useState<ClaimCandidateIntakePolicyScope>(
    editableScopes[0] ?? "company",
  );
  const [draftCandidate, setDraftCandidate] = useState<ClaimCandidateIntakePolicy | null>(null);
  const [draftIntake, setDraftIntake] = useState<ClaimIntakeSettings | null>(null);
  const [draftAllowManualOverride, setDraftAllowManualOverride] = useState(false);
  const [storeOverrideEnabled, setStoreOverrideEnabled] = useState(false);

  const visibleScopes = useMemo(() => {
    const scopes = [...editableScopes];
    if (showStoreScope && !scopes.includes("store") && editableScopes.includes("platform")) {
      scopes.push("store");
    }
    return scopes.filter((s) => s !== "store" || showStoreScope);
  }, [editableScopes, showStoreScope]);

  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setError(null);
    const res = await getClaimCandidateIntakePolicyBundleAction({
      organizationId,
      storeId: storeId ?? null,
    });
    if (res.ok) {
      setBundle(res.bundle);
    } else {
      setError(res.error);
      setBundle(null);
    }
    setLoading(false);
  }, [organizationId, storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!bundle) return;
    if (activeScope === "platform") {
      setDraftCandidate({ ...bundle.platform.candidate_intake, manual_grouping: { ...bundle.platform.candidate_intake.manual_grouping } });
      setDraftIntake({ ...bundle.platform.intake, enabled_sources: [...bundle.platform.intake.enabled_sources] });
      setStoreOverrideEnabled(false);
    } else if (activeScope === "company") {
      setDraftCandidate({ ...bundle.company.candidate_intake, manual_grouping: { ...bundle.company.candidate_intake.manual_grouping } });
      setDraftIntake({ ...bundle.company.intake, enabled_sources: [...bundle.company.intake.enabled_sources] });
      setDraftAllowManualOverride(bundle.company.allow_manual_override);
      setStoreOverrideEnabled(false);
    } else {
      setStoreOverrideEnabled(bundle.store.candidate_intake_configured);
      const base = bundle.store.candidate_intake ?? bundle.company.candidate_intake;
      setDraftCandidate({ ...base, manual_grouping: { ...base.manual_grouping } });
      setDraftIntake(null);
    }
  }, [bundle, activeScope]);

  const effective = bundle?.effective.candidate_intake;
  const showPerScanWarning =
    (draftCandidate?.claim_candidate_trigger ?? effective?.claim_candidate_trigger) === "per_problem_scan";
  const showOverWarning =
    draftCandidate?.claim_over_received === true ||
    draftCandidate?.claimable_physical_events.includes("over_received");
  const showUnexpectedWarning =
    draftCandidate?.claim_unexpected_item === true ||
    draftCandidate?.claimable_physical_events.includes("unexpected_item");

  const toggleEvent = (event: ClaimablePhysicalEvent) => {
    setDraftCandidate((cur) => {
      if (!cur) return cur;
      const set = new Set(cur.claimable_physical_events);
      if (set.has(event)) set.delete(event);
      else set.add(event);
      let events = [...set];
      if (!cur.claim_over_received) events = events.filter((e) => e !== "over_received");
      if (!cur.claim_unexpected_item) events = events.filter((e) => e !== "unexpected_item");
      return { ...cur, claimable_physical_events: events.length ? events : [...CLAIMABLE_PHYSICAL_EVENTS] };
    });
  };

  const toggleSource = (kind: ClaimSourceKind) => {
    setDraftIntake((cur) => {
      if (!cur) return cur;
      const enabled = cur.enabled_sources.includes(kind);
      const purchased = cur.purchased_sources[kind] !== false;
      if (!purchased) return cur;
      return {
        ...cur,
        enabled_sources: enabled
          ? cur.enabled_sources.filter((k) => k !== kind)
          : [...cur.enabled_sources, kind],
      };
    });
  };

  const togglePurchased = (kind: ClaimSourceKind, purchased: boolean) => {
    setDraftIntake((cur) => {
      if (!cur) return cur;
      return {
        ...cur,
        purchased_sources: { ...cur.purchased_sources, [kind]: purchased },
      };
    });
  };

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!draftCandidate || !editableScopes.includes(activeScope)) return;
    setSaving(true);
    setError(null);
    setMessage(null);

    let res: { ok: true } | { ok: false; error: string };
    if (activeScope === "platform") {
      if (!draftIntake) {
        setSaving(false);
        return;
      }
      res = await savePlatformClaimCandidateIntakePolicyAction({
        candidate_intake: draftCandidate,
        intake: draftIntake,
      });
    } else if (activeScope === "company") {
      if (!draftIntake) {
        setSaving(false);
        return;
      }
      res = await saveCompanyClaimCandidateIntakePolicyAction({
        organizationId,
        candidate_intake: draftCandidate,
        intake: draftIntake,
        allow_manual_override: draftAllowManualOverride,
        actorProfileId,
      });
    } else {
      const sid = String(storeId ?? "").trim();
      if (!sid) {
        setSaving(false);
        setError("Select a store on the automation scope bar to save store overrides.");
        return;
      }
      if (!storeOverrideEnabled) {
        res = await clearStoreClaimCandidateIntakePolicyAction({ organizationId, storeId: sid });
      } else {
        res = await saveStoreClaimCandidateIntakePolicyAction({
          organizationId,
          storeId: sid,
          candidate_intake: draftCandidate,
        });
      }
    }

    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setMessage(`${scopeLabel(activeScope)} saved.`);
    void load();
  }

  const scopeDirty = useMemo(() => {
    if (!bundle || !draftCandidate) return false;
    if (activeScope === "platform") {
      return (
        !candidateIntakePolicyEqual(draftCandidate, bundle.platform.candidate_intake) ||
        (draftIntake != null && JSON.stringify(draftIntake) !== JSON.stringify(bundle.platform.intake))
      );
    }
    if (activeScope === "company") {
      return (
        !candidateIntakePolicyEqual(draftCandidate, bundle.company.candidate_intake) ||
        draftAllowManualOverride !== bundle.company.allow_manual_override ||
        (draftIntake != null && JSON.stringify(draftIntake) !== JSON.stringify(bundle.company.intake))
      );
    }
    if (!storeOverrideEnabled && !bundle.store.candidate_intake_configured) return false;
    if (!storeOverrideEnabled && bundle.store.candidate_intake_configured) return true;
    const saved = bundle.store.candidate_intake ?? bundle.company.candidate_intake;
    return !candidateIntakePolicyEqual(draftCandidate, saved);
  }, [activeScope, bundle, draftAllowManualOverride, draftCandidate, draftIntake, storeOverrideEnabled]);

  if (loading && !bundle) {
    return (
      <div className={`flex items-center gap-2 text-sm text-muted-foreground ${className}`}>
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading claim intake policy…
      </div>
    );
  }

  return (
    <section className={`rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-6 ${className}`}>
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-800 dark:text-amber-200">
          <Info className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-foreground">Claim candidate intake policy</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Controls when physical claim candidates may be created and which events are claimable.
            Candidate grain is <strong className="text-foreground">event-based</strong>.
          </p>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-sky-500/25 bg-sky-500/5 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        <p className="font-semibold text-foreground">Review scope architecture</p>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          <li>
            <strong className="text-foreground">Shipment Receive Review</strong> is the primary review scope.
            Missing becomes final at shipment review close — not at box scan.
          </li>
          <li>
            <strong className="text-foreground">Box</strong> and <strong className="text-foreground">pallet</strong>{" "}
            are child scopes. One box on a shipment: shipment review equals box review. Multiple boxes/pallets:
            shipment review is the aggregated review.
          </li>
        </ul>
      </div>

      {bundle ? (
        <div className="mt-4 rounded-xl border border-border/70 bg-muted/10 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Settings resolution (purchased gates flow downward only)
          </p>
          <ol className="mt-2 space-y-2">
            {bundle.resolution_steps.map((step) => (
              <li key={step.tier} className="text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">{step.label}</span>
                {step.active ? (
                  <span className="ml-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 dark:text-emerald-200">
                    configured
                  </span>
                ) : (
                  <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium">inherit</span>
                )}
                <span className="mt-0.5 block font-mono text-[10px] opacity-80">{step.storage_path}</span>
                <span className="mt-0.5 block">{step.summary}</span>
              </li>
            ))}
          </ol>
          {effective ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Effective trigger:{" "}
              <span className="font-semibold text-foreground">
                {CLAIM_CANDIDATE_TRIGGER_LABELS[effective.claim_candidate_trigger]}
              </span>
            </p>
          ) : null}
        </div>
      ) : null}

      {visibleScopes.length > 1 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {visibleScopes.map((scope) => (
            <button
              key={scope}
              type="button"
              onClick={() => setActiveScope(scope)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                activeScope === scope
                  ? "border-violet-500/50 bg-violet-500/10 text-violet-900 dark:text-violet-100"
                  : "border-border text-muted-foreground hover:bg-muted/40"
              }`}
            >
              {scopeLabel(scope)}
              {!editableScopes.includes(scope) ? " (view)" : ""}
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <p className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-900 dark:text-emerald-100">
          {message}
        </p>
      ) : null}

      {showPerScanWarning ? (
        <div className="mt-4 flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-950 dark:text-amber-50">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            <strong>Per problem scan</strong> creates candidates at the earliest moment — before box or shipment
            review consolidation. Use only when operators need immediate candidate visibility.
          </p>
        </div>
      ) : null}

      {(showOverWarning || showUnexpectedWarning) && (
        <div className="mt-3 flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-950 dark:text-amber-50">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            {showOverWarning ? "Over-received units are claimable. " : ""}
            {showUnexpectedWarning ? "Unexpected / off-manifest items are claimable. " : ""}
            Verify evidence and Amazon case rules before filing.
          </p>
        </div>
      )}

      {draftCandidate && editableScopes.includes(activeScope) ? (
        <form onSubmit={onSave} className="mt-4 space-y-5">
          {activeScope === "store" ? (
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/60 bg-background/50 p-3">
              <input
                type="checkbox"
                checked={storeOverrideEnabled}
                onChange={(e) => setStoreOverrideEnabled(e.target.checked)}
                className="mt-0.5 rounded border-border"
              />
              <span>
                <span className="block text-sm font-semibold text-foreground">Store-level override</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  When off, this store inherits the company policy. Schedule sources and dry-run/apply mode remain on
                  the Claim Pool Generation card below.
                </span>
              </span>
            </label>
          ) : null}

          <fieldset
            className="space-y-3"
            disabled={activeScope === "store" && !storeOverrideEnabled}
          >
            <legend className="text-sm font-semibold text-foreground">Candidate creation trigger</legend>
            <select
              value={draftCandidate.claim_candidate_trigger}
              onChange={(e) =>
                setDraftCandidate((cur) =>
                  cur
                    ? { ...cur, claim_candidate_trigger: e.target.value as ClaimCandidateTrigger }
                    : cur,
                )
              }
              className={responsiveFormInput}
            >
              {CLAIM_CANDIDATE_TRIGGERS.map((t) => (
                <option key={t} value={t}>
                  {CLAIM_CANDIDATE_TRIGGER_LABELS[t]}
                </option>
              ))}
            </select>
          </fieldset>

          <fieldset
            className="space-y-3"
            disabled={activeScope === "store" && !storeOverrideEnabled}
          >
            <legend className="text-sm font-semibold text-foreground">Claimable physical events</legend>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {CLAIMABLE_PHYSICAL_EVENTS.map((event) => (
                <label key={event} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draftCandidate.claimable_physical_events.includes(event)}
                    onChange={() => toggleEvent(event)}
                    className="rounded border-border"
                  />
                  {CLAIMABLE_PHYSICAL_EVENT_LABELS[event]}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset
            className="grid gap-3 sm:grid-cols-2"
            disabled={activeScope === "store" && !storeOverrideEnabled}
          >
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draftCandidate.claim_over_received}
                onChange={(e) => {
                  const v = e.target.checked;
                  setDraftCandidate((cur) => {
                    if (!cur) return cur;
                    let events = [...cur.claimable_physical_events];
                    if (v && !events.includes("over_received")) events.push("over_received");
                    if (!v) events = events.filter((x) => x !== "over_received");
                    return { ...cur, claim_over_received: v, claimable_physical_events: events };
                  });
                }}
                className="rounded border-border"
              />
              Claim over-received units
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draftCandidate.claim_unexpected_item}
                onChange={(e) => {
                  const v = e.target.checked;
                  setDraftCandidate((cur) => {
                    if (!cur) return cur;
                    let events = [...cur.claimable_physical_events];
                    if (v && !events.includes("unexpected_item")) events.push("unexpected_item");
                    if (!v) events = events.filter((x) => x !== "unexpected_item");
                    return { ...cur, claim_unexpected_item: v, claimable_physical_events: events };
                  });
                }}
                className="rounded border-border"
              />
              Claim unexpected / off-manifest items
            </label>
          </fieldset>

          <fieldset
            className="space-y-2 rounded-lg border border-border/60 p-3"
            disabled={activeScope === "store" && !storeOverrideEnabled}
          >
            <legend className="px-1 text-sm font-semibold text-foreground">Manual grouping</legend>
            {(
              [
                ["allow_single", "Allow single-item manual groups"],
                ["allow_grouped", "Allow grouped manual claims"],
                ["warn_mixed_products", "Warn on mixed products"],
                ["warn_mixed_problem_types", "Warn on mixed problem types"],
                ["warn_mixed_reference_types", "Warn on mixed reference types"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draftCandidate.manual_grouping[key]}
                  onChange={(e) =>
                    setDraftCandidate((cur) =>
                      cur
                        ? {
                            ...cur,
                            manual_grouping: {
                              ...cur.manual_grouping,
                              [key]: e.target.checked,
                            },
                          }
                        : cur,
                    )
                  }
                  className="rounded border-border"
                />
                {label}
              </label>
            ))}
            {activeScope === "company" ? (
              <label className="mt-2 flex items-center gap-2 border-t border-border/50 pt-2 text-sm">
                <input
                  type="checkbox"
                  checked={draftAllowManualOverride}
                  onChange={(e) => setDraftAllowManualOverride(e.target.checked)}
                  className="rounded border-border"
                />
                Allow manual override (bypass strict product-link / mixed gates)
              </label>
            ) : null}
          </fieldset>

          {draftIntake && activeScope !== "store" ? (
            <>
              <fieldset className="space-y-3">
                <legend className="text-sm font-semibold text-foreground">Enabled source kinds</legend>
                <p className="text-xs text-muted-foreground">
                  Purchased gates flow downward — disable at platform to gate Pro features for all tenants.
                </p>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {CLAIM_SOURCE_KINDS.map((kind) => {
                    const purchased = draftIntake.purchased_sources[kind] !== false;
                    return (
                      <div key={kind} className="flex flex-col gap-1 rounded-md border border-border/50 p-2">
                        <label className={`flex items-center gap-2 text-sm ${purchased ? "" : "opacity-60"}`}>
                          <input
                            type="checkbox"
                            checked={draftIntake.enabled_sources.includes(kind)}
                            disabled={!purchased}
                            onChange={() => toggleSource(kind)}
                            className="rounded border-border"
                          />
                          {SOURCE_LABELS[kind]}
                          {!purchased ? " 👑" : ""}
                        </label>
                        {activeScope === "platform" ? (
                          <label className="flex items-center gap-1 pl-6 text-[10px] text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={purchased}
                              onChange={(e) => togglePurchased(kind, e.target.checked)}
                              className="rounded border-border"
                            />
                            Purchased (plan gate)
                          </label>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </fieldset>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <label className="block text-sm">
                  <span className="font-medium text-foreground">Rolling window (days)</span>
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={draftIntake.rolling_window_days}
                    onChange={(e) =>
                      setDraftIntake((cur) =>
                        cur ? { ...cur, rolling_window_days: Number(e.target.value) } : cur,
                      )
                    }
                    className={`${responsiveFormInput} mt-1.5`}
                  />
                </label>
                <label className="block text-sm">
                  <span className="font-medium text-foreground">Manual window start</span>
                  <input
                    type="date"
                    value={draftIntake.date_from ?? ""}
                    onChange={(e) =>
                      setDraftIntake((cur) =>
                        cur ? { ...cur, date_from: e.target.value || null } : cur,
                      )
                    }
                    className={`${responsiveFormInput} mt-1.5`}
                  />
                </label>
                <label className="block text-sm">
                  <span className="font-medium text-foreground">Manual window end</span>
                  <input
                    type="date"
                    value={draftIntake.date_to ?? ""}
                    onChange={(e) =>
                      setDraftIntake((cur) =>
                        cur ? { ...cur, date_to: e.target.value || null } : cur,
                      )
                    }
                    className={`${responsiveFormInput} mt-1.5`}
                  />
                </label>
                <label className="flex items-end gap-2 pb-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draftIntake.manual_run_enabled}
                    onChange={(e) =>
                      setDraftIntake((cur) =>
                        cur ? { ...cur, manual_run_enabled: e.target.checked } : cur,
                      )
                    }
                    className="rounded border-border"
                  />
                  Manual generator runs enabled
                </label>
              </div>

              <p className="text-xs text-muted-foreground">
                Scheduled generator dry-run vs apply mode is configured per store on the Claim Pool Generation
                schedule card (below on automation page).
              </p>
            </>
          ) : null}

          {activeScope === "store" && bundle ? (
            <div className="rounded-lg border border-border/60 bg-muted/10 p-3 text-xs text-muted-foreground">
              <p className="font-semibold text-foreground">Store schedule &amp; sources (read path)</p>
              <p className="mt-1">
                Enabled sources: {bundle.store.claim_pool.enabled_source_kinds.length} · Rolling{" "}
                {bundle.store.claim_pool.rolling_days}d · Scheduled mode{" "}
                {bundle.store.claim_pool.scheduled_mode}
              </p>
              <p className="mt-1">Edit schedule, sources, and dry-run/apply on the Claim Pool Generation card.</p>
            </div>
          ) : null}

          <div className="flex justify-end border-t border-border pt-4">
            <button
              type="submit"
              disabled={saving || !scopeDirty}
              className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save {scopeLabel(activeScope).toLowerCase()}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
