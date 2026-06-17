"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Loader2, Upload } from "lucide-react";

import { ClaimCenterFinancialNav } from "@/components/claim-center/financial/ClaimCenterFinancialNav";
import { ClaimCenterV2PageShell } from "@/components/claim-center/ClaimCenterV2PageShell";
import { useClaimCenter } from "@/components/claim-center/ClaimCenterRootClient";
import { claimCenterBadgeTone } from "@/components/claim-center/claim-center-ui";
import { formatTrackingMoney } from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";
import {
  REIMBURSEMENT_TRACKING_PAGE_CONTRACT,
} from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";
import type {
  ImportDryRunResultV1,
  ManualCogsDryRunResultV1,
  ManualCogsEntryInputV1,
  PilotProductCogsRowV1,
  ProductCogsManualEntryUiPayloadV1,
} from "@/lib/claims/submission/product-cogs-manual-entry-ui-v1";

const SOURCE_TYPES = [{ value: "manual_override", label: "Manual override (approved COGS)" }] as const;

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ProductCogsManualEntryView() {
  const { fetchJson, storeId, organizationId } = useClaimCenter();
  const [payload, setPayload] = useState<ProductCogsManualEntryUiPayloadV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFnsku, setSelectedFnsku] = useState<string | null>(null);
  const [rawOpen, setRawOpen] = useState(false);

  const [unitCost, setUnitCost] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [effectiveDate, setEffectiveDate] = useState(todayIsoDate());
  const [sourceNote, setSourceNote] = useState("");
  const [approvedBy, setApprovedBy] = useState("operator");
  const [sourceType, setSourceType] = useState<ManualCogsEntryInputV1["sourceType"]>("manual_override");
  const [salePriceConfirmed, setSalePriceConfirmed] = useState(false);
  const [manualDryRun, setManualDryRun] = useState<ManualCogsDryRunResultV1 | null>(null);
  const [manualSubmitting, setManualSubmitting] = useState(false);

  const [csvText, setCsvText] = useState("");
  const [importDryRun, setImportDryRun] = useState<ImportDryRunResultV1 | null>(null);
  const [importSubmitting, setImportSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!storeId) {
      setPayload(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<ProductCogsManualEntryUiPayloadV1>(
        "/api/claims/center/reimbursement-tracking/cogs",
        { store_id: storeId },
      );
      setPayload(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load COGS panel.");
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [fetchJson, storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedProduct = useMemo(
    () => payload?.pilotProducts.find((p) => p.fnsku === selectedFnsku) ?? null,
    [payload, selectedFnsku],
  );

  const previewRecovery = useMemo(() => {
    const cost = parseFloat(unitCost);
    if (!selectedProduct || !Number.isFinite(cost) || cost <= 0) return null;
    return Math.round(selectedProduct.cleanQuantityTotal * cost * 100) / 100;
  }, [selectedProduct, unitCost]);

  const selectProduct = (row: PilotProductCogsRowV1) => {
    setSelectedFnsku(row.fnsku);
    setUnitCost("");
    setCurrency("USD");
    setEffectiveDate(todayIsoDate());
    setSourceNote("");
    setSalePriceConfirmed(false);
    setManualDryRun(null);
  };

  const runManualDryRun = async () => {
    if (!storeId || !selectedProduct) return;
    setManualSubmitting(true);
    setManualDryRun(null);
    try {
      const entry: ManualCogsEntryInputV1 = {
        fnsku: selectedProduct.fnsku,
        unitCost: parseFloat(unitCost),
        currency,
        effectiveDate,
        sourceNote,
        approvedBy,
        sourceType,
        salePriceReviewConfirmed: salePriceConfirmed,
      };
      const res = await fetch(
        `/api/claims/center/reimbursement-tracking/cogs?organization_id=${encodeURIComponent(
          organizationId,
        )}&store_id=${encodeURIComponent(storeId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "manual", entry }),
        },
      );
      const data = (await res.json()) as ManualCogsDryRunResultV1 & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Dry-run failed.");
      setManualDryRun(data);
    } catch (e) {
      setManualDryRun({
        ok: false,
        dryRun: true,
        noDbWrite: true,
        fnsku: selectedProduct.fnsku,
        issues: [
          {
            field: "request",
            code: "request_failed",
            message: e instanceof Error ? e.message : "Dry-run failed.",
            severity: "error",
          },
        ],
        preview: null,
        wouldWriteTo: "cogs_overrides (execute phase only)",
      });
    } finally {
      setManualSubmitting(false);
    }
  };

  const runImportDryRun = async () => {
    if (!storeId) return;
    setImportSubmitting(true);
    setImportDryRun(null);
    try {
      const res = await fetch(
        `/api/claims/center/reimbursement-tracking/cogs?organization_id=${encodeURIComponent(
          organizationId,
        )}&store_id=${encodeURIComponent(storeId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "import", csvText, approvedBy }),
        },
      );
      const data = (await res.json()) as ImportDryRunResultV1 & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Import dry-run failed.");
      setImportDryRun(data);
    } catch (e) {
      setImportDryRun({
        ok: false,
        dryRun: true,
        noDbWrite: true,
        rowCount: 0,
        validCount: 0,
        errorCount: 1,
        rows: [],
      });
      setError(e instanceof Error ? e.message : "Import dry-run failed.");
    } finally {
      setImportSubmitting(false);
    }
  };

  const salePriceMatch =
    selectedProduct?.latestSoldPrice != null &&
    Number.isFinite(parseFloat(unitCost)) &&
    Math.round(parseFloat(unitCost) * 100) === Math.round(selectedProduct.latestSoldPrice * 100);

  return (
    <ClaimCenterV2PageShell contract={REIMBURSEMENT_TRACKING_PAGE_CONTRACT}>
      <ClaimCenterFinancialNav />

      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading pilot COGS panel…
        </div>
      ) : error && !payload ? (
        <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-800 dark:text-red-200">
          {error}
        </p>
      ) : payload ? (
        <div className="space-y-6">
          <header className="claim-center-card space-y-4 rounded-xl border p-5 sm:p-6">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 space-y-2">
                <p className="text-xs font-semibold uppercase opacity-55">
                  <Link href="/claim-center/reimbursement-tracking" className="hover:underline">
                    Reimbursement Tracking
                  </Link>
                  {" · "}
                  Pilot COGS Entry
                </p>
                <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">COGS Source Panel</h1>
                <p className="max-w-3xl text-sm opacity-80">{payload.plan.recommendedOption}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className={claimCenterBadgeTone(payload.approvalStatus.write_enabled ? "success" : "warning")}>
                  {payload.approvalStatus.write_enabled ? "Write approved" : "Preview only"}
                </span>
                <span className={claimCenterBadgeTone("neutral")}>
                  Build {payload.approvalStatus.source_build}
                </span>
              </div>
            </div>

            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-950 dark:text-amber-100">
              <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
              {payload.safetyBanner}
            </p>

            <p className="text-xs opacity-70">
              Approval: {payload.approvalStatus.source_build} source build ·{" "}
              {payload.approvalStatus.schema_migration} schema migration · {payload.approvalStatus.write} write
            </p>

            <p className="text-xs opacity-70">{payload.plan.recoveryFormula}</p>
            <p className="text-xs opacity-70">{payload.plan.salePriceNotCogs}</p>
          </header>

          <section className="claim-center-card rounded-xl border p-4 sm:p-5">
            <h2 className="text-sm font-semibold">Pilot products needing COGS ({payload.pilotProductsLoadedCount})</h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[960px] text-left text-xs">
                <thead>
                  <tr className="border-b text-[10px] uppercase opacity-55">
                    <th className="px-2 py-2">FNSKU</th>
                    <th className="px-2 py-2">SKU</th>
                    <th className="px-2 py-2">ASIN</th>
                    <th className="px-2 py-2">Title</th>
                    <th className="px-2 py-2">Claims</th>
                    <th className="px-2 py-2">Total qty</th>
                    <th className="px-2 py-2">Latest sold</th>
                    <th className="px-2 py-2">Settlement net</th>
                    <th className="px-2 py-2">COGS</th>
                    <th className="px-2 py-2">Recovery preview</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {payload.pilotProducts.map((row) => (
                    <tr
                      key={row.fnsku}
                      className={`border-b ${selectedFnsku === row.fnsku ? "bg-sky-500/5" : ""}`}
                    >
                      <td className="px-2 py-2 font-mono">{row.fnsku}</td>
                      <td className="px-2 py-2 font-mono">{row.sku ?? "—"}</td>
                      <td className="px-2 py-2 font-mono">{row.asin ?? "—"}</td>
                      <td className="max-w-[180px] truncate px-2 py-2" title={row.productTitle ?? undefined}>
                        {row.productTitle ?? "—"}
                      </td>
                      <td className="px-2 py-2 tabular-nums">{row.affectedClaimCount}</td>
                      <td className="px-2 py-2 tabular-nums">{row.cleanQuantityTotal}</td>
                      <td className="px-2 py-2 tabular-nums">{formatTrackingMoney(row.latestSoldPrice)}</td>
                      <td className="px-2 py-2 tabular-nums">{formatTrackingMoney(row.settlementNet)}</td>
                      <td className="px-2 py-2">
                        <span
                          className={claimCenterBadgeTone(
                            row.cogsStatus === "missing" ? "warning" : "success",
                          )}
                        >
                          {row.cogsStatus === "missing" ? "Missing" : "Override present"}
                        </span>
                      </td>
                      <td className="px-2 py-2 tabular-nums">{row.recoveryPreviewLabel}</td>
                      <td className="px-2 py-2">
                        <button
                          type="button"
                          onClick={() => selectProduct(row)}
                          className="rounded-md border px-2 py-1 text-[10px] font-semibold hover:bg-black/5 dark:hover:bg-white/5"
                        >
                          Enter COGS
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {selectedProduct ? (
            <section className="claim-center-card grid gap-6 rounded-xl border p-4 sm:p-5 lg:grid-cols-2">
              <div className="space-y-4">
                <h2 className="text-sm font-semibold">Manual entry — {selectedProduct.fnsku}</h2>
                <dl className="grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="opacity-55">Resolved product ID</dt>
                    <dd className="font-mono text-[10px] break-all">{selectedProduct.resolvedProductId ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="opacity-55">SKU / ASIN</dt>
                    <dd className="font-mono text-[10px]">
                      {selectedProduct.sku ?? "—"} · {selectedProduct.asin ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="opacity-55">Clean quantity (pilot)</dt>
                    <dd className="font-medium tabular-nums">{selectedProduct.cleanQuantityTotal}</dd>
                  </div>
                  <div>
                    <dt className="opacity-55">Latest sold price (informational)</dt>
                    <dd className="font-medium tabular-nums">
                      {formatTrackingMoney(selectedProduct.latestSoldPrice)}
                    </dd>
                  </div>
                </dl>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-xs">
                    <span className="font-semibold">Unit cost *</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={unitCost}
                      onChange={(e) => {
                        setUnitCost(e.target.value);
                        setManualDryRun(null);
                      }}
                      className="mt-1 w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
                    />
                  </label>
                  <label className="block text-xs">
                    <span className="font-semibold">Currency *</span>
                    <input
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value)}
                      className="mt-1 w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
                    />
                  </label>
                  <label className="block text-xs">
                    <span className="font-semibold">Effective date *</span>
                    <input
                      type="date"
                      value={effectiveDate}
                      onChange={(e) => setEffectiveDate(e.target.value)}
                      className="mt-1 w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
                    />
                  </label>
                  <label className="block text-xs">
                    <span className="font-semibold">Source type</span>
                    <select
                      value={sourceType}
                      onChange={(e) =>
                        setSourceType(e.target.value as ManualCogsEntryInputV1["sourceType"])
                      }
                      className="mt-1 w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
                    >
                      {SOURCE_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs sm:col-span-2">
                    <span className="font-semibold">Source note *</span>
                    <textarea
                      value={sourceNote}
                      onChange={(e) => setSourceNote(e.target.value)}
                      rows={2}
                      className="mt-1 w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
                      placeholder="Vendor invoice #, operator estimate source, etc."
                    />
                  </label>
                  <label className="block text-xs sm:col-span-2">
                    <span className="font-semibold">Approved by *</span>
                    <input
                      value={approvedBy}
                      onChange={(e) => setApprovedBy(e.target.value)}
                      className="mt-1 w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
                    />
                  </label>
                </div>

                {salePriceMatch ? (
                  <label className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
                    <input
                      type="checkbox"
                      checked={salePriceConfirmed}
                      onChange={(e) => setSalePriceConfirmed(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      I reviewed this — unit cost equals latest sold price but is NOT sale price used as COGS.
                    </span>
                  </label>
                ) : null}

                <div className="rounded-lg border bg-black/[0.02] px-3 py-2 text-xs dark:bg-white/[0.02]">
                  <p className="font-semibold">Recovery preview (dry-run)</p>
                  <p className="mt-1 tabular-nums">
                    {previewRecovery != null
                      ? `Total: ${selectedProduct.cleanQuantityTotal} × ${unitCost} = ${formatTrackingMoney(previewRecovery)}`
                      : "Unknown — enter a positive unit cost"}
                  </p>
                  {previewRecovery != null && selectedProduct.affectedSubmissions.length > 0 ? (
                    <ul className="mt-2 space-y-1 border-t pt-2 font-mono text-[10px]">
                      {selectedProduct.affectedSubmissions.map((s) => {
                        const subRv =
                          parseFloat(unitCost) > 0
                            ? Math.round(s.cleanQuantity * parseFloat(unitCost) * 100) / 100
                            : null;
                        return (
                          <li key={s.claimSubmissionId}>
                            {s.cleanQuantity} × {unitCost} = {formatTrackingMoney(subRv)} · submission{" "}
                            {s.claimSubmissionId.slice(0, 8)}…
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                  <p className="mt-2 opacity-70">Fees are not subtracted from recovery for removal pilot families.</p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={manualSubmitting}
                    onClick={() => void runManualDryRun()}
                    className="rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
                  >
                    {manualSubmitting ? "Validating…" : "Preview save (dry-run)"}
                  </button>
                  <button
                    type="button"
                    disabled
                    title={
                      payload.approvalStatus.write_enabled
                        ? "Use approved execute script for batch apply"
                        : "Requires APPROVED_PRODUCT_COGS_WRITE_V1=yes in operator approval file"
                    }
                    className="rounded-lg border px-4 py-2 text-xs font-semibold opacity-50"
                  >
                    Apply COGS (disabled)
                  </button>
                </div>

                {manualDryRun ? (
                  <div
                    className={`rounded-lg border px-3 py-2 text-xs ${
                      manualDryRun.ok
                        ? "border-emerald-500/30 bg-emerald-500/10"
                        : "border-red-500/30 bg-red-500/10"
                    }`}
                  >
                    <p className="font-semibold">
                      Dry-run {manualDryRun.ok ? "passed" : "failed"} — no DB write
                    </p>
                    {manualDryRun.preview ? (
                      <>
                        <p className="mt-1">
                          Total recovery: {manualDryRun.preview.recoveryLabel} ({manualDryRun.preview.currency})
                        </p>
                        {manualDryRun.preview.perSubmission.length > 0 ? (
                          <ul className="mt-2 space-y-1 font-mono text-[10px]">
                            {manualDryRun.preview.perSubmission.map((s) => (
                              <li key={s.claimSubmissionId}>
                                {s.cleanQuantity} × {manualDryRun.preview!.unitCost} = {s.recoveryPreviewLabel}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </>
                    ) : null}
                    {manualDryRun.issues.length > 0 ? (
                      <ul className="mt-2 list-disc pl-4">
                        {manualDryRun.issues.map((i) => (
                          <li key={`${i.field}-${i.code}`}>{i.message}</li>
                        ))}
                      </ul>
                    ) : null}
                    <p className="mt-2 opacity-70">Would write to: {manualDryRun.wouldWriteTo}</p>
                  </div>
                ) : null}
              </div>

              <div className="space-y-4">
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <Upload className="h-4 w-4" /> CSV / XLSX import preview
                </h2>
                <p className="text-xs opacity-70">
                  Simple columns: FNSKU or SKU or ASIN, cost, currency, effective_date, source — or extended
                  identifier_type format. Rejected headers: {payload.rejectedSourceFields.slice(0, 4).join(", ")}…
                </p>
                <textarea
                  value={csvText}
                  onChange={(e) => setCsvText(e.target.value)}
                  rows={8}
                  className="w-full rounded-lg border bg-transparent px-3 py-2 font-mono text-[11px]"
                  placeholder={`identifier_type,identifier_value,unit_cost,currency,effective_date,source_note\nFNSKU,${selectedProduct.fnsku},12.50,USD,2026-06-15,Vendor quote`}
                />
                <button
                  type="button"
                  disabled={importSubmitting || !csvText.trim()}
                  onClick={() => void runImportDryRun()}
                  className="rounded-lg border px-4 py-2 text-xs font-semibold hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
                >
                  {importSubmitting ? "Parsing…" : "Run import dry-run"}
                </button>

                {importDryRun ? (
                  <div className="rounded-lg border px-3 py-2 text-xs">
                    <p className="font-semibold">
                      {importDryRun.validCount}/{importDryRun.rowCount} rows valid — no DB write
                    </p>
                    <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto">
                      {importDryRun.rows.map((r) => (
                        <li
                          key={r.rowIndex}
                          className={`rounded border px-2 py-1 ${
                            r.ok ? "border-emerald-500/20" : "border-red-500/20"
                          }`}
                        >
                          Row {r.rowIndex + 1}: {r.identifierType}={r.identifierValue}
                          {r.matchedFnsku ? ` → ${r.matchedFnsku}` : ""}
                          {r.preview ? ` · recovery ${r.preview.recoveryLabel}` : ""}
                          {r.issues.length > 0 ? (
                            <ul className="mt-1 list-disc pl-4 opacity-80">
                              {r.issues.map((i) => (
                                <li key={`${i.code}-${i.field}`}>{i.message}</li>
                              ))}
                            </ul>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </section>
          ) : (
            <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm opacity-70">
              Select a pilot product to enter or import COGS.
            </p>
          )}

          <div>
            <button
              type="button"
              onClick={() => setRawOpen((v) => !v)}
              className="inline-flex items-center gap-1 text-xs font-semibold opacity-70 hover:opacity-100"
            >
              {rawOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              Raw payload
            </button>
            {rawOpen && payload ? (
              <pre className="mt-2 max-h-64 overflow-auto rounded-lg border bg-black/5 p-3 text-[10px] dark:bg-white/5">
                {JSON.stringify(payload, null, 2)}
              </pre>
            ) : null}
          </div>
        </div>
      ) : null}
    </ClaimCenterV2PageShell>
  );
}
