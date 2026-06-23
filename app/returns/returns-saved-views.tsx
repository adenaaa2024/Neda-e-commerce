"use client";

/**
 * Returns Report — Saved Views control (Phase 1, frontend-only).
 *
 * Lets the user save the current report tab's filters + visible columns as a
 * named view, list saved views, re-apply one, or delete it. Persistence is
 * browser-local via `lib/returns-saved-views` (`returns.report.savedViews`).
 * No backend, no DB schema, no cross-user sharing.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, BookmarkPlus, Check, ChevronDown, Trash2, X } from "lucide-react";
import {
  addSavedView,
  deleteSavedView,
  makeSavedViewId,
  readSavedViews,
  type ReturnsReportSavedView,
  type ReturnsReportTab,
  type ReturnsReportViewSnapshot,
} from "../../lib/returns-saved-views";

const TAB_LABEL: Record<ReturnsReportTab, string> = {
  items: "Items",
  packages: "Boxes",
  pallets: "Pallets",
};

const BTN =
  "inline-flex h-9 items-center gap-1.5 rounded-lg border border-[rgba(138,104,31,0.18)] bg-[#FFFFFF] px-2.5 text-xs font-semibold text-[#171A1E] transition hover:bg-[#F3EFE6] dark:border-[rgba(214,183,110,0.18)] dark:bg-[#1D242C] dark:text-[#F7F3EA] dark:hover:bg-[#232C35]";

export function ReturnsSavedViewsControl({
  activeTab,
  getCurrentSnapshot,
  onApply,
  onToast,
}: {
  activeTab: ReturnsReportTab;
  /** Reads the live snapshot (filters + columns) of the active tab. */
  getCurrentSnapshot: () => ReturnsReportViewSnapshot | null;
  onApply: (view: ReturnsReportSavedView) => void;
  onToast?: (msg: string, kind?: "success" | "error" | "warning") => void;
}) {
  const [views, setViews] = useState<ReturnsReportSavedView[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setViews(readSavedViews());
  }, []);

  // Close popovers on outside click.
  useEffect(() => {
    if (!listOpen && !saveOpen) return;
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setListOpen(false);
        setSaveOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [listOpen, saveOpen]);

  const viewsForTab = useMemo(
    () => views.filter((v) => v.tab === activeTab),
    [views, activeTab],
  );

  const handleSave = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed) {
      onToast?.("Enter a name for this view.", "warning");
      return;
    }
    const snapshot = getCurrentSnapshot();
    if (!snapshot) {
      onToast?.("Could not read the current view.", "error");
      return;
    }
    const view: ReturnsReportSavedView = {
      id: makeSavedViewId(),
      name: trimmed,
      tab: activeTab,
      createdAt: new Date().toISOString(),
      snapshot,
    };
    setViews(addSavedView(view));
    setName("");
    setSaveOpen(false);
    onToast?.(`Saved view “${trimmed}”.`, "success");
  }, [name, getCurrentSnapshot, activeTab, onToast]);

  const handleApply = useCallback(
    (view: ReturnsReportSavedView) => {
      setListOpen(false);
      onApply(view);
      onToast?.(`Applied view “${view.name}”.`, "success");
    },
    [onApply, onToast],
  );

  const handleDelete = useCallback(
    (view: ReturnsReportSavedView) => {
      setViews(deleteSavedView(view.id));
      onToast?.(`Deleted view “${view.name}”.`, "warning");
    },
    [onToast],
  );

  return (
    <div ref={containerRef} className="relative flex items-center gap-2">
      {/* Saved views dropdown */}
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            setListOpen((o) => !o);
            setSaveOpen(false);
          }}
          aria-expanded={listOpen}
          aria-haspopup="menu"
          className={BTN}
          title="Saved views"
        >
          <Bookmark className="h-3.5 w-3.5" />
          Views
          {viewsForTab.length > 0 && (
            <span className="ml-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#8A681F] px-1 text-[10px] font-bold text-white dark:bg-[#D6B76E] dark:text-[#1D242C]">
              {viewsForTab.length}
            </span>
          )}
          <ChevronDown className={`h-3.5 w-3.5 transition ${listOpen ? "rotate-180" : ""}`} />
        </button>

        {listOpen && (
          <div
            role="menu"
            className="absolute right-0 top-[calc(100%+6px)] z-30 w-72 overflow-hidden rounded-xl border border-[rgba(138,104,31,0.20)] bg-[#FFFCF7] shadow-xl dark:border-[rgba(214,183,110,0.22)] dark:bg-[#1D242C]"
          >
            <div className="flex items-center justify-between border-b border-[rgba(138,104,31,0.14)] px-3 py-2 dark:border-[rgba(214,183,110,0.16)]">
              <p className="text-[11px] font-bold uppercase tracking-wide text-[#737C86] dark:text-[#7E8894]">
                {TAB_LABEL[activeTab]} views
              </p>
            </div>
            {viewsForTab.length === 0 ? (
              <p className="px-3 py-4 text-xs text-[#737C86] dark:text-[#7E8894]">
                No saved views for {TAB_LABEL[activeTab]} yet. Set up filters and columns, then save
                this view.
              </p>
            ) : (
              <ul className="max-h-72 overflow-auto py-1">
                {viewsForTab.map((v) => (
                  <li
                    key={v.id}
                    className="group flex items-center justify-between gap-2 px-2 py-1.5 hover:bg-[#EFE6D2]/50 dark:hover:bg-[#2A2418]/50"
                  >
                    <button
                      type="button"
                      onClick={() => handleApply(v)}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left"
                      title={`Apply “${v.name}”`}
                    >
                      <Check className="h-3.5 w-3.5 shrink-0 text-[#8A681F] dark:text-[#D6B76E]" />
                      <span className="truncate text-xs font-semibold text-[#171A1E] dark:text-[#F7F3EA]">
                        {v.name}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(v)}
                      className="shrink-0 rounded-lg p-1 text-[#737C86] transition hover:bg-[#F3E5DE] hover:text-[#6C3E34] dark:text-[#7E8894] dark:hover:bg-[#302025] dark:hover:text-[#D7B2A8]"
                      title={`Delete “${v.name}”`}
                      aria-label={`Delete ${v.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Save current view */}
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            setSaveOpen((o) => !o);
            setListOpen(false);
          }}
          aria-expanded={saveOpen}
          className={BTN}
          title="Save current view"
        >
          <BookmarkPlus className="h-3.5 w-3.5" />
          Save view
        </button>

        {saveOpen && (
          <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-72 rounded-xl border border-[rgba(138,104,31,0.20)] bg-[#FFFCF7] p-3 shadow-xl dark:border-[rgba(214,183,110,0.22)] dark:bg-[#1D242C]">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[11px] font-bold uppercase tracking-wide text-[#737C86] dark:text-[#7E8894]">
                Save {TAB_LABEL[activeTab]} view
              </p>
              <button
                type="button"
                onClick={() => setSaveOpen(false)}
                className="rounded-lg p-0.5 text-[#737C86] transition hover:bg-[#EFE6D2] dark:text-[#7E8894] dark:hover:bg-[#2A2418]"
                aria-label="Cancel"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
                if (e.key === "Escape") setSaveOpen(false);
              }}
              placeholder="e.g. Missing Review"
              className="h-9 w-full rounded-lg border border-[rgba(138,104,31,0.18)] bg-[#FFFFFF] px-2.5 text-xs font-medium text-[#171A1E] outline-none focus:border-[#8A681F] dark:border-[rgba(214,183,110,0.18)] dark:bg-[#151A20] dark:text-[#F7F3EA] dark:focus:border-[#D6B76E]"
            />
            <p className="mt-1.5 text-[10px] text-[#737C86] dark:text-[#7E8894]">
              Saves active tab, filters, and visible columns to this browser.
            </p>
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setSaveOpen(false)}
                className="inline-flex h-8 items-center rounded-lg px-3 text-xs font-semibold text-[#4C5661] transition hover:bg-[#EFE6D2] dark:text-[#B8C1CB] dark:hover:bg-[#2A2418]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#8A681F] px-3 text-xs font-bold text-white transition hover:bg-[#75571A] dark:bg-[#D6B76E] dark:text-[#1D242C] dark:hover:bg-[#C7A85F]"
              >
                <Check className="h-3.5 w-3.5" />
                Save
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
