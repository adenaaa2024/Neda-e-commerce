"""Staging-gated claim agent dry-run smoke (no browser, no live filing)."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env.local")
load_dotenv(ROOT / "backend-python" / ".env")

STAGING_REF = "eiqfaapyumhixxoeltgu"


def _staging_url() -> str:
    return (
        os.getenv("STAGING_SUPABASE_URL")
        or os.getenv("SUPABASE_URL")
        or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
        or ""
    ).strip()


def _staging_key() -> str:
    return (os.getenv("STAGING_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()


def main() -> int:
    results: dict = {"steps": []}

    # --- disabled guard ---
    os.environ.pop("CLAIM_AGENT_ENABLED", None)
    os.environ.pop("CLAIM_AGENT_EXECUTE_BROWSER", None)
    sys.path.insert(0, str(ROOT / "backend-python"))
    if "main" in sys.modules:
        del sys.modules["main"]
    from main import app  # noqa: WPS433

    client = TestClient(app)
    r = client.post("/agent/process-ready-claims", json={"limit": 1})
    results["steps"].append(
        {
            "name": "disabled_guard",
            "status_code": r.status_code,
            "pass": r.status_code == 403,
        }
    )

    # --- wrong ref guard ---
    os.environ["CLAIM_AGENT_ENABLED"] = "1"
    os.environ["CLAIM_AGENT_EXECUTE_BROWSER"] = "0"
    os.environ["SUPABASE_URL"] = "https://kxsvedvpjldygtdbylsy.supabase.co"
    os.environ["SUPABASE_SERVICE_ROLE_KEY"] = _staging_key()
    if "main" in sys.modules:
        for mod in list(sys.modules):
            if mod.startswith(("main", "claim_agent", "claim_repository")):
                del sys.modules[mod]
    from main import app as app2  # noqa: WPS433

    client2 = TestClient(app2)
    r2 = client2.post("/agent/process-ready-claims", json={"limit": 1})
    results["steps"].append(
        {
            "name": "wrong_ref_guard",
            "status_code": r2.status_code,
            "detail": r2.json().get("detail") if r2.status_code == 403 else r2.text[:200],
            "pass": r2.status_code == 403 and "kxsvedvpjldygtdbylsy" in str(r2.json().get("detail", "")),
        }
    )

    # --- staging dry-run ---
    staging_url = _staging_url()
    staging_key = _staging_key()
    if not staging_url or not staging_key:
        results["steps"].append({"name": "staging_dry_run", "pass": False, "error": "missing staging env"})
        print(json.dumps(results, indent=2))
        return 1

    ref_host = staging_url.replace("https://", "").split(".")[0]
    if ref_host != STAGING_REF:
        results["steps"].append(
            {
                "name": "staging_dry_run",
                "pass": False,
                "error": f"STAGING url ref {ref_host!r} != {STAGING_REF!r}",
            }
        )
        print(json.dumps(results, indent=2))
        return 1

    os.environ["CLAIM_AGENT_ENABLED"] = "1"
    os.environ["CLAIM_AGENT_EXECUTE_BROWSER"] = "0"
    os.environ["SUPABASE_URL"] = staging_url
    os.environ["NEXT_PUBLIC_SUPABASE_URL"] = staging_url
    os.environ["SUPABASE_SERVICE_ROLE_KEY"] = staging_key
    for mod in list(sys.modules):
        if mod.startswith(("main", "claim_agent", "claim_repository", "claim_agent_routes", "claim_agent_guards")):
            del sys.modules[mod]
    from main import app as app3  # noqa: WPS433

    client3 = TestClient(app3)
    r3 = client3.post("/agent/process-ready-claims", json={"limit": 1})
    body = r3.json() if r3.headers.get("content-type", "").startswith("application/json") else {}
    dry_run_ok = body.get("dry_run") is True or any(
        (x.get("dry_run") is True for x in (body.get("results") or []))
    )
    results["steps"].append(
        {
            "name": "staging_dry_run",
            "status_code": r3.status_code,
            "dry_run": body.get("dry_run"),
            "processed": body.get("processed"),
            "result_count": len(body.get("results") or []),
            "first_result": (body.get("results") or [None])[0],
            "pass": r3.status_code == 200 and dry_run_ok,
            "execute_browser": os.getenv("CLAIM_AGENT_EXECUTE_BROWSER"),
        }
    )

    all_pass = all(s.get("pass") for s in results["steps"])
    results["overall"] = "PASS" if all_pass else "FAIL"
    print(json.dumps(results, indent=2, default=str))
    return 0 if all_pass else 1


if __name__ == "__main__":
    raise SystemExit(main())
