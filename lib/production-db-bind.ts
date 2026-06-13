/**
 * Bind process env to original/live Supabase for approved production scripts only.
 */
import { refFromSupabaseUrl } from "./staging-project-ref";

export const PRODUCTION_REF = "kxsvedvpjldygtdbylsy";

export function bindProductionSupabaseEnv(): { ref: string; url: string } {
  const url =
    process.env.ORIGINAL_SUPABASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    "";
  const key =
    process.env.ORIGINAL_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    "";
  const ref = refFromSupabaseUrl(url);
  if (ref !== PRODUCTION_REF) {
    throw new Error(`Production bind refused: URL ref ${ref ?? "missing"} !== ${PRODUCTION_REF}`);
  }
  if (!key) throw new Error("ORIGINAL_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY required");
  // Bracket access avoids Next/webpack inlining NEXT_PUBLIC_* as literals (invalid assignment).
  const env = process.env as Record<string, string | undefined>;
  env.NEXT_PUBLIC_SUPABASE_URL = url;
  env.SUPABASE_URL = url;
  env.SUPABASE_SERVICE_ROLE_KEY = key;
  return { ref, url };
}

export function productionPostgresUrl(): string {
  const original = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (original.includes(PRODUCTION_REF)) return original;
  const direct = process.env.DIRECT_POSTGRES_URL?.trim() ?? "";
  if (direct.includes(PRODUCTION_REF)) return direct;
  throw new Error(
    `ORIGINAL_DIRECT_POSTGRES_URL or DIRECT_POSTGRES_URL must target ${PRODUCTION_REF}`,
  );
}
