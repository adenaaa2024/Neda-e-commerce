"use server";

import { supabaseServer } from "@/lib/supabase-server";

export async function updateExpectedPackageScannedCount(input: {
  id: string;
  actualScannedCount: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const id = input.id.trim();
  if (!id) return { ok: false, error: "Missing expected package id." };

  const actualScannedCount = Number.isFinite(input.actualScannedCount)
    ? Math.max(0, Math.trunc(input.actualScannedCount))
    : 0;

  const { error } = await supabaseServer
    .from("expected_packages")
    .update({ actual_scanned_count: actualScannedCount })
    .eq("id", id);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
