/** Task Center route matching for ERP sidebar + cross-module links. */

import { normalizeAppPath } from "./claims-hub-routes";

/** True for any in-app Task Center screen (standalone module — not Claims hub). */
export function isTaskCenterRoute(pathname: string): boolean {
  const path = normalizeAppPath(pathname);
  return path === "/task-center" || path.startsWith("/task-center/");
}

export function isTaskCenterSidebarActive(pathname: string): boolean {
  return isTaskCenterRoute(pathname);
}
