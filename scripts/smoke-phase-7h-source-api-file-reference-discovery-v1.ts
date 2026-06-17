/**
 * Smoke — PHASE-7H-SOURCE-API-FILE-REFERENCE-DISCOVERY-V1
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { SOURCE_API_FILE_REFERENCE_DISCOVERY_V1_VERSION } from "../lib/claims/reference/claim-7h-source-api-file-reference-discovery-v1";

const LIB = "lib/claims/reference/claim-7h-source-api-file-reference-discovery-v1.ts";
const SCRIPT = "scripts/phase-7h-source-api-file-reference-discovery-v1.ts";

function main(): void {
  const root = process.cwd();
  const lib = fs.readFileSync(path.join(root, LIB), "utf8");
  const script = fs.readFileSync(path.join(root, SCRIPT), "utf8");

  const checks = {
    lib_exists: fs.existsSync(path.join(root, LIB)),
    script_exists: fs.existsSync(path.join(root, SCRIPT)),
    version: lib.includes(SOURCE_API_FILE_REFERENCE_DISCOVERY_V1_VERSION),
    no_db_insert: !script.includes('.insert('),
    upload_lineage: lib.includes("loadUploadLineage"),
    file_download: lib.includes("tryDownloadUploadArtifact"),
    sample_verify: script.includes("sample_source_file_verification"),
    safe_gates: script.includes("SAFE_SOURCE_REFERENCE_DISCOVERY_VERIFIED"),
    trid_not_invented: lib.includes("missing_trid_warning"),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  console.log(JSON.stringify({ smoke: failures.length === 0 ? "pass" : "fail", failures }));
  if (failures.length > 0) process.exitCode = 1;
}

main();
