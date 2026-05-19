# Staging test plan — after ENV-06 clone

**Current workspace:** `.env.local` → project `kxsvedvpjldygtdbylsy` (treated as **original / linked DB** for v165 verification).  
**Staging:** Not configured in env (`SUPABASE_ENV`, `APP_ENV` unset per SCANNER-02C audits).

After **ENV-06** provides a staging Supabase clone **without** switching production app wiring:

---

## Preconditions

1. Operator approval file for staging writes (pattern: `.cursor/operator-approvals/scanner-02c-dev-staging-approval.md` or ENV-06-specific approval).
2. Staging URL + service role in a **separate** env file used only by scripts — not committed.
3. Migration `20260717120000_scanner_product_linkage_columns.sql` (or later scanner migrations) applied on staging if linkage E2E required — **only with operator sign-off** (this task does not apply migrations).

---

## Read-only parity (run first)

```powershell
cd c:\Users\Christian\ecommerce-os
$env:SCANNER_NEDA_08_RUN_ID = "run-staging-env06-001"
# Point env at staging URL/key before running:
npx tsx scripts/scanner-neda-08-final-ui-signoff.ts
```

| Step | Pass criteria |
|------|----------------|
| `package_items_table_absent_live` | PGRST205 or absent |
| `return_items_linkage_select` | no 42703 |
| `slip_contents_display_select` | at least one attempt succeeds |
| `identify_gate_EP_SELECT` | ok |
| Static: no `package_items` under operator-mobile | ok |

---

## Staging-only write smoke (optional)

Requires operator approval token (see `scripts/scanner-neda-06-small-write-smoke.ts`):

```powershell
$env:SCANNER_NEDA_06_DELETE_AFTER = "true"
$env:SCANNER_NEDA_06_FIXTURE_PACKAGE_ID = "<staging-package-uuid>"
npx tsx scripts/scanner-neda-06-small-write-smoke.ts
```

Validates: one `return_items` insert + hydrate + slip barcode match + no `package_items`.

---

## UI browser spot-check (staging URL)

With dev server pointed at staging **only in local test profile**:

```powershell
npx tsx scripts/scanner-neda-09-browser-spot-check.ts
```

Checks: route 200, no `package_items` in console, hydrate fixture.

---

## Extended E2E (post-migration staging)

When staging has linkage columns fully applied:

```powershell
npx tsx scripts/next-scanner-04-staging-e2e.ts
# optional: --write-test for manualOverride
```

---

## What can be tested on staging vs original

| Capability | Original DB (now) | Staging after clone |
|------------|-------------------|---------------------|
| Contract read probes | **Done** (v165) | Re-run NEDA-08 |
| Item scan insert/hydrate | Yes (NEDA-06 fixture) | Yes with staging fixture UUID |
| Slip full linkage SELECT | Fallback attempt 4 | May reach attempt 1 if migrated |
| `manualOverrideReturnItemProductResolution` | Code + SELECT ok; UI on returns page | Write test with `--write-test` |
| Identify gate matched demo | Needs real tracking/EP data | Seed EP rows or use prod-like import |
| Amazon / OpenAI | **Out of scope** | **Out of scope** |

---

## Do not do on staging without explicit approval

- `supabase db push` / migration apply (SCANNER-02C gate)
- Point production deployment env at staging
- Bulk delete beyond approved smoke rollback

---

## Sign-off criteria for Neda on staging

1. NEDA-08 read probe `pass: true` on staging ref.  
2. One approved NEDA-06 write + reload shows row in `listOperatorPackageItemsForPackageAction` shape.  
3. Browser spot-check: no `package_items` / 42703 on `/scanner/operator-mobile/scan`.  
4. Forbidden list unchanged (`forbidden-old-contracts.md`).
