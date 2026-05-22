# CURSOR — GENERATE HISTORY APPEND (V163)

## Owner
Main/user

## Mode
Agent

## Goal
Append-only history that is **self-contained** for new chats (22 mandatory sections).

## Base
1. Latest `ERP_PIM_FULL_HISTORY_*.md` under `.cursor/audit-reports/history-v*/`
2. Copy **entire** file — never shorten.
3. Append using `.cursor/templates/history-append-mandatory-sections-v163.md`

## Before writing
Read latest: `next-env-*`, `claim-evidence-*`, operator approvals, `.env.local` (keys/pass-fail only — no secrets).

## Output
`.cursor/audit-reports/history-v<NNN>/<run_id>/` or upgrade pack if canonical format-only change.

## Rules
- Cursor writes history; ChatGPT issues prompts only
- All 22 sections + topology + forbidden + handoff boilerplate
- Append only

## run_id
`YYYYMMDDTHHMMSSZ` (UTC)
