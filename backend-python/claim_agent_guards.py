"""Staging and enablement guards for claim agent routes."""

from __future__ import annotations

import os
from urllib.parse import urlparse

from fastapi import HTTPException

from claim_agent_constants import STAGING_PROJECT_REF


def claim_agent_enabled() -> bool:
    return os.getenv("CLAIM_AGENT_ENABLED", "0").strip().lower() in ("1", "true", "yes")


def claim_browser_execute_allowed() -> bool:
    """Live Seller Central browser automation — separate from route enablement."""
    return os.getenv("CLAIM_AGENT_EXECUTE_BROWSER", "0").strip().lower() in ("1", "true", "yes")


def claim_browser_engine() -> str:
    """``selenium`` (default) or ``playwright`` when CLAIM_BROWSER_ENGINE is set."""
    return (os.getenv("CLAIM_BROWSER_ENGINE") or "selenium").strip().lower()


def supabase_project_ref_from_env() -> str | None:
    raw = (os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL") or "").strip()
    if not raw:
        return None
    host = urlparse(raw).hostname or ""
    if host.endswith(".supabase.co"):
        return host.split(".")[0] or None
    return None


def assert_claim_agent_preflight() -> None:
    """
  Raise 403 when agent must not run. No Supabase or browser side effects before this passes.
    """
    if not claim_agent_enabled():
        raise HTTPException(
            status_code=403,
            detail="CLAIM_AGENT_ENABLED is off (default). Set to 1 only on staging with operator approval.",
        )
    ref = supabase_project_ref_from_env()
    if ref != STAGING_PROJECT_REF:
        raise HTTPException(
            status_code=403,
            detail=(
                f"Claim agent requires staging Supabase project {STAGING_PROJECT_REF!r}; "
                f"got {ref!r} from SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL."
            ),
        )
