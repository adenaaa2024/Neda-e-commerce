import { itemScanSaveShouldTreatAsOffSlip } from "@/lib/scanner/item-scan-off-slip";

export const OPERATOR_ITEM_BATCH_MAX_QUANTITY = 200;
export const OPERATOR_ITEM_BATCH_CONFIRM_THRESHOLD = 20;

export type ItemBatchAllocationInput = {
  batchQuantity: number;
  matchKindPreset: "fnsku" | "upc" | "unexpected" | null;
  slipContentId: string | null;
  slipExpectedQty: number;
  scannedForSlipQty: number;
  hasAllocatableExpectedPackageHint: boolean;
};

export function itemBatchUnitSaveAsOffSlip(
  input: ItemBatchAllocationInput,
  unitIndexInBatch: number,
): boolean {
  return itemScanSaveShouldTreatAsOffSlip({
    matchKindPreset: input.matchKindPreset,
    slipContentId: input.slipContentId,
    slipExpectedQty: input.slipExpectedQty,
    scannedForSlipQty: input.scannedForSlipQty + unitIndexInBatch,
    hasAllocatableExpectedPackageHint: input.hasAllocatableExpectedPackageHint,
  });
}

export function summarizeItemBatchAllocation(input: ItemBatchAllocationInput): {
  offSlipCount: number;
  onSlipCount: number;
  hasOffSlip: boolean;
} {
  const qty = Math.max(0, Math.floor(input.batchQuantity));
  let offSlipCount = 0;
  for (let i = 0; i < qty; i++) {
    if (itemBatchUnitSaveAsOffSlip(input, i)) offSlipCount++;
  }
  return {
    offSlipCount,
    onSlipCount: qty - offSlipCount,
    hasOffSlip: offSlipCount > 0,
  };
}
