# Claim amount basis policy V1 approval

**Phase:** PHASE-CLAIM-AMOUNT-BASIS-POLICY-OPERATOR-CONFIRMATION-V1
**Target:** Original/live `kxsvedvpjldygtdbylsy` only
**Scope:** Confirm per-family Seller Central claim-amount basis (current pilot removal families)

## What this approves

A governed write of the operator-confirmed claim-amount basis policy into the
canonical `workspace_settings.module_configs.claims.amount_basis_policy` only.
No claim_candidates / claim_cases / claim_lines / claim_submissions /
claim_reference_edges mutation. No Amazon submission. No scanner change. No AI.

## Confirmed policy (current pilot)

| Family | Seller Central amount basis | Informational only (display, not used as claim amount) |
|--------|------------------------------|---------------------------------------------------------|
| `removal_shipment_missing` | `cogs_recovery` (clean_quantity x approved COGS/unit) | latest_sale_net, business_total_loss |
| `removal_order_discrepancy` | `cogs_recovery` (clean_quantity x approved COGS/unit) | latest_sale_net, business_total_loss |

Rules: COGS recovery is the Seller Central requested amount for these two
families; latest sale net and business loss are informational/internal only;
weak/cross-family candidates must not change the removal claim amount;
Damaged/Lost/CustomerReturn/Reversal candidates generate **separate** claim
opportunities; sale price is **not** the claim amount unless a future operator
policy explicitly changes it.

## Approval token

Set the token below to `yes` to authorize the policy write, then run:

```
npx tsx scripts/phase-claim-amount-basis-policy-operator-confirmation-v1.ts --execute
```

APPROVED_CLAIM_AMOUNT_BASIS_POLICY_V1=yes

## Operator sign-off

| Field | Value |
|-------|-------|
| Approved by | (Maysam) |
| Date (UTC) | (06/18/2026) |
| Max scope | workspace_settings policy config only — 2 removal families |

**Signature:** APPROVED_CLAIM_AMOUNT_BASIS_POLICY_V1=yes (authorized)
