import { Suspense } from "react";

import { TaskCenterMyTasksView } from "@/components/task-center/TaskCenterMyTasksView";

export default function TaskCenterMyPage() {
  return (
    <Suspense fallback={null}>
      <TaskCenterMyTasksView />
    </Suspense>
  );
}
