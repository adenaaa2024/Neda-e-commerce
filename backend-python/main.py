from pathlib import Path

from fastapi import Body, FastAPI, HTTPException
from starlette.requests import Request
from pydantic import BaseModel, Field
from supabase import create_client, Client
import asyncio
import os
import tempfile
from dotenv import load_dotenv

from claim_agent import (
    ClaimProcessorAgent,
    resolve_amazon_order_id_from_row,
)

from claim_report_service import generate_claim_evidence_pdf

# Always load backend-python/.env (not the shell's current working directory).
_env_dir = Path(__file__).resolve().parent
_env_file = _env_dir / ".env"
load_dotenv(dotenv_path=_env_file)
print(
    f"[env] Dotenv directory: {_env_dir} | loading: {_env_file} | "
    f"file exists: {_env_file.is_file()}"
)
print(
    "[env] Supabase vars present: "
    f"SUPABASE_URL={'yes' if os.getenv('SUPABASE_URL') else 'no'}, "
    f"NEXT_PUBLIC_SUPABASE_URL={'yes' if os.getenv('NEXT_PUBLIC_SUPABASE_URL') else 'no'}, "
    f"SUPABASE_SERVICE_ROLE_KEY={'yes' if os.getenv('SUPABASE_SERVICE_ROLE_KEY') else 'no'}"
)

app = FastAPI(title="Logistics AI Agent API", version="1.0")


@app.middleware("http")
async def debug_log_process_ready_claims(request: Request, call_next):
    """Ensures a log line even when JSON body validation fails before the route handler runs."""
    if request.method == "POST":
        p = request.url.path.rstrip("/") or "/"
        if p.endswith("/agent/process-ready-claims"):
            print(
                "[DEBUG] HTTP middleware: POST reached app for /agent/process-ready-claims "
                "(before handler / body validation)",
                flush=True,
            )
    return await call_next(request)

# URL: accept either name (Next.js often uses NEXT_PUBLIC_SUPABASE_URL).
SUPABASE_URL = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

supabase: Client | None = None

# Initialize Database Connection
try:
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("Error: Missing Supabase credentials in .env file!")
    else:
        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
        print("Connected to Supabase Successfully!")
except Exception as e:
    print(f"Database Connection Error: {e}")
    supabase = None


def _require_supabase() -> Client:
    if supabase is None:
        raise HTTPException(status_code=500, detail="Supabase is not configured.")
    return supabase


# Data Model for Amazon SP-API Sync
class AmazonOrderSync(BaseModel):
    amazon_order_id: str
    org_id: str
    store_id: str
    raw_data: dict


class ProcessReadyClaimsRequest(BaseModel):
    """POST /agent/process-ready-claims — optional filters."""

    organization_id: str | None = Field(
        default=None,
        description="Filter to this tenant; if omitted, uses CLAIM_AGENT_ORGANIZATION_ID env or no org filter.",
    )
    submission_ids: list[str] | None = Field(
        default=None,
        description="Process only these claim_submissions ids (must still be ready_to_send).",
    )
    limit: int = Field(default=1, ge=1, le=50, description="Max rows to process in one call.")


# 1. Root Endpoint (Health Check)
@app.get("/")
def read_root():
    return {"status": "Agent Backend is Live!", "service": "AI Logistics"}


