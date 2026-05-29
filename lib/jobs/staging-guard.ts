import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";

export function assertAsyncJobsStagingOnly(): void {
  loadEnvLocalIntoProcess();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const ref = refFromSupabaseUrl(url);
  const expected = getStagingProjectRef({ loadEnv: false });
  if (ref !== STAGING_REF || expected !== STAGING_REF) {
    throw new Error(
      `BLOCKED: async jobs phase 1 is staging-only (expected ${STAGING_REF}, got url ref ${ref ?? "null"}).`,
    );
  }
}

export { STAGING_REF as ASYNC_JOBS_STAGING_REF };
