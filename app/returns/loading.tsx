/**
 * Route-level fallback — only shown on first load of the /returns segment.
 * Keep this minimal: a full-page spinner during refetch causes visible blanking.
 */
export default function ReturnsLoading() {
  return (
    <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-sky-500" />
      <span>Loading…</span>
    </div>
  );
}