# 2. Agent Queue Endpoint
@app.get("/agent/pending-claims")
async def get_pending_claims():
    sb = _require_supabase()
    try:
        response = (
            sb.table("claim_submissions")
            .select("*")
            .eq("status", "ready_to_send")
            .execute()
        )
        return {"count": len(response.data), "claims": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


def _default_org_for_agent() -> str | None:
    raw = (os.getenv("CLAIM_AGENT_ORGANIZATION_ID") or "").strip()
    return raw or None


# 3. Trigger agent for ready_to_send rows (exact path — avoid typos / extra prefixes)
@app.post("/agent/process-ready-claims")
async def process_ready_claims(
    organization_id: str | None = Body(default=None),
    submission_ids: list[str] | None = Body(default=None),
    limit: int = Body(default=1, ge=1, le=50),
):
    # DEBUG must be first — any code above that can raise would hide this line in the terminal.
    print("[DEBUG] Request received at /agent/process-ready-claims", flush=True)
    # Loads ready_to_send claim_submissions; resolves amazon_order_id + PDF; runs Selenium via to_thread.
    if supabase is None:
        print("[DEBUG] Supabase client is None — cannot query claims.", flush=True)
        raise HTTPException(status_code=500, detail="Supabase is not configured.")
    sb = supabase

    req = ProcessReadyClaimsRequest(
        organization_id=organization_id,
        submission_ids=submission_ids,
        limit=limit,
    )
    org = (req.organization_id or "").strip() or _default_org_for_agent()

    print(
        f"[main] POST /agent/process-ready-claims org={org!r} "
        f"submission_ids={req.submission_ids!r} limit={req.limit}",
        flush=True,
    )

    try:
        q = (
            sb.table("claim_submissions")
            .select("*, returns(order_id)")
            .eq("status", "ready_to_send")
        )
        # EMERGENCY: org filter disabled — was excluding rows / failing silently vs DB expectations.
        # if org:
        #     q = q.eq("organization_id", org)
        if req.submission_ids:
            q = q.in_("id", req.submission_ids)
        q = q.limit(req.limit)
        response = q.execute()
        rows = response.data or []
    except Exception as e:
        print(f"[DEBUG] claim_submissions query failed: {e}", flush=True)
        raise HTTPException(status_code=500, detail=str(e)) from e

    if not rows:
        print("[DEBUG] No claims found with status ready_to_send", flush=True)
        return {"ok": True, "processed": 0, "message": "No ready_to_send claims matched.", "results": []}

    results: list[dict] = []

    for row in rows:
        submission_id = row.get("id")
        # EMERGENCY: do not skip rows for missing org — use default tenant id for agent client.
        row_org = (
            row.get("organization_id")
            or org
            or "00000000-0000-0000-0000-000000000001"
        )
        if not row.get("organization_id"):
            print(
                f"[DEBUG] Row {submission_id!r} missing organization_id — using fallback org {row_org!r}",
                flush=True,
            )

        amazon_order_id = resolve_amazon_order_id_from_row(row)
        if not amazon_order_id:
            print(
                f"[DEBUG] Skipping submission {submission_id!r}: no amazon_order_id on row.",
                flush=True,
            )
            results.append(
                {
                    "submission_id": submission_id,
                    "ok": False,
                    "error": "Could not resolve amazon_order_id from source_payload or returns.order_id.",
                }
            )
            continue

        payload = row.get("source_payload") or {}
        claim_type = str(payload.get("claim_type") or "FBA_CLAIM")

        try:
            agent = ClaimProcessorAgent(str(row_org))
        except Exception as e:
            print(f"[DEBUG] ClaimProcessorAgent init failed: {e}", flush=True)
            results.append(
                {
                    "submission_id": submission_id,
                    "ok": False,
                    "error": f"Agent init failed: {e}",
                }
            )
            continue

        # ── Step 1: generate claim report PDF locally (mandatory, before Selenium) ──
        # Do NOT attempt Supabase storage download first.  The local report IS
        # the evidence document; storage download is only a fallback.
        pdf_path: str | None = None
        try:
            pdf_result = generate_claim_evidence_pdf(
                organization_id=str(row_org),
                submission_id=str(row.get("id")),
                claim_data=row,
                upload_to_storage=True,
            )
            pdf_path = pdf_result.get("local_pdf_path")
            if not pdf_result.get("ok") or not pdf_path:
                raise RuntimeError(pdf_result.get("error") or "generate_claim_evidence_pdf failed")
            print(
                f"[claim-agent] generate_claim_evidence_pdf succeeded — PDF at: {pdf_path}",
                flush=True,
            )
        except Exception as _pdf_err:
            print(
                f"[WARNING] generate_claim_evidence_pdf failed: {_pdf_err} — "
                "attempting Supabase storage fallback.",
                flush=True,
            )
            # Fallback: try to pull from Supabase Storage if available.
            try:
                pdf_path = agent.resolve_evidence_pdf_path(row.get("report_url"))
                if pdf_path:
                    print(
                        f"[claim-agent] Falling back to existing evidence PDF path: {pdf_path}",
                        flush=True,
                    )
            except Exception as _fb_err:
                print(
                    f"[WARNING] Storage PDF fallback also failed: {_fb_err}",
                    flush=True,
                )
                pdf_path = None

        if pdf_path is None:
            print(
                "[WARNING] No PDF evidence path resolved — continuing without upload.",
                flush=True,
            )
        else:
            print(
                f"[claim-agent] Using generated PDF for upload: {pdf_path}",
                flush=True,
            )

        def run_one() -> tuple[bool, Any]:
            print("[DEBUG] Worker thread: run_one() entered", flush=True)
            _local_pdf = pdf_path  # capture for cleanup
            try:
                outcome = agent.run_selenium_navigation(
                    amazon_order_id=amazon_order_id,
                    claim_type=claim_type,
                    evidence_pdf_path=_local_pdf,
                    submission_id=submission_id,
                    claim_data=row,
                )
                return (outcome is not None, outcome)
            finally:
                # Clean up generated PDF after upload attempt.
                if _local_pdf and os.path.isfile(_local_pdf):
                    try:
                        os.remove(_local_pdf)
                    except OSError:
                        pass

        print(
            "[DEBUG] Scheduling agent on asyncio thread pool (asyncio.to_thread) — event loop stays free.",
            flush=True,
        )
        ok, message = await asyncio.to_thread(run_one)
        print("[DEBUG] asyncio.to_thread(run_one) completed.", flush=True)

        if ok and isinstance(message, dict):
            # Agent already synced case ID + status to Supabase; use its reported status.
            new_status = message.get("status", "submitted")
            scraped_case_id = message.get("amazon_case_id")
        else:
            # Failure path — agent did not reach Supabase; write "failed" here.
            new_status = "failed"
            scraped_case_id = None
            try:
                sb.table("claim_submissions").update({"status": new_status}).eq(
                    "id", submission_id
                ).execute()
            except Exception as up_e:
                print(
                    f"[main] Warning: could not update failed status for {submission_id}: {up_e}",
                    flush=True,
                )

        results.append(
            {
                "submission_id": submission_id,
                "ok": ok,
                "amazon_order_id": amazon_order_id,
                "amazon_case_id": scraped_case_id,
                "status_updated": new_status,
                "detail": message.get("message") if isinstance(message, dict) else message,
            }
        )

    return {
        "ok": True,
        "processed": len(results),
        "results": results,
    }


# 4. Landing Zone Endpoint for Live Amazon Data
@app.post("/sync/order")
async def save_raw_amazon_order(order: AmazonOrderSync):
    sb = _require_supabase()
    try:
        data = {
            "organization_id": order.org_id,
            "store_id": order.store_id,
            "amazon_order_id": order.amazon_order_id,
            "raw_data": order.raw_data,
            "status": "synced",
        }
        sb.table("marketplace_orders").upsert(data).execute()
        return {"status": "success", "message": "Order synced to Landing Zone"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
if __name__ == "__main__":
    import uvicorn
    print("[main] Starting server on http://localhost:8000 ...", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=8000)