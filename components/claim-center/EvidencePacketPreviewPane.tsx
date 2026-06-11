"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { composeClaimEvidencePacketAction } from "@/app/claim-engine/evidence-packet-actions";

type Props = {
  organizationId: string;
  candidateId: string;
};

export function EvidencePacketPreviewPane({ organizationId, candidateId }: Props) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadPreview() {
    setLoading(true);
    setError(null);
    const res = await composeClaimEvidencePacketAction({
      organizationId,
      candidateIds: [candidateId],
    });
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setHtml(res.html);
  }

  return (
    <section className="claim-center-card rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Evidence packet preview</h3>
          <p className="text-xs opacity-70">Read-only HTML preview — no PDF or submission.</p>
        </div>
        <button
          type="button"
          className="claim-center-btn rounded-lg border px-3 py-1.5 text-xs font-medium"
          disabled={loading}
          onClick={() => void loadPreview()}
        >
          {loading ? <Loader2 className="inline h-4 w-4 animate-spin" /> : "Generate preview"}
        </button>
      </div>
      {error ? <p className="mt-3 text-xs text-red-500">{error}</p> : null}
      {html ? (
        <iframe
          title="Evidence packet preview"
          className="mt-4 h-[480px] w-full rounded-lg border bg-white"
          srcDoc={html}
          sandbox=""
        />
      ) : null}
    </section>
  );
}
