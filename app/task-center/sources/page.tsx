import { Suspense } from "react";

import { TaskCenterSourcesView } from "@/components/task-center/TaskCenterSourcesView";

export default function TaskCenterSourcesPage() {
  return (
    <Suspense fallback={null}>
      <TaskCenterSourcesView />
    </Suspense>
  );
}
