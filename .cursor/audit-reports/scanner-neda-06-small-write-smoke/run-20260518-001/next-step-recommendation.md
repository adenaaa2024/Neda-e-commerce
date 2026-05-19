# Next step recommendation

1. **Rollback smoke row** — Run soft/hard delete in `rollback-instructions.md` for `ccffe8b3-87ea-4b7b-bfd5-4cf9cc16d663` when no longer needed.
2. **Optional UI spot-check** — One slip-matched save in `/scanner/operator-mobile/scan` with operator session (confirms cookies + RLS on `insertOperatorPackageItemAction`).
3. **Identify gate fixture** — Seed or pick a package whose tracking matches `expected_packages` if you want end-to-end gate automation (same gap as neda-04).
4. **Do not** — Reintroduce `package_items` migration or OCR-driven product creation on operator-mobile.
