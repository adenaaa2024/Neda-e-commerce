export type PeopleAssignmentAccessDenied = "not_authenticated" | "forbidden";

export type PeopleAssignmentsPageAccess = {
  accessDenied: PeopleAssignmentAccessDenied | null;
  organizationId: string | null;
  actorProfileId: string | null;
};

export type PersonForAssignmentRow = {
  id: string;
  full_name: string;
  email: string | null;
  role_key: string | null;
  role_name: string | null;
  photo_url: string | null;
};

export type AssignablePositionRow = {
  id: string;
  code: string;
  title: string;
};

export type AssignableGroupForPeopleRow = {
  id: string;
  name: string;
  key: string;
  group_type: string;
};

export type ManagerCandidateRow = {
  id: string;
  full_name: string;
  email: string | null;
};

export type ProfilePositionAssignmentDisplay = {
  id: string;
  position_id: string;
  position_code: string;
  position_title: string;
  group_id: string | null;
  group_name: string | null;
  group_type: string | null;
  manager_profile_id: string | null;
  manager_full_name: string | null;
  manager_email: string | null;
  starts_at: string;
  ends_at: string | null;
  notes: string | null;
  assigned_by: string | null;
  assigned_by_full_name: string | null;
  assigned_by_email: string | null;
};

export type ProfilePositionAssignmentState = {
  current: ProfilePositionAssignmentDisplay | null;
  history: ProfilePositionAssignmentDisplay[];
};

export type AssignProfilePositionInput = {
  organization_id?: string | null;
  profile_id: string;
  position_id: string;
  group_id?: string | null;
  manager_profile_id?: string | null;
  starts_at: string;
  notes?: string | null;
};
