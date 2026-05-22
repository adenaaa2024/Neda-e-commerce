/**
 * NEXT-UNIVERSAL-RESOLVER-08 — Structured JSON line for log drains (stdout only; no files by default).
 */
export function emitResolverIncrementalObservabilityJsonLine(payload: Record<string, unknown>): void {
  if (!isObservabilityJsonLogEnabled()) return;
  try {
    console.log(
      JSON.stringify({
        ...payload,
        ts: new Date().toISOString(),
        schema: "resolver_incremental_observability_v1",
      }),
    );
  } catch {
    /* ignore */
  }
}

export function isObservabilityJsonLogEnabled(): boolean {
  return (
    process.env.RESOLVER_INCREMENTAL_OBSERVABILITY_JSON_LOG === "true" ||
    process.env.RESOLVER_INCREMENTAL_OBSERVABILITY_JSON_LOG === "1"
  );
}
