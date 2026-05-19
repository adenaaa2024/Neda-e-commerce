# Next actions — V176

Ordered for any agent continuing work. See [TASKS.md](../TASKS.md) for checkboxes.

## 1. Claim upstream blockers (staging)

**Why:** V175 map path is **terminal** on candidates (0 tier-1–4 eligible on `20260524T120000Z`). Wave-2 added marginal claim uplift; bulk of gap is upstream.

**Do:**

- Address `missing_source_row` (~1,543), `unresolved_no_identifiers` (~667), `blocked_pim` (~259), `ambiguous` (~38).
- Evidence: `.cursor/audit-reports/claim-candidate-resolver-project-v175/20260524T120000Z/blocker-inventory.json`

**Do not:** Blind V175 re-execute; product auto-create; claim submission; production.

## 2. Product mapping — remaining waves

**Why:** `slip_contents` still 0%; settlements/ledger governed-only; `return_items` out of scope (test data).

**Do:**

- Targeted tier passes when operator approves runtime (`--tiers=2` on wave-2 script).
- **No** blind `amazon_settlements` bulk.

**Audit:** `.cursor/audit-reports/product-id-mapping-wave-2-v176/20260520T132000Z/`

## 3. Roadmap artifacts (plan-only)

- Hardening roadmap pack (V172 plan exists).
- AI layer artifacts (no live OpenAI without governance).

## 4. History-V176+ append

**When:** After next major resolver/mapping milestone.

**Do:** New `history-v176/<run_id>/` full file + paired `.ai-memory` refresh (see [HISTORY_POINTERS.md](HISTORY_POINTERS.md)).

## 5. Production (blocked)

Do not register production ref or alter Vercel Production until operator cutover pack.

## Done (no re-run without reason)

- Preview operator signoff (ENV-06C close V175)
- V176 orphan FK execute
- V175 claim resolver (72.3% candidates baseline)
- Schema combined smoke V175
- NEDA 15 UI wiring
