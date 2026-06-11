import { Loader2 } from "lucide-react";

import { MENORIX_MODULE_CARD_CLASS, MENORIX_TOUCH_MIN } from "./menorix-module-ui";

export type MenorixScopeStoreOption = {
  store_id: string;
  name: string;
  platform?: string;
};

export function MenorixModuleScopeBar({
  moduleLabel,
  stores,
  storeId,
  onStoreChange,
  loading,
  organizationHint,
}: {
  moduleLabel: string;
  stores: MenorixScopeStoreOption[];
  storeId: string | null;
  onStoreChange: (id: string | null) => void;
  loading?: boolean;
  organizationHint?: string;
}) {
  return (
    <div className={`${MENORIX_MODULE_CARD_CLASS} flex flex-wrap items-center justify-between gap-3 px-3 py-2 sm:px-4`}>
      <div>
        <p className="text-[11px] font-bold uppercase tracking-wide opacity-60">{moduleLabel}</p>
        {organizationHint ? <p className="text-xs opacity-50">{organizationHint}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        {loading ? <Loader2 className="h-4 w-4 animate-spin opacity-60" /> : null}
        <label className="sr-only" htmlFor="menorix-scope-store">
          Store scope
        </label>
        <select
          id="menorix-scope-store"
          className={`menorix-module-select rounded-lg px-2 py-2 text-xs sm:text-sm ${MENORIX_TOUCH_MIN}`}
          value={storeId ?? ""}
          onChange={(e) => onStoreChange(e.target.value || null)}
        >
          <option value="">All stores</option>
          {stores.map((s) => (
            <option key={s.store_id} value={s.store_id}>
              {s.name}
              {s.platform ? ` (${s.platform})` : ""}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
