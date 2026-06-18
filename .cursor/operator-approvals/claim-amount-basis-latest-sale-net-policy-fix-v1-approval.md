# Claim amount basis — latest_sale_net policy fix V1 approval

**Phase:** PHASE-CLAIM-AMOUNT-BASIS-LATEST-SALE-NET-POLICY-FIX-V1
**Target:** Original/live `kxsvedvpjldygtdbylsy` only
**Scope:** Correct the per-family Seller Central claim-amount basis for the two
current pilot removal families from `cogs_recovery` to `latest_sale_net`.

## What this approves

A governed write of the operator-confirmed claim-amount basis policy into the
canonical `workspace_settings.module_configs.claims.amount_basis_policy` only.
No `claim_candidates` / `claim_cases` / `claim_lines` / `claim_submissions` /
`claim_reference_edges` mutation. No Amazon submission. No scanner change. No AI.

## Confirmed policy correction (Maysam)

| Family | Seller Central amount basis | Internal-only (display, NOT the claim amount) |
|--------|------------------------------|------------------------------------------------|
| `removal_shipment_missing` | `latest_sale_net` = (latest_sold_price − amazon_fees) × qty | cogs_recovery, settlement_net, business profit/loss |
| `removal_order_discrepancy` | `latest_sale_net` = (latest_sold_price − amazon_fees) × qty | cogs_recovery, settlement_net, business profit/loss |

Rules:

- Seller Central expected reimbursement = `latest_sold_price − amazon_fees` (× qty). NOT COGS, NOT sale price alone, NOT settlement net alone.
- Confirmed reimbursed = only strong same-family matched reimbursements / credits.
- Open claim amount = expected_reimbursement − confirmed_reimbursed.
- COGS / purchase cost remain visible as internal cost / profit-loss context only.
- `settlement_net` shown separately as settlement context, never auto-used as the claim amount.
- Weak / cross-family candidates (Damaged_Warehouse / Lost_Warehouse / Lost_Outbound / Reimbursement_Reversal / CustomerReturn) stay excluded and become separate opportunities only.

## Approval token

Set the token below to `yes` to authorize the policy write, then run:

```
npx tsx scripts/phase-claim-amount-basis-latest-sale-net-policy-fix-v1.ts --execute
```

APPROVED_CLAIM_AMOUNT_BASIS_LATEST_SALE_NET_POLICY_FIX_V1=yes

## Operator sign-off

| Field | Value |
|-------|-------|
| Approved by | (Maysam) |
| Date (UTC) | (06/18/2026) |
| Max scope | workspace_settings policy config only — 2 removal families |

**Signature:** APPROVED_CLAIM_AMOUNT_BASIS_LATEST_SALE_NET_POLICY_FIX_V1=yes (authorized)
