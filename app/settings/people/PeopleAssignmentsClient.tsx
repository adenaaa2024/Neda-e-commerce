"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Save } from "lucide-react";
import { useUserRole } from "@/components/UserRoleContext";
import {
  responsiveFormInput,
  responsiveFormSelect,
  responsivePageInner,
  responsivePageNarrow,
  responsivePageOuter,
} from "@/lib/responsive-page-shell";
import type {
  AssignableGroupForPeopleRow,
  AssignablePositionRow,
  ManagerCandidateRow,
  PersonForAssignmentRow,
  ProfilePositionAssignmentDisplay,
} from "@/lib/people-org-chart/people-assignment-types";
import {
  assignProfilePositionFromSettingsAction,
  getPeopleAssignmentsPageAccessAction,
  getProfilePositionAssignmentStateAction,
  listAssignableGroupsForPeopleAction,
  listAssignablePositionsForOrgAction,
  listManagerCandidatesForOrgAction,
  listPeopleForAssignmentsAction,
} from "./people-assignments-actions";

const LABEL = "mb-2 block text-sm font-medium leading-none";
const BTN_PRIMARY =
  "inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow transition hover:bg-primary/90 disabled:opacity-50";

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function toDateTimeLocalValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultStartsAtLocal(): string {
  return toDateTimeLocalValue(new Date().toISOString());
}

function displayPerson(row: PersonForAssignmentRow): string {
  const name = row.full_name.trim() || "Unnamed user";
  if (row.email) return `${name} (${row.email})`;
  return name;
}

function displayManager(row: ManagerCandidateRow): string {
  const name = row.full_name.trim() || "Unnamed user";
  if (row.email) return `${name} (${row.email})`;
  return name;
}

function displayGroup(row: AssignableGroupForPeopleRow): string {
  const name = row.name.trim() || row.key;
  return `${name} (${row.group_type})`;
}

function displayPosition(row: AssignablePositionRow): string {
  const title = row.title.trim() || row.code;
  if (row.code && row.title && row.code !== row.title) {
    return `${title} (${row.code})`;
  }
  return title || row.code;
}

