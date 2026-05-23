# Blockers

## B1 — Package edit drawer still writes `photo_evidence` on update

Some `_components.tsx` edit paths call `updatePackage` with `photo_evidence`. Server `packageCanonicalPhotoPatch` strips it; reconciliation UI may need follow-up to persist via `outside_photo_urls` / `inside_photo_urls` / `slip_photo_urls` only.

**Impact:** Low — no 42703; photos may not persist on edit until mapped explicitly.

## B2 — Browser E2E not executed

Returns / scanner page load not verified in authenticated browser this run.
