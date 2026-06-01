# Automation API Center — authoritative UX + scope

**Status:** COMPLETE — pre-Neda merge  
**Branch:** `feature/phase1-latest-stash-land` @ `999f765`  
**Last updated:** 2026-06-17 (`phase1-demo-ready-history-memory-sync` `20260617T120000Z`)

## Purpose

**Automation API Center** is the **single API automation/config center** per company/store.

All scheduled and manual API-driven ingestion (removal fetch, product sync, etc.) is configured and run from Automation — not from Data Management → Imports.

## Final UX (locked)

| Rule | Detail |
|------|--------|
| Scope | **Company/store scoped** inside the page |
| Type selector | **Automation type combo** — one automation family at a time |
| Cards | **One card visible at a time** (no stacked API panels) |
| Page selectors | **Own company/store selectors** on the Automation page |
| Global top selector | **Must NOT drive Automation scope** |

Global top workspace/view selector is for navigation context only — Automation reads/writes scope from **in-page** org/store selection.

## Data Management → Imports (cutover)

| Surface | Role |
|---------|------|
| **Imports** | **File-import only** for customers |
| **UniversalImporter** | **Unchanged** — file pipeline; do not touch |
| Import history | **Remains** on Imports |
| API panels on Imports | **Removed / cut over** to Automation |

## API routes (reuse)

Automation manual runs **reuse existing** routes:

```text
/api/settings/imports/*
```

Pass explicitly: `organization_id`, `store_id`, date window — scoped from Automation page selectors, not global header.

## Forbidden

| Action | Why |
|--------|-----|
| Re-add API automation panels to Imports | Cut over complete |
| Drive Automation scope from global top selector | Scope isolation requirement |
| Rewrite `/api/settings/imports/*` contract without audit | Automation depends on stable routes |
| Touch UniversalImporter file pipeline | File-import path locked |

Related: [ASYNC_JOB_ARCHITECTURE.md](ASYNC_JOB_ARCHITECTURE.md) · [REMOVAL_API_STATE.md](REMOVAL_API_STATE.md) · [PLATFORM_ARCHITECTURE.md](PLATFORM_ARCHITECTURE.md)
