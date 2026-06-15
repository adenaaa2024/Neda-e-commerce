"use client";

import { Suspense } from "react";

import { ClaimGroupBuilderView } from "@/components/claim-center/grouping/ClaimGroupBuilderView";

function GroupBuilderContent() {
  return <ClaimGroupBuilderView />;
}

export default function ClaimCenterGroupBuilderPage() {
  return (
    <Suspense fallback={<div className="py-12 text-sm opacity-70">Loading group builder…</div>}>
      <GroupBuilderContent />
    </Suspense>
  );
}
