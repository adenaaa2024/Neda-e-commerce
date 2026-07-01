"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Archive, Loader2, Pencil, Plus, Save, X } from "lucide-react";
import { useUserRole } from "@/components/UserRoleContext";
import {
  responsiveFormInput,
  responsivePageInner,
  responsivePageNarrow,
  responsivePageOuter,
} from "@/lib/responsive-page-shell";
import {
  archivePositionSettingsAction,
  createPositionSettingsAction,
  getPositionsSettingsPageAccessAction,
  listPositionsForOrgSettingsAction,
  updatePositionSettingsAction,
  type PositionSettingsRow,
} from "./positions-settings-actions";

const LABEL = "mb-2 block text-sm font-medium leading-none";
const BTN_PRIMARY =
  "inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow transition hover:bg-primary/90 disabled:opacity-50";
const BTN_SECONDARY =
  "inline-flex items-center justify-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium transition hover:bg-accent disabled:opacity-50";

function formatTs(iso: string): string {
  if (!iso?.trim()) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function PositionStatusBadge({ isActive }: { isActive: boolean }) {
  return (
    <span
      className={[
        "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium",
        isActive
          ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-700/50 dark:bg-emerald-950/40 dark:text-emerald-300"
          : "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700/50 dark:bg-slate-900/40 dark:text-slate-400",
      ].join(" ")}
    >
      {isActive ? "Active" : "Inactive"}
    </span>
  );
}

export default function PositionsSettingsClient() {
  const { organizationId: workspaceOrganizationId, profileLoading } = useUserRole();

  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState<"not_authenticated" | "forbidden" | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [positions, setPositions] = useState<PositionSettingsRow[]>([]);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [positionModal, setPositionModal] = useState<"create" | PositionSettingsRow | null>(null);
  const [pCode, setPCode] = useState("");
  const [pTitle, setPTitle] = useState("");
  const [pDesc, setPDesc] = useState("");
  const [pLevel, setPLevel] = useState("");
  const [pActive, setPActive] = useState(true);
  const [positionSaving, setPositionSaving] = useState(false);
  const [positionArchiveBusy, setPositionArchiveBusy] = useState(false);

  const orgHint = workspaceOrganizationId ?? undefined;

  const loadPositions = useCallback(async () => {
    setPositionsLoading(true);
    const res = await listPositionsForOrgSettingsAction(orgHint);
    setPositionsLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setPositions(res.rows);
  }, [orgHint]);

  useEffect(() => {
    if (profileLoading) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const access = await getPositionsSettingsPageAccessAction(orgHint);
      if (cancelled) return;
      setAccessDenied(access.accessDenied);
      setOrganizationId(access.organizationId);
      if (access.accessDenied) {
        setLoading(false);
        return;
      }
      await loadPositions();
      if (cancelled) return;
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [profileLoading, orgHint, loadPositions]);

  function openCreatePosition() {
    setPCode("");
    setPTitle("");
    setPDesc("");
    setPLevel("");
    setPActive(true);
    setError(null);
    setMessage(null);
    setPositionModal("create");
  }

  function openEditPosition(row: PositionSettingsRow) {
    setPCode(row.code);
    setPTitle(row.title);
    setPDesc(row.description ?? "");
    setPLevel(row.level != null ? String(row.level) : "");
    setPActive(row.is_active);
    setError(null);
    setMessage(null);
    setPositionModal(row);
  }

  async function handleArchivePosition() {
    if (positionModal === "create" || !positionModal) return;
    if (
      !window.confirm(
        `Archive position «${positionModal.title}» (${positionModal.code})? It will be deactivated and hidden from this list.`,
      )
    ) {
      return;
    }
    setPositionArchiveBusy(true);
    try {
      const res = await archivePositionSettingsAction(positionModal.id, orgHint);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setMessage("Position archived.");
      setPositionModal(null);
      await loadPositions();
    } finally {
      setPositionArchiveBusy(false);
    }
  }

  async function submitPosition(e: React.FormEvent) {
    e.preventDefault();
    setPositionSaving(true);
    setError(null);
    setMessage(null);
    try {
      if (positionModal === "create") {
        const res = await createPositionSettingsAction({
          organization_id: orgHint,
          code: pCode,
          title: pTitle,
          description: pDesc || null,
          level: pLevel.trim() === "" ? null : pLevel,
          is_active: pActive,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setMessage("Position created.");
      } else if (positionModal) {
        const res = await updatePositionSettingsAction(positionModal.id, {
          organization_id: orgHint,
          code: pCode,
          title: pTitle,
          description: pDesc || null,
          level: pLevel.trim() === "" ? null : pLevel,
          is_active: pActive,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setMessage("Position updated.");
      }
      setPositionModal(null);
      await loadPositions();
    } finally {
      setPositionSaving(false);
    }
  }

  if (loading) {
    return (
      <div className={responsivePageOuter}>
        <div className={`${responsivePageInner} flex min-h-[40vh] items-center justify-center`}>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 shrink-0 animate-spin" />
            Loading positions...
          </div>
        </div>
      </div>
    );
  }

  if (accessDenied) {
    return (
      <div className={responsivePageOuter}>
        <div className={responsivePageNarrow}>
          <h1 className="text-lg font-semibold text-foreground">Positions</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {accessDenied === "not_authenticated"
              ? "You must be signed in to view this page."
              : "You do not have access to manage positions."}
          </p>
          <Link
            href="/settings"
            className="mt-4 inline-block text-sm font-medium text-primary hover:underline"
          >
            ← Back to Settings
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={responsivePageOuter}>
      <div className={`${responsivePageInner} space-y-6`}>
        <header className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">Positions</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Define job positions used for people assignments and the organization chart.
          </p>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Positions are job titles used for reporting structure. They do not grant system
            permissions.
          </p>
          {organizationId ? (
            <p className="text-xs text-muted-foreground">
              Effective organization:{" "}
              <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                {organizationId}
              </code>
            </p>
          ) : null}
          <Link
            href="/settings"
            className="inline-block text-xs font-medium text-primary hover:underline"
          >
            ← Back to Settings
          </Link>
        </header>

        {error ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {message ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-900 dark:text-emerald-100">
            {message}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Manage job titles for your company. Assign people in{" "}
            <Link href="/settings/people" className="font-medium text-primary hover:underline">
              People assignments
            </Link>
            .
          </p>
          <button type="button" className={BTN_PRIMARY} onClick={openCreatePosition}>
            <Plus className="h-4 w-4" />
            New position
          </button>
        </div>

        <div className="rounded-xl border border-border bg-card shadow-sm">
          {positionsLoading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              Loading positions…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] table-fixed border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2.5">Title</th>
                    <th className="px-3 py-2.5">Code</th>
                    <th className="w-[80px] px-3 py-2.5">Level</th>
                    <th className="w-[100px] px-3 py-2.5">Status</th>
                    <th className="px-3 py-2.5">Description</th>
                    <th className="px-3 py-2.5">Updated</th>
                    <th className="px-3 py-2.5">Created</th>
                    <th className="w-[100px] px-3 py-2.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-12 text-center text-sm text-muted-foreground">
                        No positions defined yet. Create your first position to use in people
                        assignments.
                      </td>
                    </tr>
                  ) : (
                    positions.map((row) => (
                      <tr key={row.id} className="border-b border-border last:border-0">
                        <td className="px-3 py-2 align-middle font-medium">{row.title}</td>
                        <td className="px-3 py-2 align-middle font-mono text-xs text-muted-foreground">
                          {row.code}
                        </td>
                        <td className="px-3 py-2 align-middle text-xs text-muted-foreground">
                          {row.level != null ? row.level : "—"}
                        </td>
                        <td className="px-3 py-2 align-middle">
                          <PositionStatusBadge isActive={row.is_active} />
                        </td>
                        <td className="px-3 py-2 align-middle text-xs text-muted-foreground">
                          <span className="line-clamp-2" title={row.description ?? undefined}>
                            {row.description ?? "—"}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 align-middle text-xs text-muted-foreground">
                          {formatTs(row.updated_at)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 align-middle text-xs text-muted-foreground">
                          {formatTs(row.created_at)}
                        </td>
                        <td className="px-3 py-2 align-middle text-right">
                          <button
                            type="button"
                            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label="Edit position"
                            onClick={() => openEditPosition(row)}
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {positionModal ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-foreground/40 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-xl"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold">
                {positionModal === "create" ? "New position" : "Edit position"}
              </h2>
              <button
                type="button"
                className="rounded-md p-1 text-muted-foreground hover:bg-muted"
                onClick={() => setPositionModal(null)}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={(e) => void submitPosition(e)} className="space-y-4">
              <div>
                <label className={LABEL} htmlFor="pos-code">
                  Code <span className="text-destructive">*</span>
                </label>
                <input
                  id="pos-code"
                  className={responsiveFormInput}
                  value={pCode}
                  onChange={(e) => setPCode(e.target.value)}
                  required
                  autoComplete="off"
                />
              </div>
              <div>
                <label className={LABEL} htmlFor="pos-title">
                  Title <span className="text-destructive">*</span>
                </label>
                <input
                  id="pos-title"
                  className={responsiveFormInput}
                  value={pTitle}
                  onChange={(e) => setPTitle(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className={LABEL} htmlFor="pos-desc">
                  Description
                </label>
                <textarea
                  id="pos-desc"
                  className={`${responsiveFormInput} min-h-[80px] py-2`}
                  value={pDesc}
                  onChange={(e) => setPDesc(e.target.value)}
                  maxLength={300}
                />
              </div>
              <div>
                <label className={LABEL} htmlFor="pos-level">
                  Level
                </label>
                <input
                  id="pos-level"
                  type="number"
                  className={responsiveFormInput}
                  value={pLevel}
                  onChange={(e) => setPLevel(e.target.value)}
                  placeholder="Optional"
                  step={1}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Optional hierarchy level for org chart ordering.
                </p>
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={pActive}
                  onChange={(e) => setPActive(e.target.checked)}
                />
                Active
              </label>
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                <div className="min-w-0">
                  {positionModal !== "create" ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-2 rounded-md border border-destructive/50 bg-background px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                      disabled={positionArchiveBusy || positionSaving}
                      onClick={() => void handleArchivePosition()}
                    >
                      {positionArchiveBusy ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Archive className="h-4 w-4" />
                      )}
                      Archive position
                    </button>
                  ) : null}
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    className={BTN_SECONDARY}
                    onClick={() => setPositionModal(null)}
                    disabled={positionSaving || positionArchiveBusy}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className={BTN_PRIMARY}
                    disabled={positionSaving || positionArchiveBusy}
                  >
                    {positionSaving ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    Save
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
