"use client";

import type { ReactNode } from "react";

import { MenorixModuleAppShell } from "@/components/menorix";

import { TaskCenterCommandBar } from "./TaskCenterCommandBar";
import { TaskCenterMobileNav } from "./TaskCenterMobileNav";
import { TASK_CENTER_MAIN_CLASS } from "./task-center-ui";

export function TaskCenterAppShell({
  scopeBar,
  children,
}: {
  scopeBar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <MenorixModuleAppShell
      namespaceClass={`${TASK_CENTER_MAIN_CLASS} task-center-view task-center-app-shell`}
      moduleTitle="Task Center"
      scopeBar={scopeBar}
      sectionNav={[]}
      showSectionTabs={false}
      fullWidth
      hideRail
      mobileNavigation={<TaskCenterMobileNav />}
    >
      <TaskCenterCommandBar />
      {children}
    </MenorixModuleAppShell>
  );
}
