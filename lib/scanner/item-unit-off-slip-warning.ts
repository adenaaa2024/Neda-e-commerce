import { summarizeItemBatchAllocation, type ItemBatchAllocationInput } from "@/lib/scanner/item-batch-allocation";
import { itemScanSaveShouldTreatAsOffSlip } from "@/lib/scanner/item-scan-off-slip";

export const ITEM_UNIT_MIN_BARCODE_IDENTITY_LENGTH = 3;

export function hasItemUnitEnteredIdentity(barcode: string): boolean {
  return barcode.trim().length >= ITEM_UNIT_MIN_BARCODE_IDENTITY_LENGTH;
}

export type ItemUnitModalOffSlipWarningInput = {
  barcode: string;
  addMode: "single" | "batch";
  batchQty: number;
  batchQtyEntered: boolean;
  allocation: ItemBatchAllocationInput;
};

export function buildItemUnitModalOffSlipWarning(
  input: ItemUnitModalOffSlipWarningInput,
): { title: string; message: string } | null {
  if (!hasItemUnitEnteredIdentity(input.barcode)) return null;

  const singleOffSlip = itemScanSaveShouldTreatAsOffSlip({
    matchKindPreset: input.allocation.matchKindPreset,
    slipContentId: input.allocation.slipContentId,
    slipExpectedQty: input.allocation.slipExpectedQty,
    scannedForSlipQty: input.allocation.scannedForSlipQty,
    hasAllocatableExpectedPackageHint: input.allocation.hasAllocatableExpectedPackageHint,
  });

  const batchQty = Math.max(1, Math.floor(input.batchQty));
  const inBatchMode = input.addMode === "batch";
  const effectiveBatchQty = inBatchMode && input.batchQtyEntered ? batchQty : 1;

  if (inBatchMode) {
    if (effectiveBatchQty > 1) {
      const summary = summarizeItemBatchAllocation({
        ...input.allocation,
        batchQuantity: effectiveBatchQty,
      });
      if (!summary.hasOffSlip) return null;
      if (summary.onSlipCount > 0 && summary.offSlipCount > 0) {
        return {
          title: "Partial off-slip batch",
          message: `${summary.onSlipCount} units will match the packing slip. ${summary.offSlipCount} extra units will be saved as off-slip.`,
        };
      }
      return {
        title: "Off-slip batch",
        message: `These ${effectiveBatchQty} units are not on the packing slip and will be saved as extra/off-slip units.`,
      };
    }
    if (singleOffSlip) {
      return {
        title: "Off-slip batch",
        message: "The selected quantity will be saved as extra/off-slip units.",
      };
    }
    return null;
  }

  if (!singleOffSlip) return null;

  return {
    title: "Off-slip item",
    message: "This item is not on the packing slip. It will be saved as an extra/off-slip unit.",
  };
}
