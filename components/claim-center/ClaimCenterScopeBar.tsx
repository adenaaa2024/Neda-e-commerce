"use client";

import { Loader2, Store } from "lucide-react";

import { CLAIM_CENTER_SELECT_CLASS } from "./claim-center-ui";

export type ClaimCenterStoreOption = {
  store_id: string;
  name: string;
  platform?: string;
};

type Props = {
  stores: ClaimCenterStoreOption[];
  storeId: string | null;
  onStoreChange: (storeId: string | null) => void;
  loading?: boolean;
  organizationLabel?: string;
};

export function ClaimCenterScopeBar({
  stores,
  storeId,
  onStoreChange,
  loading,
  organizationLabel,
}: Props) {
  return (
    <div className="claim-center-scope-bar flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2.5 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <Store className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
        <span className="truncate font-medium">{organizationLabel ?? "Organization scope"}</span>
      </div>
      <label className="flex flex-1 items-center gap-2 sm:max-w-xs">
        <span className="sr-only">Sales channel</span>
        <select
          className={CLAIM_CENTER_SELECT_CLASS}
          value={storeId ?? ""}
          disabled={loading}
          onChange={(e) => onStoreChange(e.target.value || null)}
        >
          <option value="">All sales channels</option>
          {stores.map((s) => (
            <option key={s.store_id} value={s.store_id}>
              {s.name}
              {s.platform ? ` (${s.platform})` : ""}
            </option>
          ))}
        </select>
        {loading ? <Loader2 className="h-4 w-4 animate-spin opacity-60" /> : null}
      </label>
      <span className="text-xs opacity-70">Read-only · V1</span>
    </div>
  );
}
