import { ProductCogsManualEntryView } from "@/components/claim-center/reimbursement-tracking/ProductCogsManualEntryView";
import { PRODUCT_COGS_MANUAL_ENTRY_UI_V1 } from "@/lib/claims/submission/product-cogs-manual-entry-ui-v1";

export const metadata = {
  title: "COGS Entry · Reimbursement Tracking",
  description: PRODUCT_COGS_MANUAL_ENTRY_UI_V1.safetyBanner,
};

export default function ClaimCenterReimbursementTrackingCogsPage() {
  return <ProductCogsManualEntryView />;
}
