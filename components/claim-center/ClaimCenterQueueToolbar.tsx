"use client";

import { useState } from "react";
import { Search, SlidersHorizontal } from "lucide-react";

import {
  MenorixModuleMobileFilterSheet,
  MenorixModuleViewSwitcher,
  type MenorixModuleViewMode,
} from "@/components/menorix";

import { CLAIM_CENTER_INPUT_CLASS } from "./claim-center-ui";

type Props = {
  search: string;
  onSearchChange: (v: string) => void;
  viewMode: MenorixModuleViewMode;
  onViewModeChange: (m: MenorixModuleViewMode) => void;
  filterContent?: React.ReactNode;
  resultCount?: number;
};

export function ClaimCenterQueueToolbar({
  search,
  onSearchChange,
  viewMode,
  onViewModeChange,
  filterContent,
  resultCount,
}: Props) {
  const [filtersOpen, setFiltersOpen] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50" />
          <input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search SKU, ASIN, reference, reason…"
            className={`${CLAIM_CENTER_INPUT_CLASS} pl-9 min-h-[44px]`}
            aria-label="Search queue"
          />
        </div>
        <div className="flex items-center gap-2">
          {filterContent ? (
            <button
              type="button"
              className="claim-center-btn inline-flex min-h-[44px] items-center gap-2 rounded-lg border px-3 text-xs font-semibold lg:hidden"
              onClick={() => setFiltersOpen(true)}
            >
              <SlidersHorizontal className="h-4 w-4" /> Filters
            </button>
          ) : null}
          <MenorixModuleViewSwitcher value={viewMode} onChange={onViewModeChange} compact />
        </div>
      </div>
      {filterContent ? (
        <div className="hidden flex-wrap gap-3 text-xs lg:flex">{filterContent}</div>
      ) : null}
      {typeof resultCount === "number" ? (
        <p className="text-xs opacity-60">{resultCount} item{resultCount === 1 ? "" : "s"} in scope</p>
      ) : null}
      {filterContent ? (
        <MenorixModuleMobileFilterSheet open={filtersOpen} onClose={() => setFiltersOpen(false)}>
          {filterContent}
        </MenorixModuleMobileFilterSheet>
      ) : null}
    </div>
  );
}
