# expected_packages UI proof

**Status:** PASS

## Surfaces

| Surface | Evidence |
|---------|----------|
| Expected Inventory Summary | `ExpectedInventoryLineRow` — Exp / Scan / Var + `OperatorProductLinkageMeta` |
| Shipment lines (reference) table | `expectedPkgLines` — product, SKU, Exp, Scn, Var |
| Shipment summary strip | variance + linkage chips |
| Identify gate EP resolution list | legacy badges on `identifyGateRows` |

## Key symbols in scan page

- `buildInventoryViewProductLinkage`: yes
- `formatScanVarianceLabel`: yes
- `line.product_linkage`: yes
- `loadTrackingExpectationSnapshot`: yes

## DB probes

- db_ep_detail_select: OK
- db_ep_linkage_select: column expected_packages.identifier_resolution_status does not exist
