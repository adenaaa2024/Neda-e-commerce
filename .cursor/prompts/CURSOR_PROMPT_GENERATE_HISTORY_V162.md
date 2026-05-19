# CURSOR — GENERATE HISTORY APPEND (V162)

> **Superseded by** `CURSOR_PROMPT_GENERATE_HISTORY_V163.md` (22 sections).

## Owner
Main/user

## Mode
Agent

## Goal
Produce an append-only `ERP_PIM_FULL_HISTORY_V###_APPEND_ONLY_<topic>.md` that is **self-contained** for new chats.

## Base
1. Find latest full history under `.cursor/audit-reports/history-v*/**/ERP_PIM_FULL_HISTORY_*.md` (highest version / latest run_id).
2. Copy entire file — **do not remove or shorten any line**.
3. Append new block using `.cursor/templates/history-append-mandatory-sections-v162.md`.

## Before writing
Read latest audit packs for:
- `next-env-*`, `claim-evidence-*`, `git-clean-verify-*`
- `.cursor/operator-approvals/*.md`
- `.env.local` — **key names and pass/fail only**; never log secrets

## Output layout
`.cursor/audit-reports/history-v<NNN>/<run_id>/`
- `ERP_PIM_FULL_HISTORY_V<NNN>_APPEND_ONLY_<topic>.md`
- `handoff-summary.md`
- `manifest.json`

## Rules
- Append only
- All 20 mandatory sections (see template)
- Include mandatory topology + forbidden actions + next-chat handoff boilerplate
- ChatGPT does not write history — **Cursor writes history**

## run_id format
`YYYYMMDDTHHMMSSZ` (UTC)
