"use client";

import React from "react";
import { Loader2 } from "lucide-react";

import {
  AUTOMATION_API_REPORT_TYPE_OPTIONS,
  type AutomationApiReportType,
} from "@/lib/platform-automation-api-report-type";
import { responsiveFormInput } from "@/lib/responsive-page-shell";
import type { OrganizationOption } from "../automation-settings-actions";

type StoreOption = { id: string; name: string; platform: string };

type Props = {
  organizations: OrganizationOption[];
  stores: StoreOption[];
  orgId: string;
  storeId: string;
  onOrgChange: (orgId: string) => void;
  onStoreChange: (storeId: string) => void;
  apiReportType: AutomationApiReportType;
  onApiReportTypeChange: (value: AutomationApiReportType) => void;
  scopeLoading: boolean;
};

export function AutomationScopeBar({
  organizations,
  stores,
  orgId,
  storeId,
  onOrgChange,
  onStoreChange,
  apiReportType,
  onApiReportTypeChange,
  scopeLoading,
}: Props) {
  const selectedOrgName = organizations.find((o) => o.id === orgId)?.name ?? null;
  const selectedStore = stores.find((s) => s.id === storeId) ?? null;

  return (
    <section
      className="rounded-2xl border-2 border-violet-500/25 bg-card p-4 shadow-sm sm:p-5"
      aria-label="Automation scope"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Automation scope</h2>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Company and store here apply <strong>only</strong> to this page. They do not change the global workspace
            selector in the header or module visibility elsewhere.
          </p>
        </div>
        {scopeLoading ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            Loading settings…
          </span>
        ) : null}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <label className="block text-sm">
          <span className="font-medium text-foreground">Company</span>
          <select
            value={orgId}
            onChange={(e) => onOrgChange(e.target.value)}
            className={`${responsiveFormInput} mt-1.5`}
            aria-label="Automation company"
          >
            {organizations.length === 0 ? (
              <option value="">No companies available</option>
            ) : null}
            {organizations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="font-medium text-foreground">Store</span>
          <select
            value={storeId}
            disabled={!orgId || !stores.length}
            onChange={(e) => onStoreChange(e.target.value)}
            className={`${responsiveFormInput} mt-1.5`}
            aria-label="Automation store"
          >
            {!stores.length ? (
              <option value="">{orgId ? "No stores for this company" : "Select a company first"}</option>
            ) : null}
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.platform})
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="font-medium text-foreground">Automation type</span>
          <select
            value={apiReportType}
            onChange={(e) => onApiReportTypeChange(e.target.value as AutomationApiReportType)}
            className={`${responsiveFormInput} mt-1.5`}
            aria-label="Automation type"
          >
            {AUTOMATION_API_REPORT_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-muted-foreground">
            One automation card is shown at a time for the selected company and store.
          </span>
        </label>
      </div>

      <div className="mt-4 rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5 text-sm">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Configuring</span>
        <p className="mt-1 font-medium text-foreground">
          {selectedOrgName ?? "—"}
          {selectedStore ? (
            <>
              {" · "}
              <span className="text-foreground">{selectedStore.name}</span>
              <span className="text-muted-foreground"> ({selectedStore.platform})</span>
            </>
          ) : (
            <span className="text-muted-foreground"> · select a store</span>
          )}
        </p>
      </div>
    </section>
  );
}
