/**
 * Read-only probe for IMPORT-API-09A audit artifacts (no credentials logged).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

function loadEnvLocal(): void {
  const p = join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const uploadId = process.argv[2] ?? "199be41a-20ab-4823-91b6-fc4335794235";
  const c = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await c
    .from("raw_report_uploads")
    .select("id, status, report_type, file_name, metadata")
    .eq("id", uploadId)
    .maybeSingle();
  if (error) throw error;
  const sr = (data?.metadata as { source_run?: Record<string, unknown> } | null)?.source_run;
  console.log(
    JSON.stringify(
      {
        upload_id: data?.id,
        status: data?.status,
        report_type: data?.report_type,
        file_name: data?.file_name,
        source_run: sr
          ? {
              source_run_id: sr.source_run_id,
              operation: sr.operation,
              report_type: sr.report_type,
              state: sr.state,
              external_ids: sr.external_ids,
              archive: sr.archive,
              attempt: sr.attempt,
            }
          : null,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
