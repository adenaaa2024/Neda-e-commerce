import { TaskCenterDetailView } from "@/components/task-center/TaskCenterDetailView";

export default async function TaskCenterDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TaskCenterDetailView taskId={id} />;
}
