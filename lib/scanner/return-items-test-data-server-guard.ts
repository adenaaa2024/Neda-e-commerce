import {
  isBlockedSyntheticTestReturnItemInsert,
  SYNTHETIC_TEST_MARKER_INSERT_ERROR,
  type ReturnItemSyntheticInsertFields,
} from "@/lib/scanner/return-items-test-data-guard";

/**
 * Server insert guard: blocks synthetic test/smoke/parity markers with null raw_return_data
 * in all environments (staging and production). Real operator/scanner rows are unaffected.
 */
export function assertCanInsertReturnItemAgainstTestMarkers(fields: ReturnItemSyntheticInsertFields): void {
  if (!isBlockedSyntheticTestReturnItemInsert(fields)) return;
  throw new Error(SYNTHETIC_TEST_MARKER_INSERT_ERROR);
}

/** Backward-compatible alias while imports migrate. */
export const assertReturnItemInsertNotTestDataInProduction = assertCanInsertReturnItemAgainstTestMarkers;
