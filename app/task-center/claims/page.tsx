import { Suspense } from "react";

import { TaskCenterClaimsQueueView } from "@/components/task-center/TaskCenterClaimsQueueView";

export default function TaskCenterClaimsPage() {
  return (
    <Suspense fallback={null}>
      <TaskCenterClaimsQueueView />
    </Suspense>
  );
}
