/**
 * Unit tests for explicit expected_packages rebuild dedupe guard.
 * Run: npm run test:production-removal-sync-dedupe-rebuild
 */
import {
  evaluateExplicitRebuildSkip,
  expectedPackagesRebuildRecordedForUpload,
} from "../lib/removal/expected-packages-explicit-rebuild-guard";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const uploadA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const uploadB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const metaWithRebuild = {
  import_metrics: {
    expected_packages_rebuild_after_import: {
      upload_id: uploadB,
      report_type: "REMOVAL_SHIPMENT",
      rebuild_called: true,
      rebuilt_at: "2026-06-13T00:00:00.000Z",
    },
  },
};

assert(
  expectedPackagesRebuildRecordedForUpload(metaWithRebuild, uploadB),
  "metadata with rebuild_called should match upload",
);
assert(
  !expectedPackagesRebuildRecordedForUpload(metaWithRebuild, uploadA),
  "wrong upload id should not match",
);

const skipWhenHookRan = evaluateExplicitRebuildSkip({
  rebuildExpectedPackages: true,
  orderPipelineOk: true,
  shipmentPipelineOk: true,
  orderUploadMetadata: null,
  shipmentUploadMetadata: metaWithRebuild,
  orderUploadId: uploadA,
  shipmentUploadId: uploadB,
});
assert(skipWhenHookRan.skip === true, "should skip when shipment hook recorded rebuild");
assert(skipWhenHookRan.reason === "pipeline_hook_already_rebuilt", "reason");

const manualPath = evaluateExplicitRebuildSkip({
  rebuildExpectedPackages: true,
  orderPipelineOk: false,
  shipmentPipelineOk: false,
  orderUploadMetadata: null,
  shipmentUploadMetadata: null,
  orderUploadId: null,
  shipmentUploadId: null,
});
assert(manualPath.skip === false, "fetch-only / manual path keeps explicit rebuild");

const fetchOnlyNoMeta = evaluateExplicitRebuildSkip({
  rebuildExpectedPackages: true,
  orderPipelineOk: true,
  shipmentPipelineOk: true,
  orderUploadMetadata: null,
  shipmentUploadMetadata: null,
  orderUploadId: uploadA,
  shipmentUploadId: uploadB,
});
assert(fetchOnlyNoMeta.skip === false, "pipeline ok but no metadata → explicit rebuild still runs");

const disabled = evaluateExplicitRebuildSkip({
  rebuildExpectedPackages: false,
  orderPipelineOk: true,
  shipmentPipelineOk: true,
  orderUploadMetadata: metaWithRebuild,
  shipmentUploadMetadata: metaWithRebuild,
  orderUploadId: uploadA,
  shipmentUploadId: uploadB,
});
assert(disabled.skip === true && disabled.reason === "rebuild_disabled", "rebuild disabled");

console.log("test:production-removal-sync-dedupe-rebuild OK");