function AssignmentSummaryCard({
  title,
  assignment,
}: {
  title: string;
  assignment: ProfilePositionAssignmentDisplay | null;
}) {
  if (!assignment) {
    return (
      <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">No current assignment.</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <dl className="mt-3 space-y-2 text-sm">
        <div>
          <dt className="text-muted-foreground">Position</dt>
          <dd className="font-medium text-foreground">
            {assignment.position_title || assignment.position_code || "—"}
            {assignment.position_code ? (
              <span className="ml-1 font-normal text-muted-foreground">
                ({assignment.position_code})
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Group / team</dt>
          <dd>{assignment.group_name ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Manager</dt>
          <dd>
            {assignment.manager_full_name
              ? assignment.manager_email
                ? `${assignment.manager_full_name} (${assignment.manager_email})`
                : assignment.manager_full_name
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">From</dt>
          <dd>{formatDateTime(assignment.starts_at)}</dd>
        </div>
        {assignment.notes ? (
          <div>
            <dt className="text-muted-foreground">Notes</dt>
            <dd className="whitespace-pre-wrap">{assignment.notes}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

export default function PeopleAssignmentsClient() {
  const { organizationId: workspaceOrganizationId, profileLoading } = useUserRole();
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState<"not_authenticated" | "forbidden" | null>(
    null,
  );
  const [organizationId, setOrganizationId] = useState<string | null>(null);

  const [people, setPeople] = useState<PersonForAssignmentRow[]>([]);
  const [positions, setPositions] = useState<AssignablePositionRow[]>([]);
  const [groups, setGroups] = useState<AssignableGroupForPeopleRow[]>([]);
  const [managers, setManagers] = useState<ManagerCandidateRow[]>([]);

  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [positionId, setPositionId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [managerProfileId, setManagerProfileId] = useState("");
  const [startsAtLocal, setStartsAtLocal] = useState(defaultStartsAtLocal);
  const [notes, setNotes] = useState("");

  const [currentAssignment, setCurrentAssignment] =
    useState<ProfilePositionAssignmentDisplay | null>(null);
  const [history, setHistory] = useState<ProfilePositionAssignmentDisplay[]>([]);
  const [stateLoading, setStateLoading] = useState(false);

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const orgHint = workspaceOrganizationId;

  const loadCatalog = useCallback(async () => {
    const [access, peopleRes, positionsRes, groupsRes] = await Promise.all([
      getPeopleAssignmentsPageAccessAction(orgHint),
      listPeopleForAssignmentsAction(orgHint),
      listAssignablePositionsForOrgAction(orgHint),
      listAssignableGroupsForPeopleAction(orgHint),
    ]);

    setAccessDenied(access.accessDenied);
    setOrganizationId(access.organizationId);

    if (peopleRes.ok) setPeople(peopleRes.rows);
    else setError(peopleRes.error);

    if (positionsRes.ok) setPositions(positionsRes.rows);
    else setError(positionsRes.error);

    if (groupsRes.ok) setGroups(groupsRes.rows);
    else setError(groupsRes.error);

    setLoading(false);
  }, [orgHint]);

  const loadAssignmentState = useCallback(
    async (profileId: string) => {
      if (!profileId) {
        setCurrentAssignment(null);
        setHistory([]);
        setManagers([]);
        setPositionId("");
        setGroupId("");
        setManagerProfileId("");
        setStartsAtLocal(defaultStartsAtLocal());
        setNotes("");
        return;
      }

      setStateLoading(true);
      setError(null);
      const [stateRes, managersRes] = await Promise.all([
        getProfilePositionAssignmentStateAction(profileId, orgHint),
        listManagerCandidatesForOrgAction(profileId, orgHint),
      ]);
      setStateLoading(false);

      if (!stateRes.ok) {
        setError(stateRes.error);
        setCurrentAssignment(null);
        setHistory([]);
        return;
      }

      if (managersRes.ok) setManagers(managersRes.rows);
      else setError(managersRes.error);

      setCurrentAssignment(stateRes.state.current);
      setHistory(stateRes.state.history);

      const current = stateRes.state.current;
      if (current) {
        setPositionId(current.position_id);
        setGroupId(current.group_id ?? "");
        setManagerProfileId(current.manager_profile_id ?? "");
        setStartsAtLocal(defaultStartsAtLocal());
        setNotes("");
      } else {
        setPositionId("");
        setGroupId("");
        setManagerProfileId("");
        setStartsAtLocal(defaultStartsAtLocal());
        setNotes("");
      }
    },
    [orgHint],
  );

  function onPersonChange(nextProfileId: string) {
    setSelectedProfileId(nextProfileId);
    void loadAssignmentState(nextProfileId);
  }

  useEffect(() => {
    if (profileLoading) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      await loadCatalog();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [profileLoading, loadCatalog]);

  const selectedPerson = useMemo(
    () => people.find((p) => p.id === selectedProfileId) ?? null,
    [people, selectedProfileId],
  );

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setMessage(null);

    if (!selectedProfileId) {
      setSaving(false);
      setError("Select a person.");
      return;
    }
    if (!positionId) {
      setSaving(false);
      setError("Select a position.");
      return;
    }
    if (!startsAtLocal) {
      setSaving(false);
      setError("Start date is required.");
      return;
    }
    if (managerProfileId && managerProfileId === selectedProfileId) {
      setSaving(false);
      setError("Manager cannot be the same person.");
      return;
    }

    const startsAtIso = new Date(startsAtLocal).toISOString();
    if (currentAssignment?.starts_at) {
      const currentStart = Date.parse(currentAssignment.starts_at);
      const nextStart = Date.parse(startsAtIso);
      if (!Number.isNaN(currentStart) && !Number.isNaN(nextStart) && nextStart < currentStart) {
        setSaving(false);
        setError("Start date cannot be before the current assignment start date.");
        return;
      }
    }

    const res = await assignProfilePositionFromSettingsAction({
      organization_id: orgHint,
      profile_id: selectedProfileId,
      position_id: positionId,
      group_id: groupId || null,
      manager_profile_id: managerProfileId || null,
      starts_at: startsAtIso,
      notes: notes.trim() || null,
    });

    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }

    setCurrentAssignment(res.state.current);
    setHistory(res.state.history);
    setMessage("Assignment saved.");
    setNotes("");
    setStartsAtLocal(defaultStartsAtLocal());
  }

  if (loading) {
    return (
      <div className={responsivePageOuter}>
        <div className={`${responsivePageInner} flex min-h-[40vh] items-center justify-center`}>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 shrink-0 animate-spin" />
            Loading people assignments...
          </div>
        </div>
      </div>
    );
  }

  if (accessDenied) {
    return (
      <div className={responsivePageOuter}>
        <div className={responsivePageNarrow}>
          <h1 className="text-lg font-semibold text-foreground">People assignments</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {accessDenied === "not_authenticated"
              ? "You must be signed in to view this page."
              : "You do not have access to manage people assignments."}
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
          <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            People assignments
          </h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Assign people to positions, teams, and managers for the organization chart.
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

        {positions.length === 0 ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-950 dark:text-amber-100">
            No active positions are defined yet. Positions are managed in Platform Access catalog.
          </div>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <form
            onSubmit={onSave}
            className="space-y-5 rounded-xl border border-border bg-card p-4 shadow-sm sm:p-6"
          >
            <h2 className="text-base font-semibold text-foreground">New assignment</h2>

            <div>
              <label className={LABEL} htmlFor="people-assign-person">
                Person
              </label>
              <select
                id="people-assign-person"
                className={responsiveFormSelect}
                value={selectedProfileId}
                onChange={(e) => onPersonChange(e.target.value)}
              >
                <option value="">Select a person…</option>
                {people.map((row) => (
                  <option key={row.id} value={row.id}>
                    {displayPerson(row)}
                  </option>
                ))}
              </select>
            </div>

            {selectedPerson ? (
              <p className="text-xs text-muted-foreground">
                Selected: {displayPerson(selectedPerson)}
                {selectedPerson.role_name || selectedPerson.role_key
                  ? ` · ${selectedPerson.role_name ?? selectedPerson.role_key}`
                  : ""}
              </p>
            ) : null}

            <div>
              <label className={LABEL} htmlFor="people-assign-position">
                Position
              </label>
              <select
                id="people-assign-position"
                className={responsiveFormSelect}
                value={positionId}
                onChange={(e) => setPositionId(e.target.value)}
                required
                disabled={positions.length === 0}
              >
                <option value="">Select a position…</option>
                {positions.map((row) => (
                  <option key={row.id} value={row.id}>
                    {displayPosition(row)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className={LABEL} htmlFor="people-assign-group">
                Group / team (optional)
              </label>
              <select
                id="people-assign-group"
                className={responsiveFormSelect}
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
              >
                <option value="">No group</option>
                {groups.map((row) => (
                  <option key={row.id} value={row.id}>
                    {displayGroup(row)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className={LABEL} htmlFor="people-assign-manager">
                Manager (optional)
              </label>
              <select
                id="people-assign-manager"
                className={responsiveFormSelect}
                value={managerProfileId}
                onChange={(e) => setManagerProfileId(e.target.value)}
                disabled={!selectedProfileId}
              >
                <option value="">No manager</option>
                {managers.map((row) => (
                  <option key={row.id} value={row.id}>
                    {displayManager(row)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className={LABEL} htmlFor="people-assign-starts-at">
                Starts at
              </label>
              <input
                id="people-assign-starts-at"
                type="datetime-local"
                className={responsiveFormInput}
                value={startsAtLocal}
                onChange={(e) => setStartsAtLocal(e.target.value)}
                required
              />
            </div>

            <div>
              <label className={LABEL} htmlFor="people-assign-notes">
                Notes (optional)
              </label>
              <textarea
                id="people-assign-notes"
                className={`${responsiveFormInput} min-h-[96px] py-2`}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={2000}
                rows={4}
              />
            </div>

            <button type="submit" className={BTN_PRIMARY} disabled={saving || positions.length === 0}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save assignment
            </button>
          </form>

          <div className="space-y-4">
            {stateLoading ? (
              <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading assignment state…
              </div>
            ) : (
              <AssignmentSummaryCard title="Current assignment" assignment={currentAssignment} />
            )}
          </div>
        </div>

        <section className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-foreground">Assignment history</h2>
          {!selectedProfileId ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Select a person to view assignment history.
            </p>
          ) : history.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No assignment history yet.</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="px-2 py-2 font-medium">Position</th>
                    <th className="px-2 py-2 font-medium">Group / Team</th>
                    <th className="px-2 py-2 font-medium">Manager</th>
                    <th className="px-2 py-2 font-medium">From</th>
                    <th className="px-2 py-2 font-medium">To</th>
                    <th className="px-2 py-2 font-medium">Notes</th>
                    <th className="px-2 py-2 font-medium">Assigned by</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((row) => (
                    <tr key={row.id} className="border-b border-border/70 align-top">
                      <td className="px-2 py-2">
                        {row.position_title || row.position_code || "—"}
                      </td>
                      <td className="px-2 py-2">{row.group_name ?? "—"}</td>
                      <td className="px-2 py-2">{row.manager_full_name ?? "—"}</td>
                      <td className="px-2 py-2 whitespace-nowrap">{formatDateTime(row.starts_at)}</td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        {row.ends_at ? formatDateTime(row.ends_at) : "Current"}
                      </td>
                      <td className="px-2 py-2 max-w-[220px] whitespace-pre-wrap">
                        {row.notes ?? "—"}
                      </td>
                      <td className="px-2 py-2">
                        {row.assigned_by_full_name
                          ? row.assigned_by_email
                            ? `${row.assigned_by_full_name} (${row.assigned_by_email})`
                            : row.assigned_by_full_name
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
