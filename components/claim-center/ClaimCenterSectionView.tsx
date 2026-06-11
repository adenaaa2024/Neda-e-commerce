"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import type { ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";

import { ClaimCenterListTable } from "./ClaimCenterListTable";
import { ClaimCenterMobileCards } from "./ClaimCenterMobileCards";
import { ClaimCenterPageShell } from "./ClaimCenterPageShell";
import { useClaimCenter } from "./ClaimCenterRootClient";

type Props = {
  title: string;
  description: string;
  apiPath: string;
  extraParams?: Record<string, string>;
  itemsKey?: string;
  banner?: React.ReactNode;
};

export function ClaimCenterSectionView({
  title,
  description,
  apiPath,
  extraParams,
  itemsKey = "items",
  banner,
}: Props) {
  const { fetchJson, setSelectedRow, storeId } = useClaimCenter();
  const [rows, setRows] = useState<ClaimCenterV1Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<Record<string, unknown>>(apiPath, { limit: "100", ...extraParams });
      const items = (data[itemsKey] ?? data.items ?? []) as ClaimCenterV1Row[];
      setRows(items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [apiPath, extraParams, fetchJson, itemsKey]);

  useEffect(() => {
    void load();
  }, [load, storeId]);

  return (
    <ClaimCenterPageShell title={title} description={description} banner={banner}>
      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : error ? (
        <p className="text-sm text-red-500">{error}</p>
      ) : (
        <>
          <ClaimCenterListTable rows={rows} onSelect={setSelectedRow} />
          <div className="md:hidden">
            <ClaimCenterMobileCards rows={rows} onSelect={setSelectedRow} />
          </div>
        </>
      )}
    </ClaimCenterPageShell>
  );
}
