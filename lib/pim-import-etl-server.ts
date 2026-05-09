/**
 * Server-only short calls to Python ETL for PIM chunked import.
 * Browser must use /api/dashboard/products/import/* — never long-hang on ETL directly.
 */

const DEFAULT_ETL_ORIGIN = "http://127.0.0.1:8000";

/**
 * ETL call ceiling for one preview/apply step (chunked work + CSV cache build).
 * Primary scaling is chunking; this is a safety margin for large first-chunk parses.
 */
export const PIM_IMPORT_ETL_TIMEOUT_MS = 120_000;

function etlOrigin(): string {
  return (process.env.ETL_API_ORIGIN?.trim() || DEFAULT_ETL_ORIGIN).replace(/\/$/, "");
}

export type PimEtlPreviewBody = {
  organization_id: string;
  store_id: string;
  upload_id: string;
  row_chunk?: number | null;
  /** Log-only hint; ETL uses persisted `scan_cursor` from `raw_report_uploads.metadata`. */
  scan_data_row_hint?: number | null;
};

export type PimEtlApplyBody = {
  organization_id: string;
  store_id: string;
  upload_id: string;
  confirm?: string;
  row_chunk?: number | null;
  /** When true, imports accepted rows and skips conflicting rows instead of blocking. */
  skip_conflicts?: boolean;
  /** Canonical name — same as skip_conflicts, added for clarity. */
  import_safe_rows_only?: boolean;
};

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; status: number; json: unknown; timedOut: boolean }> {
  const url = `${etlOrigin()}/etl/${path}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PIM_IMPORT_ETL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const json = (await res.json().catch(() => null)) as unknown;
    return { ok: res.ok, status: res.status, json, timedOut: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const aborted = e instanceof Error && (e.name === "AbortError" || msg.includes("aborted"));
    const retryableTransport =
      !aborted &&
      /ConnectionTerminated|connection.*terminated|ECONNRESET|UND_ERR|GOAWAY|socket.*closed|fetch failed/i.test(
        msg,
      );
    if (retryableTransport) {
      const uploadId =
        body && typeof body === "object" && "upload_id" in body
          ? String((body as { upload_id?: string }).upload_id ?? "")
          : "";
      return {
        ok: false,
        status: 503,
        json: {
          ok: false,
          retryable: true,
          error: "etl_connection_lost",
          message: msg,
          import_job_id: uploadId || undefined,
        },
        timedOut: false,
      };
    }
    return {
      ok: false,
      status: aborted ? 504 : 503,
      json: {
        ok: false,
        error: aborted ? "etl_step_timeout" : "etl_unreachable",
        message: aborted
          ? `ETL step exceeded ${PIM_IMPORT_ETL_TIMEOUT_MS}ms — retry preview-step.`
          : e instanceof Error
            ? e.message
            : "ETL unreachable",
        timed_out: aborted,
      },
      timedOut: aborted,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function pimEtlPreviewStep(body: PimEtlPreviewBody) {
  return postJson("pim-import/preview-step", body);
}

export async function pimEtlRetryPreview(body: PimEtlPreviewBody) {
  return postJson("pim-import/retry-preview", body);
}

export async function pimEtlPreviewStatus(body: { organization_id: string; store_id: string; upload_id: string }) {
  return postJson("pim-import/preview-status", body);
}

export async function pimEtlApplyStep(body: PimEtlApplyBody) {
  return postJson("pim-import/apply-step", body);
}
