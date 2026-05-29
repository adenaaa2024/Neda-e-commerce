# Claim agent operations (staging only)

## Enablement (all required for live Seller Central filing)

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAIM_AGENT_ENABLED` | **`0` (off)** | Master switch for `/agent/*` routes |
| `CLAIM_AGENT_EXECUTE_BROWSER` | **`0` (off)** | When off, `process-ready-claims` runs **dry-run** only (no Selenium/Playwright) |
| `CLAIM_BROWSER_ENGINE` | `selenium` | `selenium` or `playwright` |
| `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` | — | Must resolve to staging ref **`eiqfaapyumhixxoeltgu`** |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Staging service role only |

## Operator approval

- Amazon Seller Central session must be logged in for the automated Chrome profile used by Selenium/Playwright.
- Main must approve enabling both flags on **staging** only.
- **Never** enable on production Supabase or production Seller Central.

## Chrome / Playwright requirements

- **Selenium (default):** Google Chrome + `webdriver-manager` (downloads matching ChromeDriver).
- **Playwright:** `playwright install` for bundled browsers when `CLAIM_BROWSER_ENGINE=playwright`.
- Headed browser recommended for first staging smoke; unattended runs need ops sign-off.

## PDF evidence

- Use **`claim_report_service.generate_claim_evidence_pdf`** only (merged on feature via PDF PR).
- Do not duplicate reportlab layout in `claim_agent.py`.

## Data path

- `claim_submissions` embeds **`return_items`** (not `returns(order_id)`).
- Optional `claim_lines` lookup by `return_item_id` when `return_id` is set.

## Disabled routes

- When `CLAIM_AGENT_ENABLED=0`, `/agent/*` returns **403** with **no** Supabase queries and **no** browser launch.
