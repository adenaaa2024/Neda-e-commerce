"use client";

import { ChevronRight, Users } from "lucide-react";

import type { TaskCenterOrgPeopleTreeNode } from "@/lib/task-center/task-center-people-org-display-contract";
import {
  formatTaskCenterOrgPeopleAssignmentLabel,
  formatTaskCenterOrgPeopleDisplayName,
  formatTaskCenterOrgPeopleGroupLabel,
  hasTaskCenterOrgPeopleCurrentAssignment,
} from "@/lib/task-center/task-center-people-org-display-contract";

import {
  TASK_CENTER_CARD_ACTIVE_CLASS,
  TASK_CENTER_CARD_CLASS,
  TASK_CENTER_MUTED,
} from "./task-center-ui";

function PeopleTreeNode({
  node,
  depth,
  selectedProfileId,
  onSelect,
}: {
  node: TaskCenterOrgPeopleTreeNode;
  depth: number;
  selectedProfileId: string | null;
  onSelect: (profileId: string) => void;
}) {
  const isSelected = selectedProfileId === node.profile_id;
  const displayName = formatTaskCenterOrgPeopleDisplayName(node.full_name, node.email);
  const assignmentLabel = formatTaskCenterOrgPeopleAssignmentLabel(node);
  const hasAssignment = hasTaskCenterOrgPeopleCurrentAssignment(node);
  const groupLabel = formatTaskCenterOrgPeopleGroupLabel(node.group_name, node.group_type);
  const childCount = node.children.length;

  return (
    <li className="list-none">
      <div className={depth > 0 ? "sm:pl-4" : ""}>
        <button
          type="button"
          aria-pressed={isSelected}
          onClick={() => onSelect(node.profile_id)}
          className={`${isSelected ? TASK_CENTER_CARD_ACTIVE_CLASS : TASK_CENTER_CARD_CLASS} w-full p-3 text-left transition hover:shadow-sm sm:p-4`}
        >
          <div className="flex items-start gap-2">
            <ChevronRight
              className={`mt-0.5 h-4 w-4 shrink-0 ${TASK_CENTER_MUTED} ${isSelected ? "rotate-90" : ""}`}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="break-words font-semibold leading-snug">{displayName}</p>
              {hasAssignment ? (
                <p className={`mt-0.5 text-xs ${TASK_CENTER_MUTED}`}>{assignmentLabel}</p>
              ) : (
                <span className="task-center-text-secondary mt-1 inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium">
                  {assignmentLabel}
                </span>
              )}
              {groupLabel ? (
                <p className="task-center-text-secondary mt-1 text-xs">{groupLabel}</p>
              ) : null}
              {childCount > 0 ? (
                <p className="task-center-text-secondary mt-2 inline-flex items-center gap-1 text-[11px]">
                  <Users className={`h-3 w-3 ${TASK_CENTER_MUTED}`} aria-hidden />
                  {childCount} direct report{childCount === 1 ? "" : "s"}
                </p>
              ) : null}
            </div>
          </div>
        </button>
      </div>

      {node.children.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {node.children.map((child) => (
            <PeopleTreeNode
              key={child.profile_id}
              node={child}
              depth={depth + 1}
              selectedProfileId={selectedProfileId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function TaskCenterOrgPeopleTree({
  tree,
  selectedProfileId,
  onSelect,
}: {
  tree: TaskCenterOrgPeopleTreeNode[];
  selectedProfileId: string | null;
  onSelect: (profileId: string) => void;
}) {
  return (
    <ul className="space-y-2">
      {tree.map((node) => (
        <PeopleTreeNode
          key={node.profile_id}
          node={node}
          depth={0}
          selectedProfileId={selectedProfileId}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}
