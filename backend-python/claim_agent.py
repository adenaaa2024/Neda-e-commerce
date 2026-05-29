# ==============================
# SECTION: PDF GENERATION
# ==============================

# ==============================
# SECTION: DB / SUPABASE
# ==============================

# ==============================
# SECTION: BROWSER / SELENIUM
# ==============================

"""
Seller Central FBA Reimbursement — "My issue is not listed" flow.

Flow:
  1. Load Help Hub browse-issue URL.
  2. Switch to hub / contact-us iframe.
  3. Click "My issue is not listed".
  4. Wait for the "What do you need help with?" textarea.
  5. Fill textarea with a structured claim message.
  6. Upload evidence PDF via aggressive file-input scan.
  7. Click Continue / Submit (meld-default-continue preferred).
  8. Wait for confirmation page; scrape Amazon Case ID via regex.
  9. Sync case ID and final status to Supabase (claim_submissions).
"""

from __future__ import annotations
from pathlib import Path
from dotenv import load_dotenv

import asyncio
import datetime
import json
import os
import re
import tempfile
import time
import unicodedata
from typing import Any

# reportlab — PDF generation (pip install reportlab)
from reportlab.lib import colors as _rl_colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    HRFlowable,
    PageBreak,
    PageTemplate,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

_env_dir = Path(__file__).resolve().parent
_env_file = _env_dir / ".env"
load_dotenv(dotenv_path=_env_file)
print("ENGINE:", os.getenv("CLAIM_BROWSER_ENGINE"))
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

from supabase import create_client, Client, SupabaseException
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import (
    StaleElementReferenceException,
    TimeoutException,
    WebDriverException,
)
from webdriver_manager.chrome import ChromeDriverManager

from amazon_kat_reimbursement import deep_query_all

from claim_report_service import generate_claim_evidence_pdf, generate_claim_report
from claim_repository import ClaimRepository
from selenium_case_opener import ClaimProcessorAgent as SeleniumCaseOpener
from playwright_case_opener import PlaywrightCaseOpener

# Browser engine selection: default selenium, optional playwright
# Set env var CLAIM_BROWSER_ENGINE=playwright to activate the Playwright path.
_CLAIM_BROWSER_ENGINE = os.getenv("CLAIM_BROWSER_ENGINE", "selenium").lower()

# Amazon "What steps have you taken already?" — Playwright payload always sends non-empty text.
_DEFAULT_AMAZON_STEPS_TEXT = (
    "I reviewed the order, generated the attached reimbursement report, and am submitting "
    "this claim with the supporting PDF evidence for Amazon review."
)


def _normalized_source_payload_dict(
    claim_data: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """
    ``source_payload`` may be a dict (Supabase client) or a JSON string (exports /
    some API paths).  Returns a dict or *None*.
    """
    if not claim_data:
        return None
    sp = claim_data.get("source_payload")
    if sp is None:
        return None
    if isinstance(sp, dict):
        return sp
    if isinstance(sp, str):
        raw = sp.strip()
        if not raw:
            return None
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def _steps_text_from_claim_data(claim_data: dict[str, Any] | None) -> str:
    """Prefer explicit steps from submission/claim row; else default reimbursement sentence."""
    if claim_data:
        for key in ("steps_text", "steps_taken", "steps", "issue_steps"):
            v = claim_data.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()
        sp = _normalized_source_payload_dict(claim_data)
        if sp:
            for key in ("steps_text", "steps_taken", "steps"):
                v = sp.get(key)
                if isinstance(v, str) and v.strip():
                    return v.strip()
    return _DEFAULT_AMAZON_STEPS_TEXT


def _asin_value_from_source_payload(claim_data: dict[str, Any] | None) -> str:
    """Fallback ASIN from ``source_payload`` only (after ``returns.asin``)."""
    sp = _normalized_source_payload_dict(claim_data)
    if not sp:
        return ""
    for key in ("asin", "ASIN", "asin_value"):
        v = sp.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def _asin_from_return_row(ret: dict[str, Any] | None) -> str:
    if not isinstance(ret, dict):
        return ""
    av = ret.get("asin")
    return av.strip() if isinstance(av, str) and av.strip() else ""


def _resolve_asin_value_for_browser_payload(
    *,
    repo: ClaimRepository,
    organization_id: str,
    submission_id: str | None,
    claim_data: dict[str, Any] | None,
) -> tuple[str, str]:
    """
    ASIN for the Playwright payload.

    Priority: (1) related ``returns.asin`` via repository, (2) ``source_payload`` ASIN keys,
    else empty.  Returns ``(asin_value, source_tag)`` where *source_tag* is
    ``\"returns.asin\"``, ``\"source_payload.asin\"``, or ``\"missing\"``.
    """
    if submission_id:
        try:
            ret = repo.get_return_for_submission(
                submission_id,
                organization_id or None,
            )
            got = _asin_from_return_row(ret)
            if got:
                return got, "returns.asin"
        except Exception as exc:
            _log(
                f"_resolve_asin_value_for_browser_payload: "
                f"get_return_for_submission failed: {type(exc).__name__}: {exc}"
            )

    if claim_data:
        rid = claim_data.get("return_id")
        if isinstance(rid, str) and rid.strip():
            try:
                ret2 = repo.get_return_item_by_id(
                    rid.strip(),
                    organization_id or None,
                )
                got2 = _asin_from_return_row(ret2)
                if got2:
                    return got2, "returns.asin"
            except Exception as exc:
                _log(
                    f"_resolve_asin_value_for_browser_payload: "
                    f"get_return_item_by_id failed: {type(exc).__name__}: {exc}"
                )

    sp_asin = _asin_value_from_source_payload(claim_data)
    if sp_asin:
        return sp_asin, "source_payload.asin"
    return "", "missing"


if _CLAIM_BROWSER_ENGINE == "playwright":
    # PlaywrightCaseOpener does not accept organization_id; wrap it so that
    # existing call sites (ClaimProcessorAgent(org_id)) stay compatible.
    class _PlaywrightAdapter(PlaywrightCaseOpener):
        def __init__(self, organization_id: str | None = None, **kwargs):  # noqa: ANN001
            super().__init__(**kwargs)
            self.org_id = (organization_id or "").strip()
            self.repo = ClaimRepository(self.org_id)

        def resolve_evidence_pdf_path(self, report_url: str | None) -> str | None:  # noqa: ANN001
            # PlaywrightCaseOpener has no Supabase Storage dependency.
            # Return None so main.py falls through to the locally-generated PDF.
            return None

        def run_selenium_navigation(
            self,
            amazon_order_id: str,
            claim_type: str,
            evidence_pdf_path: str | None = None,
            *,
            submission_id: str | None = None,
            claim_data: dict | None = None,
        ) -> dict | None:
            """
            Bridge: maps the Selenium call signature used by main.py to
            PlaywrightCaseOpener.submit_not_listed_claim().

            Builds help/steps/reference for the Amazon form; steps_text is always
            non-empty (explicit claim data or default). Supabase sync is handled
            by the caller (main.py) using the returned dict.
            """
            reference_text = (amazon_order_id or "").strip()
            steps_text = _steps_text_from_claim_data(claim_data)

            explicit_help = ""
            if claim_data:
                for key in ("help_text", "claim_message", "message"):
                    v = claim_data.get(key)
                    if isinstance(v, str) and v.strip():
                        explicit_help = v.strip()
                        break

            auto_help = ""
            if reference_text:
                auto_help = (
                    f"Filing a reimbursement claim for Order ID: {reference_text}. "
                    f"Issue type: {claim_type}. "
                    "Please refer to the attached PDF evidence."
                )
            help_text = explicit_help or auto_help

            asin_value, asin_source = _resolve_asin_value_for_browser_payload(
                repo=self.repo,
                organization_id=self.org_id,
                submission_id=submission_id,
                claim_data=claim_data,
            )
            payload: dict[str, Any] = {
                "amazon_order_id": amazon_order_id,
                "claim_type": claim_type,
                "steps_text": steps_text,
                "reference_text": reference_text,
                "asin_value": asin_value,
            }
            if explicit_help:
                payload["help_text"] = explicit_help

            print(f"[claim-agent] asin_value={asin_value!r}", flush=True)
            print(
                f"[claim-agent] asin source={asin_source!r}",
                flush=True,
            )
            print(
                f"[claim-agent] payload help_len={len(help_text or '')} "
                f"steps_len={len(steps_text or '')} ref_len={len(reference_text or '')}",
                flush=True,
            )

            self.start()
            try:
                result = self.submit_not_listed_claim(
                    payload=payload,
                    pdf_path=evidence_pdf_path,
                )
            finally:
                self.stop()
            # main.py treats (outcome is not None) as success; return None whenever
            # Playwright reports ok=False so we never mark a submission submitted on failure.
            if not result.get("ok"):
                return None

            amazon_case_id = result.get("amazon_case_id")
            final_status = result.get("status", "submitted")
            print(
                f"[claim-agent] amazon_case_id resolved: {amazon_case_id!r}",
                flush=True,
            )
            if submission_id and amazon_case_id:
                try:
                    self.repo.update_result(submission_id, amazon_case_id, final_status)
                    print(
                        "[claim-agent] claim_submissions updated with amazon_case_id",
                        flush=True,
                    )
                except Exception as _repo_exc:
                    print(
                        f"[claim-agent] repo.update_result failed: "
                        f"{type(_repo_exc).__name__}: {_repo_exc}",
                        flush=True,
                    )

            return result

    ClaimProcessorAgent = _PlaywrightAdapter  # type: ignore[assignment]
else:
    ClaimProcessorAgent = SeleniumCaseOpener  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# Entry URL
# ---------------------------------------------------------------------------
BROWSE_ISSUE_HUB_URL = "https://sellercentral.amazon.com/help/hub/support/browse-issue"

# ---------------------------------------------------------------------------
# Tunable timeouts
# ---------------------------------------------------------------------------
_LOG_PREFIX = "[claim-agent]"
_SETTLE_SEC = 2.0
_HUB_LOAD_WAIT = 3.0          # after driver.get() before scanning iframes
_NOT_LISTED_TIMEOUT = 25.0    # max seconds to find + click "My issue is not listed"
_FORM_APPEAR_TIMEOUT = 25.0   # max seconds to wait for the help textarea
_CONTINUE_POST_CLICK_WAIT = 4.0
_CONFIRMATION_WAIT_SEC = 12.0  # max seconds to wait for the post-submit confirmation page

# Text signals that indicate the confirmation/success page has loaded.
_CONFIRMATION_MARKERS = (
    "case id",
    "case #",
    "case number",
    "case created",
    "your case",
    "thank you",
    "we have received",
    "submitted successfully",
    "request received",
    "issue submitted",
)

# Regex to extract Amazon Case ID — matches "Case ID: 12345678901" and common variants.
# Amazon case IDs are typically 11 digits but we accept 5–20 to be future-safe.
_CASE_ID_RE = re.compile(
    r"[Cc]ase\s*(?:ID|Id|id|#|Number|number)?\s*[:#]?\s*(\d{5,20})",
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# JavaScript snippets
# ---------------------------------------------------------------------------

# Deep shadow-root walk to find <input type="file">.
_JS_FILE_INPUT_DEEP = """
(function() {
  function pick(root) {
    if (!root || !root.querySelector) return null;
    var inp = root.querySelector('input[type="file"]');
    if (inp) return inp;
    var nodes = root.querySelectorAll('*');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) {
        var x = pick(nodes[i].shadowRoot);
        if (x) return x;
      }
    }
    return null;
  }
  return pick(document);
})()
"""

# Prefer kat-button#meld-default-continue; click inner <button> in shadow root.
_JS_MELD_CONTINUE = """
(function() {
  function innerBtn(host) {
    if (!host || !host.shadowRoot) return null;
    return host.shadowRoot.querySelector('button') || null;
  }
  function walk(root, depth) {
    if (!root || depth < 0) return null;
    try {
      var kb = root.querySelector('kat-button#meld-default-continue');
      if (kb) { var b = innerBtn(kb); if (b) return b; }
    } catch (e) {}
    var nodes;
    try { nodes = root.querySelectorAll('*'); } catch (e2) { return null; }
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) {
        var f = walk(nodes[i].shadowRoot, depth - 1);
        if (f) return f;
      }
    }
    return null;
  }
  var btn = walk(document, 16);
  if (!btn) return { ok: false, reason: 'not_found' };
  try { btn.click(); return { ok: true }; }
  catch (e) { return { ok: false, reason: String(e) }; }
})()
"""

# Broad scan: kat-button shadow roots first, then plain buttons/links.
_JS_BROAD_CONTINUE = """
(function() {
  function normText(el) {
    return ((el.textContent || el.innerText || '') + '').replace(/\\s+/g, ' ').trim();
  }
  function isContinue(el) {
    var t = normText(el).toLowerCase();
    return t === 'continue' || t === 'submit' || t === 'send';
  }
  function tryClick(el) {
    if (!el) return false;
    try { el.click(); return true; } catch (e) { return false; }
  }
  function scanRoot(root, depth) {
    if (!root || depth < 0) return false;
    try {
      var kbs = root.querySelectorAll('kat-button');
      for (var i = 0; i < kbs.length; i++) {
        var kb = kbs[i];
        if (!kb.shadowRoot) continue;
        var inner = kb.shadowRoot.querySelector('button');
        if (inner && (isContinue(inner) || isContinue(kb)) && tryClick(inner)) return true;
      }
    } catch (e) {}
    try {
      var els = root.querySelectorAll('button, a, [role="button"]');
      for (var j = 0; j < els.length; j++) {
        if (isContinue(els[j]) && tryClick(els[j])) return true;
      }
    } catch (e2) {}
    try {
      var all = root.querySelectorAll('*');
      for (var k = 0; k < all.length; k++) {
        if (all[k].shadowRoot && scanRoot(all[k].shadowRoot, depth - 1)) return true;
      }
    } catch (e3) {}
    return false;
  }
  return scanRoot(document, 16);
})()
"""

# ---------------------------------------------------------------------------
# FIX: "My issue is not listed" — wrapper-div-aware, four-layer click cascade.
#
# Real DOM structure (confirmed from live page inspection):
#   <div class="button-select" id="issueNotListedButton">   ← wrapper; ID is HERE
#     <kat-button ...>                                       ← no id on kat-button
#       #shadow-root (open)
#         <button>...</button>                              ← real clickable target
#     </kat-button>
#   </div>
#
# Old code assumed:  document.querySelector('kat-button#issueNotListedButton')
# This ALWAYS fails because the id is on the wrapper div, NOT on kat-button.
#
# Fix layers (in priority order):
#   1. Find wrapper by #issueNotListedButton (any element).
#   2. Descend into child kat-button → shadowRoot → inner <button> → click.
#   3. Click wrapper or kat-button directly if shadow not available.
#   4. Deep-text fallback: walk entire DOM (+ all shadow roots) for visible text
#      "my issue is not listed" and click the deepest native button found.
# ---------------------------------------------------------------------------
_JS_ISSUE_NOT_LISTED = """
(function() {
  // ── helpers ──────────────────────────────────────────────────────────────
  function scrollDoc() {
    // Scroll the iframe's own window, not the top document.
    try { window.scrollTo(0, document.documentElement.scrollHeight); } catch(e) {}
    try { document.documentElement.scrollTop = document.documentElement.scrollHeight; } catch(e) {}
    try { document.body && (document.body.scrollTop = document.body.scrollHeight); } catch(e) {}
  }
  function scrollCenter(el) {
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch(e) {}
  }
  function tryClick(el) {
    if (!el) return false;
    scrollCenter(el);
    try { el.click(); return true; } catch(e) {}
    try {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    } catch(e2) {}
    return false;
  }
  // Walk el's shadowRoot (and nested shadow roots) to find innermost <button>.
  function innerBtn(host, depth) {
    if (!host || depth < 0) return null;
    var root = host.shadowRoot || host;
    var btn;
    try { btn = root.querySelector('button'); } catch(e) {}
    if (btn) return btn;
    var nodes;
    try { nodes = root.querySelectorAll('*'); } catch(e) { return null; }
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) {
        var f = innerBtn(nodes[i], depth - 1);
        if (f) return f;
      }
    }
    return null;
  }
  // Deep text-based element scan across all shadow roots.
  function deepTextScan(root, wantText, depth, acc) {
    if (!root || depth < 0) return;
    var sels;
    try { sels = root.querySelectorAll('kat-button, button, [role="button"], div[id*="issue"]'); }
    catch(e) { sels = []; }
    for (var i = 0; i < sels.length; i++) {
      var el = sels[i];
      var txt = ((el.innerText || el.textContent || '')).trim().toLowerCase();
      if (txt.indexOf(wantText) !== -1) acc.push(el);
    }
    var nodes;
    try { nodes = root.querySelectorAll('*'); } catch(e) { return; }
    for (var j = 0; j < nodes.length; j++) {
      if (nodes[j].shadowRoot) deepTextScan(nodes[j].shadowRoot, wantText, depth - 1, acc);
    }
  }
  // Single synchronous attempt: layers 1–2.
  function attempt() {
    scrollDoc();
    // ── Layer 1: find wrapper by id (ANY tag) ───────────────────────────────
    var wrapper = null;
    try { wrapper = document.querySelector('#issueNotListedButton'); } catch(e) {}
    if (wrapper) {
      var wTag = (wrapper.tagName || '').toLowerCase();
      console.log('[hub] wrapper found: tag=' + wTag);
      // 1a: wrapper is a kat-button itself
      if (wTag === 'kat-button') {
        var b = innerBtn(wrapper, 12);
        if (b && tryClick(b)) return { ok: true, via: 'wrapper_kat_inner' };
        if (tryClick(wrapper)) return { ok: true, via: 'wrapper_kat_host' };
      }
      // 1b: wrapper contains a descendant kat-button
      var katChild = null;
      try { katChild = wrapper.querySelector('kat-button'); } catch(e) {}
      if (katChild) {
        console.log('[hub] descendant kat-button found');
        var ib = innerBtn(katChild, 12);
        if (ib && tryClick(ib)) return { ok: true, via: 'wrapper_kat_child_inner' };
        if (tryClick(katChild))  return { ok: true, via: 'wrapper_kat_child_host' };
      }
      // 1c: click the wrapper itself (div.button-select etc.)
      if (tryClick(wrapper)) return { ok: true, via: 'wrapper_direct' };
    }

    // ── Layer 2: deep text scan ─────────────────────────────────────────────
    var acc = [];
    deepTextScan(document, 'my issue is not listed', 16, acc);
    if (!acc.length) deepTextScan(document, "my issue isn't listed", 16, acc);
    console.log('[hub] text-scan candidates: ' + acc.length);
    for (var k = acc.length - 1; k >= 0; k--) {
      var cand = acc[k];
      var cTag = (cand.tagName || '').toLowerCase();
      if (cTag === 'kat-button') {
        var cb = innerBtn(cand, 12);
        if (cb && tryClick(cb)) return { ok: true, via: 'text_scan_kat_inner' };
      }
      if (tryClick(cand)) return { ok: true, via: 'text_scan_direct' };
    }

    return null;  // not found this round
  }

  // ── Polling loop: retry for up to 3 000 ms in 300 ms ticks ───────────────
  // (Synchronous busy-wait via Date.now() — acceptable for a one-shot helper.)
  var deadline = Date.now() + 3000;
  var tick = 300;
  do {
    var res = attempt();
    if (res) return res;
    // spin-wait one tick
    var end = Date.now() + tick;
    while (Date.now() < end) { /* busy wait */ }
  } while (Date.now() < deadline);

  return { ok: false, reason: 'not_found_after_3s_polling' };
})()
"""

# ---------------------------------------------------------------------------
# JS — deep multi-field form fill helpers
# ---------------------------------------------------------------------------

# Locate the native <textarea> or <input> inside a kat-textarea / kat-input host.
_JS_INNER_FIELD_IN_KAT = """
(function() {
  var host = arguments[0];
  var maxDepth = arguments[1] != null ? arguments[1] : 12;
  if (!host) return null;
  function walk(root, depth) {
    if (!root || depth < 0) return null;
    var ta; try { ta = root.querySelector('textarea'); } catch(e) {}
    if (ta) return ta;
    var inp; try { inp = root.querySelector('input:not([type="hidden"])'); } catch(e) {}
    if (inp) return inp;
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return null; }
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) { var f = walk(nodes[i].shadowRoot, depth - 1); if (f) return f; }
    }
    return null;
  }
  if (host.shadowRoot) { var x = walk(host.shadowRoot, maxDepth); if (x) return x; }
  return walk(host, maxDepth);
})()
"""

# Set value on input / textarea via native prototype setter + full event suite.
_JS_SET_VALUE_EVENTS = """
(function() {
  var el  = arguments[0];
  var val = arguments[1];
  if (!el) return { ok: false, reason: 'no_element' };
  try { el.focus(); } catch(e) {}
  var tag   = (el.tagName || '').toLowerCase();
  var proto = (tag === 'textarea')
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  var desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) { desc.set.call(el, val); } else { el.value = val; }
  function ev(type, Ctor) {
    try { el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true })); } catch(e) {}
  }
  ev('keydown',  KeyboardEvent);
  ev('keypress', KeyboardEvent);
  ev('input',    InputEvent);
  ev('keyup',    KeyboardEvent);
  ev('change',   Event);
  try { el.blur(); } catch(e) {}
  return { ok: true, value: el.value };
})()
"""

# Read current value of a field element.
_JS_GET_FIELD_VALUE = """
(function() {
  var el = arguments[0];
  if (!el) return '';
  try { return el.value || ''; } catch(e) { return ''; }
})()
"""

# Collect label text candidates by walking up to 5 ancestors.
_JS_ANCESTOR_LABEL = """
(function() {
  var el = arguments[0];
  var n = el;
  for (var i = 0; i < 5; i++) {
    if (!n) break;
    n = n.parentElement;
    if (!n) break;
    var lbls = n.querySelectorAll('label, kat-label, [class*="label"]');
    for (var j = 0; j < lbls.length; j++) {
      var t = ((lbls[j].innerText || lbls[j].textContent || '')).trim().toLowerCase();
      if (t) return t;
    }
  }
  return '';
})()
"""

# Markers that confirm we are in the correct hub iframe.
# 'issuenotlistedbutton' appears in the serialised DOM of the hub frame.
_HUB_IFRAME_MARKERS = (
    "issuenotlistedbutton",
    "my issue is not listed",
    "my issue isn't listed",
    "contact us",
    "help center",
    "browse-issue",
)

# Markers for the simple "describe your issue" form.
_FORM_MARKERS = (
    "what do you need help with",
    "describe your issue",
    "describe issue",
    "tell us more",
    "additional information",
)


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------

def _log(msg: str) -> None:
    print(f"{_LOG_PREFIX} {msg}", flush=True)


# TODO: migrate remaining browser helper to selenium_case_opener.py
def _safe_js(driver, label: str, script: str, *args: Any) -> Any:
    """Execute JS; log + return None on any WebDriver error."""
    try:
        return driver.execute_script(script, *args)
    except WebDriverException as e:
        _log(f"JS error [{label}]: {e}")
        return None


# TODO: migrate this DB call to ClaimRepository — replace with ClaimRepository.resolve_amazon_order_id_from_row(row)
def resolve_amazon_order_id_from_row(row: dict[str, Any]) -> str | None:
    """Resolve Amazon order ID from a claim_submissions row (delegates to ClaimRepository)."""
    from claim_repository import ClaimRepository

    return ClaimRepository.resolve_amazon_order_id_from_row(row)


# ---------------------------------------------------------------------------
# PDF report generation — standalone, reusable, no Selenium dependency
# ---------------------------------------------------------------------------

#: Default directory for generated claim reports.  Falls back to the OS temp
#: dir when the env var is absent.
_PDF_OUTPUT_DIR: str = (
    os.getenv("CLAIM_PDF_OUTPUT_DIR") or tempfile.gettempdir()
)


# TODO: moved to claim_report_service.py; remove after validation
'''
def _safe_text(val: Any, fallback: str = "N/A", max_len: int = 2000) -> str:
    """
    Convert *val* to a printable, unicode-safe string.

    * None / empty → *fallback*
    * Strips control characters (keeps newlines/tabs)
    * Truncates to *max_len* characters
    """
    if val is None:
        return fallback
    try:
        s = str(val).strip()
    except Exception:
        return fallback
    if not s:
        return fallback
    # Remove non-printable control chars (except \n, \t)
    cleaned = "".join(
        ch for ch in s
        if ch in ("\n", "\t") or not unicodedata.category(ch).startswith("C")
    )
    cleaned = cleaned.strip()
    if not cleaned:
        return fallback
    if len(cleaned) > max_len:
        cleaned = cleaned[:max_len] + "… [truncated]"
    return cleaned
'''


# TODO: moved to claim_report_service.py; remove after validation
'''
def _flatten_claim_data_for_report(claim_data: dict[str, Any]) -> dict[str, str]:
    """
    Normalize a claim_submissions row (or any claim dict) into a flat
    {label: value} mapping suitable for PDF rendering.

    Handles deeply nested structures; never raises.
    """
    flat: dict[str, str] = {}

    # ── Primary identifiers ───────────────────────────────────────────────
    flat["Submission ID"] = _safe_text(claim_data.get("id") or claim_data.get("submission_id"))
    flat["Organization ID"] = _safe_text(claim_data.get("org_id") or claim_data.get("organization_id"))
    flat["Status"] = _safe_text(claim_data.get("status"))

    # ── Amazon Order ID — check common locations ──────────────────────────
    order_id: str = "N/A"
    for key in ("amazon_order_id", "order_id", "amazonOrderId"):
        v = claim_data.get(key)
        if isinstance(v, str) and v.strip():
            order_id = v.strip()
            break
    if order_id == "N/A":
        payload = claim_data.get("source_payload")
        if isinstance(payload, dict):
            for key in ("amazon_order_id", "amazonOrderId", "order_id"):
                v = payload.get(key)
                if isinstance(v, str) and v.strip():
                    order_id = v.strip()
                    break
    if order_id == "N/A":
        ret = claim_data.get("returns")
        if isinstance(ret, list) and ret:
            ret = ret[0]
        if isinstance(ret, dict):
            v = ret.get("order_id")
            if isinstance(v, str) and v.strip():
                order_id = v.strip()
    flat["Amazon Order ID"] = order_id

    # ── Claim type ────────────────────────────────────────────────────────
    ct = claim_data.get("claim_type") or claim_data.get("type")
    if not ct:
        payload = claim_data.get("source_payload")
        if isinstance(payload, dict):
            ct = payload.get("claim_type") or payload.get("type")
    flat["Claim Type"] = _safe_text(ct)

    # ── Timestamps ────────────────────────────────────────────────────────
    flat["Created At"] = _safe_text(
        claim_data.get("created_at") or claim_data.get("created")
    )
    flat["Updated At"] = _safe_text(
        claim_data.get("updated_at") or claim_data.get("updated")
    )

    # ── Claim summary / notes ─────────────────────────────────────────────
    notes = claim_data.get("notes") or claim_data.get("note") or claim_data.get("description")
    flat["Notes / Description"] = _safe_text(notes)

    # ── Reference numbers ─────────────────────────────────────────────────
    ref = (
        claim_data.get("reference_text")
        or claim_data.get("reference_number")
        or claim_data.get("reference")
    )
    flat["Reference Numbers"] = _safe_text(ref)

    # ── Evidence info ─────────────────────────────────────────────────────
    evidence = claim_data.get("evidence")
    if isinstance(evidence, dict):
        flat["Evidence"] = _safe_text(
            evidence.get("description") or evidence.get("summary") or str(evidence)
        )
    elif evidence is not None:
        flat["Evidence"] = _safe_text(evidence)
    else:
        flat["Evidence"] = "N/A"

    # ── Amazon case ID (if already known) ────────────────────────────────
    flat["Amazon Case ID"] = _safe_text(
        claim_data.get("amazon_case_id") or claim_data.get("case_id")
    )

    # ── Report URL ────────────────────────────────────────────────────────
    flat["Report URL"] = _safe_text(claim_data.get("report_url"))

    # ── Source payload (compact JSON excerpt) ────────────────────────────
    payload = claim_data.get("source_payload")
    if isinstance(payload, dict):
        import json as _json
        try:
            payload_str = _json.dumps(payload, indent=2, ensure_ascii=False)
        except Exception:
            payload_str = str(payload)
        flat["Source Payload (excerpt)"] = _safe_text(payload_str, max_len=800)
    else:
        flat["Source Payload (excerpt)"] = _safe_text(payload, max_len=800)

    return flat
'''


# TODO: moved to claim_report_service.py; remove after validation
'''
def _build_claim_report_lines(flat: dict[str, str]) -> list[tuple[str, str]]:
    """
    Return an ordered list of (label, value) pairs for rendering in the PDF.

    Fields are grouped by importance so the most critical info appears first.
    Fields whose value is 'N/A' are still included but de-emphasised at render
    time so the reader can see that the field was checked.
    """
    priority_keys = [
        "Amazon Order ID",
        "Claim Type",
        "Submission ID",
        "Organization ID",
        "Status",
        "Amazon Case ID",
        "Created At",
        "Updated At",
        "Reference Numbers",
        "Notes / Description",
        "Evidence",
        "Report URL",
        "Source Payload (excerpt)",
    ]
    lines: list[tuple[str, str]] = []
    seen: set[str] = set()
    for k in priority_keys:
        if k in flat:
            lines.append((k, flat[k]))
            seen.add(k)
    # Any extra keys the caller added
    for k, v in flat.items():
        if k not in seen:
            lines.append((k, v))
    return lines
'''

'''  # generate_claim_report — disabled; imported from claim_report_service
# ===== PDF =====
def generate_claim_report(
    claim_data: dict[str, Any],
    output_dir: str | None = None,
) -> str:
    """
    Build a human-readable PDF claim report and write it to disk.

    Parameters
    ----------
    claim_data:
        Any dict that carries claim information — typically a
        ``claim_submissions`` Supabase row, but also accepts the loose dicts
        used elsewhere in the system.
    output_dir:
        Directory to write the PDF into.  Defaults to ``CLAIM_PDF_OUTPUT_DIR``
        env var or the OS temporary directory.

    Returns
    -------
    str
        Absolute path of the generated PDF file.

    Raises
    ------
    RuntimeError
        When the PDF cannot be written after all retry attempts.
    """
    _log("Generating claim PDF report…")

    # ── Resolve output directory ──────────────────────────────────────────
    out_dir = output_dir or _PDF_OUTPUT_DIR
    try:
        os.makedirs(out_dir, exist_ok=True)
    except OSError as exc:
        _log(f"Cannot create PDF output dir {out_dir!r}: {exc} — falling back to tempdir.")
        out_dir = tempfile.gettempdir()

    # ── Build filename ────────────────────────────────────────────────────
    flat = _flatten_claim_data_for_report(claim_data)
    sub_id = flat.get("Submission ID", "unknown").replace("/", "-").replace("\\", "-")
    order_id = flat.get("Amazon Order ID", "unknown").replace("/", "-").replace("\\", "-")
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    filename = f"claim-report-{sub_id}-{order_id}-{ts}.pdf"
    # Sanitize filename for Windows
    for ch in r'<>:"|?*':
        filename = filename.replace(ch, "_")
    pdf_path = os.path.abspath(os.path.join(out_dir, filename))

    # ── Build reportlab story ─────────────────────────────────────────────
    doc = SimpleDocTemplate(
        pdf_path,
        pagesize=A4,
        leftMargin=2 * cm,
        rightMargin=2 * cm,
        topMargin=2.5 * cm,
        bottomMargin=2.5 * cm,
        title=f"Claim Report — {order_id}",
        author="ecommerce-os claim-agent",
    )

    styles = getSampleStyleSheet()
    style_title = ParagraphStyle(
        "ClaimTitle",
        parent=styles["Title"],
        fontSize=18,
        spaceAfter=6,
        textColor=_rl_colors.HexColor("#1a1a2e"),
    )
    style_subtitle = ParagraphStyle(
        "ClaimSubtitle",
        parent=styles["Normal"],
        fontSize=10,
        textColor=_rl_colors.HexColor("#555555"),
        spaceAfter=12,
    )
    style_section = ParagraphStyle(
        "SectionHeader",
        parent=styles["Heading2"],
        fontSize=11,
        textColor=_rl_colors.HexColor("#16213e"),
        spaceBefore=10,
        spaceAfter=4,
        borderPad=2,
    )
    style_label = ParagraphStyle(
        "FieldLabel",
        parent=styles["Normal"],
        fontSize=9,
        textColor=_rl_colors.HexColor("#333333"),
        fontName="Helvetica-Bold",
    )
    style_value = ParagraphStyle(
        "FieldValue",
        parent=styles["Normal"],
        fontSize=9,
        textColor=_rl_colors.HexColor("#111111"),
        leading=13,
        wordWrap="CJK",
    )
    style_na = ParagraphStyle(
        "FieldNA",
        parent=style_value,
        textColor=_rl_colors.HexColor("#aaaaaa"),
    )

    story: list = []

    # Title block
    story.append(Paragraph("Amazon Seller Central — Claim Report", style_title))
    story.append(
        Paragraph(
            f"Generated: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')} UTC",
            style_subtitle,
        )
    )
    story.append(HRFlowable(width="100%", thickness=1.5, color=_rl_colors.HexColor("#1a1a2e")))
    story.append(Spacer(1, 0.4 * cm))

    # Summary section — key identifiers as a compact 2-col table
    summary_pairs = [
        ("Amazon Order ID", flat.get("Amazon Order ID", "N/A")),
        ("Claim Type", flat.get("Claim Type", "N/A")),
        ("Submission ID", flat.get("Submission ID", "N/A")),
        ("Organization ID", flat.get("Organization ID", "N/A")),
        ("Status", flat.get("Status", "N/A")),
        ("Amazon Case ID", flat.get("Amazon Case ID", "N/A")),
        ("Created At", flat.get("Created At", "N/A")),
        ("Updated At", flat.get("Updated At", "N/A")),
    ]
    story.append(Paragraph("Summary", style_section))
    tbl_data = [
        [
            Paragraph(_safe_text(lbl), style_label),
            Paragraph(_safe_text(val) if val != "N/A" else "—", style_na if val == "N/A" else style_value),
        ]
        for lbl, val in summary_pairs
    ]
    tbl = Table(tbl_data, colWidths=[4.5 * cm, None], hAlign="LEFT")
    tbl.setStyle(
        TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), _rl_colors.HexColor("#eef1f7")),
            ("ROWBACKGROUNDS", (0, 0), (-1, -1), [_rl_colors.white, _rl_colors.HexColor("#f7f9fc")]),
            ("GRID", (0, 0), (-1, -1), 0.4, _rl_colors.HexColor("#cccccc")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ])
    )
    story.append(tbl)
    story.append(Spacer(1, 0.5 * cm))

    # Detail fields
    detail_keys = [
        "Reference Numbers",
        "Notes / Description",
        "Evidence",
        "Report URL",
        "Source Payload (excerpt)",
    ]
    story.append(Paragraph("Details", style_section))
    story.append(HRFlowable(width="100%", thickness=0.5, color=_rl_colors.HexColor("#cccccc")))
    story.append(Spacer(1, 0.2 * cm))

    for key in detail_keys:
        val = flat.get(key, "N/A")
        story.append(Paragraph(key, style_label))
        # Newlines → <br/> for Paragraph
        escaped = val.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        escaped_br = escaped.replace("\n", "<br/>")
        st = style_na if val == "N/A" else style_value
        story.append(Paragraph(escaped_br if val != "N/A" else "—", st))
        story.append(Spacer(1, 0.25 * cm))

    # Any extra keys not already rendered
    rendered = {
        "Amazon Order ID", "Claim Type", "Submission ID", "Organization ID",
        "Status", "Amazon Case ID", "Created At", "Updated At",
        "Reference Numbers", "Notes / Description", "Evidence",
        "Report URL", "Source Payload (excerpt)",
    }
    extras = [(k, v) for k, v in flat.items() if k not in rendered]
    if extras:
        story.append(Paragraph("Additional Fields", style_section))
        story.append(HRFlowable(width="100%", thickness=0.5, color=_rl_colors.HexColor("#cccccc")))
        story.append(Spacer(1, 0.2 * cm))
        for key, val in extras:
            story.append(Paragraph(key, style_label))
            escaped = val.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            escaped_br = escaped.replace("\n", "<br/>")
            st = style_na if val == "N/A" else style_value
            story.append(Paragraph(escaped_br if val != "N/A" else "—", st))
            story.append(Spacer(1, 0.25 * cm))

    # Footer rule
    story.append(Spacer(1, 0.5 * cm))
    story.append(HRFlowable(width="100%", thickness=0.5, color=_rl_colors.HexColor("#cccccc")))
    story.append(
        Paragraph(
            f"ecommerce-os · claim-agent · {datetime.datetime.now().strftime('%Y-%m-%d')}",
            style_subtitle,
        )
    )

    # ── Write PDF ─────────────────────────────────────────────────────────
    try:
        doc.build(story)
    except Exception as exc:
        raise RuntimeError(f"[claim-agent] PDF build failed for {pdf_path!r}: {exc}") from exc

    if not os.path.isfile(pdf_path):
        raise RuntimeError(f"[claim-agent] PDF file missing after build: {pdf_path!r}")

    _log(f"Claim PDF generated at: {pdf_path}")
    return pdf_path
'''  # end generate_claim_report — disabled


# ---------------------------------------------------------------------------
# Supabase logo helper
# ---------------------------------------------------------------------------

_LOGO_BUCKET = "claim-reports"
_LOGO_STORAGE_PATH = "files/logos/logo-amazon.jpeg"

# ===== DB =====
# TODO: moved to claim_report_service.py; remove after validation
'''
def _download_logo_from_supabase(supabase_client=None) -> str | None:
    """
    Download ``claim-reports/files/logos/logo-amazon.jpeg`` from Supabase
    Storage to a temporary local JPEG file.

    Parameters
    ----------
    supabase_client:
        An already-initialised Supabase ``Client``.  When *None* a new client
        is created from ``SUPABASE_URL`` / ``SUPABASE_SERVICE_ROLE_KEY`` env vars.

    Returns
    -------
    str | None
        Absolute path of the temporary file, or *None* on any failure.
        Never raises.
    """
    client = supabase_client
    if client is None:
        url = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
        key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        if not (url and key):
            _log("Logo: missing Supabase credentials — skipping logo download.")
            return None
        try:
            from supabase import create_client as _cc
            client = _cc(url, key)
        except Exception as _e:
            _log(f"Logo: could not create Supabase client: {_e}")
            return None

    try:
        raw = client.storage.from_(_LOGO_BUCKET).download(_LOGO_STORAGE_PATH)
        if not raw:
            _log("Logo: empty response from Supabase Storage.")
            return None
        fd, tmp = tempfile.mkstemp(suffix=".jpeg", prefix="claim_logo_")
        os.close(fd)
        with open(tmp, "wb") as fh:
            fh.write(raw)
        _log(f"Logo downloaded → {tmp!r}")
        return tmp
    except Exception as exc:
        _log(f"Logo download failed ({_LOGO_BUCKET}/{_LOGO_STORAGE_PATH}): {exc}")
        return None
'''


# ---------------------------------------------------------------------------
# Bulk-report PDF — mimics the 'claims-bulk-report' two-page format
# ---------------------------------------------------------------------------

#: Brand text rendered on every page header and footer.
_COMPANY_NAME = "Sam Distribution Inc"
_DOC_SUBTITLE = "FBA claim submission \u00b7 Seller reimbursement evidence"
_FOOTER_BRAND = "E-commerce OS"

# Colour palette (Amazon brand + neutral greys)
_C_NAVY   = _rl_colors.HexColor("#1a1a2e")   # dark-navy header background
_C_AMZN   = _rl_colors.HexColor("#FF9900")   # Amazon orange
_C_DARK   = _rl_colors.HexColor("#232f3e")   # dark table-header / section bars
_C_GREY_L = _rl_colors.HexColor("#f2f3f4")   # alternating-row light grey
_C_GREY_B = _rl_colors.HexColor("#cccccc")   # border / rule colour
_C_MID_G  = _rl_colors.HexColor("#666666")   # secondary text / labels
_C_WHITE  = _rl_colors.white
_C_TEXT   = _rl_colors.HexColor("#111111")   # primary body text

# Page-chrome dimensions (module-level so Frame and chrome share the same values)
_HEADER_H: float = 2.8 * cm
_FOOTER_H: float = 0.9 * cm


# TODO: moved to claim_report_service.py; remove after validation
'''
def _xml_esc(text: str) -> str:
    """Escape XML entities so ReportLab Paragraph doesn't choke on raw data."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
'''


# TODO: moved to claim_report_service.py; remove after validation
'''
def _extract_bulk_report_fields(claim_data: dict[str, Any]) -> dict[str, Any]:
    """
    Normalise a ``claim_submissions`` row (or equivalent dict) into a flat
    mapping ready for the bulk-report PDF.  Never raises.
    """
    payload: dict = claim_data.get("source_payload") or {}

    # ── Item name ─────────────────────────────────────────────────────────
    item_name = _safe_text(
        claim_data.get("item_name") or payload.get("item_name")
        or payload.get("title") or payload.get("product_name") or payload.get("name"),
        fallback="—",
    )

    # ── Amazon Order ID ───────────────────────────────────────────────────
    order_id = _safe_text(
        claim_data.get("amazon_order_id") or claim_data.get("order_id")
        or payload.get("amazon_order_id") or payload.get("order_id")
        or payload.get("amazonOrderId"),
        fallback="—",
    )

    # ── Claim / defect type ───────────────────────────────────────────────
    claim_type = _safe_text(
        claim_data.get("claim_type") or payload.get("claim_type")
        or payload.get("defect_type") or payload.get("type"),
        fallback="FBA_CLAIM",
    )

    # ── Status ────────────────────────────────────────────────────────────
    status_raw     = _safe_text(claim_data.get("status"), fallback="ready_to_send")
    status_display = status_raw.replace("_", " ").title()

    # ── Submission / claim ID ─────────────────────────────────────────────
    claim_id = _safe_text(
        claim_data.get("id") or claim_data.get("submission_id"), fallback="—"
    )

    # ── Product identifiers ───────────────────────────────────────────────
    asin  = _safe_text(claim_data.get("asin")  or payload.get("asin"),  fallback="—")
    sku   = _safe_text(claim_data.get("sku")   or payload.get("sku"),   fallback="—")
    fnsku = _safe_text(claim_data.get("fnsku") or payload.get("fnsku"), fallback="—")

    # ── Logistics ─────────────────────────────────────────────────────────
    pallet_num = _safe_text(
        payload.get("pallet_number") or payload.get("pallet_id") or payload.get("pallet"),
        fallback="—",
    )
    package_num = _safe_text(
        payload.get("package_number") or payload.get("package_id") or payload.get("package"),
        fallback="—",
    )
    tracking = _safe_text(
        payload.get("tracking") or payload.get("tracking_number") or payload.get("trackingNumber"),
        fallback="—",
    )
    carrier = _safe_text(
        payload.get("carrier") or payload.get("carrier_name"), fallback="—"
    )

    # ── Claim financials ──────────────────────────────────────────────────
    amount_raw   = _safe_text(
        payload.get("amount") or payload.get("reimbursement_amount")
        or claim_data.get("amount"), fallback="—",
    )
    filed_amount = _safe_text(
        payload.get("filed_amount") or payload.get("amount")
        or claim_data.get("amount"), fallback="—",
    )

    # ── Case ID / link status ─────────────────────────────────────────────
    case_id     = _safe_text(
        claim_data.get("amazon_case_id") or claim_data.get("case_id"), fallback="—"
    )
    link_status = _safe_text(payload.get("link_status"), fallback="—")

    # ── Operator notes ────────────────────────────────────────────────────
    notes = _safe_text(
        claim_data.get("notes") or claim_data.get("description")
        or payload.get("notes") or payload.get("comments"),
        fallback=(
            "Add operator notes, carrier context, or Seller Central "
            "case references here (optional)."
        ),
    )

    # ── Photo placeholder labels (mirrors the sample document) ────────────
    photo_labels: list[str] = list(payload.get("photo_labels") or [
        "Damaged Outer Box (closed)", "Outer Box", "Opened Box",
        "Box Label", "Packing Slip / Manifest (package)", "Defective Item Condition",
        "Expiry Label",
    ])

    return {
        "item_name":      item_name,
        "order_id":       order_id,
        "claim_type":     claim_type,
        "status_display": status_display,
        "claim_id":       claim_id,
        "asin":           asin,
        "sku":            sku,
        "fnsku":          fnsku,
        "pallet_num":     pallet_num,
        "package_num":    package_num,
        "tracking":       tracking,
        "carrier":        carrier,
        "amount":         amount_raw,
        "filed_amount":   filed_amount,
        "case_id":        case_id,
        "link_status":    link_status,
        "notes":          notes,
        "photo_labels":   photo_labels,
    }
'''


# TODO: moved to claim_report_service.py; remove after validation
'''
def _draw_amazon_text(canvas: Any, x: float, y: float) -> None:
    """Render 'amazon' in the brand orange as a logo text-placeholder."""
    canvas.setFillColor(_C_AMZN)
    canvas.setFont("Helvetica-Bold", 12)
    canvas.drawString(x, y, "amazon")
'''


# TODO: moved to claim_report_service.py; remove after validation
'''
def _draw_bulk_report_chrome(
    canvas: Any,
    doc: Any,
    logo_path: str | None,
    fields: dict[str, Any],
) -> None:
    """
    Draw the repeating header band and page-specific footer on the canvas.
    Registered as the ``onPage`` callback so it fires on every page.
    """
    W, H = A4
    page_num: int = doc.page

    canvas.saveState()

    # ── Header background (full-width navy bar) ───────────────────────────
    canvas.setFillColor(_C_NAVY)
    canvas.rect(0, H - _HEADER_H, W, _HEADER_H, fill=1, stroke=0)

    # ── Company name ──────────────────────────────────────────────────────
    canvas.setFillColor(_C_WHITE)
    canvas.setFont("Helvetica-Bold", 13)
    canvas.drawString(2 * cm, H - 1.35 * cm, _COMPANY_NAME)

    # ── Document subtitle ─────────────────────────────────────────────────
    canvas.setFillColor(_rl_colors.HexColor("#bbbbbb"))
    canvas.setFont("Helvetica", 8.5)
    canvas.drawString(2 * cm, H - 1.95 * cm, _DOC_SUBTITLE)

    # ── MARKETPLACE badge (amber pill, right of header) ───────────────────
    badge_w = 2.4 * cm
    badge_h = 0.38 * cm
    badge_x = W - 2 * cm - 3.8 * cm - badge_w - 0.3 * cm
    badge_y = H - 0.78 * cm
    canvas.setFillColor(_C_AMZN)
    canvas.roundRect(badge_x, badge_y - badge_h, badge_w, badge_h, 2, fill=1, stroke=0)
    canvas.setFillColor(_C_WHITE)
    canvas.setFont("Helvetica-Bold", 6.5)
    canvas.drawCentredString(
        badge_x + badge_w / 2, badge_y - badge_h + 0.07 * cm, "MARKETPLACE"
    )

    # ── Logo image (or amazon text placeholder) ───────────────────────────
    logo_w = 3.0 * cm
    logo_h = _HEADER_H - 0.6 * cm
    logo_x = W - 2 * cm - logo_w
    logo_y = H - _HEADER_H + 0.3 * cm

    if logo_path and os.path.isfile(logo_path):
        try:
            canvas.drawImage(
                logo_path,
                logo_x, logo_y,
                width=logo_w, height=logo_h,
                preserveAspectRatio=True,
            )
        except Exception:
            _draw_amazon_text(canvas, logo_x, logo_y + logo_h * 0.35)
    else:
        _draw_amazon_text(canvas, logo_x, logo_y + logo_h * 0.35)

    # ── Footer rule ───────────────────────────────────────────────────────
    canvas.setStrokeColor(_C_GREY_B)
    canvas.setLineWidth(0.5)
    canvas.line(2 * cm, _FOOTER_H + 0.15 * cm, W - 2 * cm, _FOOTER_H + 0.15 * cm)

    # ── Footer text (page-specific) ───────────────────────────────────────
    if page_num == 1:
        footer_text = f"Page 1 \u00b7 Master summary \u00b7 {_FOOTER_BRAND}"
    else:
        footer_text = (
            f"Item 1 of 1 \u00b7 {fields['claim_id']} "
            f"\u00b7 Page {page_num} \u00b7 {_FOOTER_BRAND}"
        )

    canvas.setFillColor(_C_MID_G)
    canvas.setFont("Helvetica", 7.5)
    canvas.drawCentredString(W / 2, 0.3 * cm, footer_text)

    canvas.restoreState()
'''

'''  # generate_bulk_report_pdf — disabled; imported from claim_report_service
# ===== PDF =====
def generate_bulk_report_pdf(
    claim_data: dict[str, Any],
    output_dir: str | None = None,
    supabase_client=None,
) -> str:
    """
    Build a two-page PDF evidence package that mimics the
    ``claims-bulk-report`` format and write it to disk.

    * **Page 1** — Master summary: batch-selection header, intro paragraph,
      and a line-item table (Item Name / Order ID / Defect Type / Status /
      Photo / Detail).
    * **Page 2** — Detail view: Identifiers (ASIN, FNSKU, SKU), Logistics
      (pallet, package, tracking, carrier), Claim info (type, order, amount,
      case ID), operator notes, and a photo-placeholder grid.

    The company logo is fetched from Supabase Storage
    (``claim-reports/files/logos/logo-amazon.jpeg``).  If the download fails
    for any reason, the word *amazon* is rendered in Amazon orange as a
    text placeholder so the PDF is always generated.

    Parameters
    ----------
    claim_data:
        A ``claim_submissions`` Supabase row or any dict containing claim
        information.
    output_dir:
        Target directory.  Defaults to the ``CLAIM_PDF_OUTPUT_DIR`` env var
        or the OS temporary directory.
    supabase_client:
        Optional already-initialised Supabase ``Client`` (avoids a redundant
        ``create_client`` call during bulk processing).

    Returns
    -------
    str
        Absolute path of the generated PDF file.

    Raises
    ------
    RuntimeError
        When the PDF cannot be written after the build attempt.
    """
    _log("Generating bulk-report PDF (claims-bulk-report format, 2 pages)…")

    # ── Output directory + filename ───────────────────────────────────────
    out_dir = output_dir or _PDF_OUTPUT_DIR
    try:
        os.makedirs(out_dir, exist_ok=True)
    except OSError:
        out_dir = tempfile.gettempdir()

    fields = _extract_bulk_report_fields(claim_data)
    ts     = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    safe_oid = fields["order_id"]
    for ch in r'<>:"/\\|?*':
        safe_oid = safe_oid.replace(ch, "-")
    filename = f"claim-bulk-{safe_oid}-{ts}.pdf"
    pdf_path = os.path.abspath(os.path.join(out_dir, filename))

    # ── Logo (non-fatal) ─────────────────────────────────────────────────
    logo_tmp: str | None = None
    try:
        logo_tmp = _download_logo_from_supabase(supabase_client)
    except Exception as _le:
        _log(f"Logo download error (non-fatal): {_le}")

    # ── Paragraph styles ──────────────────────────────────────────────────
    _ss = getSampleStyleSheet()

    def _mk(name: str, **kw: Any) -> ParagraphStyle:
        return ParagraphStyle(name, parent=_ss["Normal"], **kw)

    sty_pkg_title  = _mk("BR_PkgTitle",  fontSize=12, fontName="Helvetica-Bold",
                          textColor=_C_DARK,  spaceAfter=2, spaceBefore=4)
    sty_pkg_sub    = _mk("BR_PkgSub",    fontSize=8,  textColor=_C_MID_G, spaceAfter=8)
    sty_intro      = _mk("BR_Intro",     fontSize=9.5, textColor=_C_TEXT,
                          spaceAfter=6, leading=14)
    sty_sec_lbl    = _mk("BR_SecLbl",    fontSize=9,  fontName="Helvetica-Bold",
                          textColor=_C_TEXT,  spaceAfter=3)
    sty_body       = _mk("BR_Body",      fontSize=9,  textColor=_C_TEXT,
                          spaceAfter=3, leading=13)
    sty_small      = _mk("BR_Small",     fontSize=8,  textColor=_C_MID_G, spaceAfter=2)
    sty_sign       = _mk("BR_Sign",      fontSize=9,  textColor=_C_MID_G, spaceAfter=2)
    sty_sign_name  = _mk("BR_SignName",  fontSize=10, fontName="Helvetica-Bold",
                          textColor=_C_TEXT,  spaceAfter=4)
    sty_sec_hdr    = _mk("BR_SecHdr",    fontSize=7.5, fontName="Helvetica-Bold",
                          textColor=_C_WHITE, spaceAfter=0)
    sty_kv_lbl     = _mk("BR_KVLbl",    fontSize=8,  fontName="Helvetica-Bold",
                          textColor=_C_MID_G)
    sty_kv_val     = _mk("BR_KVVal",    fontSize=9,  textColor=_C_TEXT, leading=13)
    sty_id_name    = _mk("BR_IDName",   fontSize=10, fontName="Helvetica-Bold",
                          textColor=_C_DARK,  spaceBefore=4, spaceAfter=3)
    sty_notes      = _mk("BR_Notes",    fontSize=8.5, textColor=_C_MID_G, leading=13)
    sty_photo_hdr  = _mk("BR_PhotoHdr", fontSize=10, fontName="Helvetica-Bold",
                          textColor=_C_DARK,  spaceBefore=6, spaceAfter=5)
    sty_photo_lbl  = _mk("BR_PhotoLbl", fontSize=7.5, textColor=_C_MID_G, alignment=1)
    sty_tbl_hdr    = _mk("BR_TblHdr",   fontSize=7.5, fontName="Helvetica-Bold",
                          textColor=_C_WHITE, spaceAfter=0)

    # ── Page template (BaseDocTemplate + Frame + onPage chrome) ───────────
    W, H  = A4
    lm    = 2 * cm
    rm    = 2 * cm
    bw    = W - lm - rm   # usable body width

    body_frame = Frame(
        lm,
        _FOOTER_H + 0.55 * cm,
        bw,
        H - _HEADER_H - _FOOTER_H - 1.05 * cm,
        leftPadding=0, rightPadding=0,
        topPadding=0.45 * cm, bottomPadding=0,
        id="body",
    )

    def _on_page(canvas: Any, doc: Any) -> None:
        _draw_bulk_report_chrome(canvas, doc, logo_tmp, fields)

    page_tpl = PageTemplate(id="main", frames=[body_frame], onPage=_on_page)
    doc_obj  = BaseDocTemplate(
        pdf_path,
        pagesize=A4,
        pageTemplates=[page_tpl],
        title=f"FBA Claim Evidence \u00b7 {fields['order_id']}",
        author=_COMPANY_NAME,
        leftMargin=lm, rightMargin=rm,
        topMargin=_HEADER_H, bottomMargin=_FOOTER_H + 0.55 * cm,
    )

    # ── Section-bar + key-value-table helpers ─────────────────────────────
    def _sec(label: str) -> Table:
        """Dark coloured section-header bar."""
        t = Table([[Paragraph(label, sty_sec_hdr)]], colWidths=[bw])
        t.setStyle(TableStyle([
            ("BACKGROUND",    (0, 0), (-1, -1), _C_DARK),
            ("TOPPADDING",    (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("LEFTPADDING",   (0, 0), (-1, -1), 8),
            ("RIGHTPADDING",  (0, 0), (-1, -1), 8),
        ]))
        return t

    def _kv(rows: list[tuple[str, str]]) -> Table:
        """2-column key-value table with alternating row backgrounds."""
        data = [
            [
                Paragraph(_xml_esc(k), sty_kv_lbl),
                Paragraph(_xml_esc(v), sty_kv_val),
            ]
            for k, v in rows
        ]
        t = Table(data, colWidths=[bw * 0.28, bw * 0.72])
        t.setStyle(TableStyle([
            ("ROWBACKGROUNDS", (0, 0), (-1, -1), [_C_WHITE, _C_GREY_L]),
            ("GRID",           (0, 0), (-1, -1), 0.3, _C_GREY_B),
            ("TOPPADDING",     (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING",  (0, 0), (-1, -1), 4),
            ("LEFTPADDING",    (0, 0), (-1, -1), 8),
            ("RIGHTPADDING",   (0, 0), (-1, -1), 8),
            ("VALIGN",         (0, 0), (-1, -1), "TOP"),
        ]))
        return t

    # ── Story ─────────────────────────────────────────────────────────────
    story: list = []

    # ════════════════════════════════════════════════════════════ PAGE 1 ══
    story.append(Paragraph("Claim evidence package", sty_pkg_title))
    story.append(Paragraph("BATCH SELECTION \u00b7 1 line item", sty_pkg_sub))
    story.append(
        Paragraph(
            f"To Amazon Seller Support, please review the evidence "
            f"regarding order <b>{_xml_esc(fields['order_id'])}</b>.",
            sty_intro,
        )
    )
    story.append(Spacer(1, 0.2 * cm))
    story.append(Paragraph("Master summary \u2014 line items", sty_sec_lbl))
    story.append(Spacer(1, 0.1 * cm))

    # Line-item summary table
    _col_ws = [bw * 0.27, bw * 0.18, bw * 0.17, bw * 0.16, bw * 0.08, bw * 0.14]
    summary_data = [
        [Paragraph(h, sty_tbl_hdr) for h in
         ["ITEM NAME", "ORDER ID", "DEFECT TYPE", "STATUS", "PHOTO", "DETAIL"]],
        [
            Paragraph(_xml_esc(fields["item_name"]),      sty_body),
            Paragraph(_xml_esc(fields["order_id"]),       sty_body),
            Paragraph(_xml_esc(fields["claim_type"]),     sty_body),
            Paragraph(_xml_esc(fields["status_display"]), sty_body),
            Paragraph("\u2014",                           sty_small),
            Paragraph("p. 2",                             sty_body),
        ],
    ]
    summary_tbl = Table(summary_data, colWidths=_col_ws)
    summary_tbl.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (-1, 0), _C_DARK),
        ("BACKGROUND",    (0, 1), (-1, -1), _C_WHITE),
        ("GRID",          (0, 0), (-1, -1), 0.4, _C_GREY_B),
        ("TOPPADDING",    (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING",   (0, 0), (-1, -1), 6),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 6),
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story.append(summary_tbl)
    story.append(Spacer(1, 0.8 * cm))

    # Signature block
    story.append(Paragraph("Respectfully,", sty_sign))
    story.append(Paragraph(_COMPANY_NAME,   sty_sign_name))

    story.append(PageBreak())

    # ════════════════════════════════════════════════════════════ PAGE 2 ══
    story.append(Paragraph("Claim evidence package", sty_pkg_title))
    story.append(
        Paragraph(
            f"Item 1 of 1 \u00b7 {_xml_esc(fields['claim_id'])} "
            f"\u00b7 Issue: {_xml_esc(fields['claim_type'])}",
            sty_pkg_sub,
        )
    )
    story.append(Spacer(1, 0.2 * cm))

    # IDENTIFIERS
    story.append(_sec("IDENTIFIERS"))
    story.append(Paragraph(_xml_esc(fields["item_name"]), sty_id_name))
    story.append(_kv([
        ("ASIN",  f"{fields['asin']} \u00b7 search"),
        ("FNSKU", f"{fields['fnsku']} \u00b7 search"),
        ("SKU",   f"{fields['sku']} \u00b7 search"),
    ]))
    story.append(Spacer(1, 0.3 * cm))

    # LOGISTICS
    story.append(_sec("LOGISTICS"))
    story.append(_kv([
        ("Pallet #",  fields["pallet_num"]),
        ("Package #", fields["package_num"]),
        ("Tracking",  fields["tracking"]),
        ("Carrier",   fields["carrier"]),
    ]))
    story.append(Spacer(1, 0.3 * cm))

    # CLAIM
    story.append(_sec("CLAIM"))
    amt_str = (
        f"{fields['amount']} (filed: {fields['filed_amount']})"
        if fields["amount"] != "\u2014"
        else "\u2014"
    )
    story.append(_kv([
        ("Type",        fields["claim_type"]),
        ("Order ID",    fields["order_id"]),
        ("Amount",      amt_str),
        ("Case ID",     fields["case_id"]),
        ("Link status", fields["link_status"]),
    ]))
    story.append(Spacer(1, 0.3 * cm))

    # NOTES / COMMENTS
    story.append(_sec("NOTES / COMMENTS"))
    notes_tbl = Table(
        [[Paragraph(_xml_esc(fields["notes"]), sty_notes)]],
        colWidths=[bw],
    )
    notes_tbl.setStyle(TableStyle([
        ("BOX",           (0, 0), (-1, -1), 0.5, _C_GREY_B),
        ("BACKGROUND",    (0, 0), (-1, -1), _C_GREY_L),
        ("TOPPADDING",    (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING",   (0, 0), (-1, -1), 8),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 8),
    ]))
    story.append(notes_tbl)
    story.append(Spacer(1, 0.3 * cm))

    # Photographic evidence (3-column grid of placeholder boxes)
    story.append(Paragraph("Photographic evidence", sty_photo_hdr))
    photo_labels = fields["photo_labels"]
    PHOTO_COLS   = 3
    box_w        = bw / PHOTO_COLS
    box_h        = 2.4 * cm
    photo_rows: list = []
    for i in range(0, len(photo_labels), PHOTO_COLS):
        chunk = photo_labels[i : i + PHOTO_COLS]
        while len(chunk) < PHOTO_COLS:
            chunk.append("")
        photo_rows.append([Paragraph(lbl, sty_photo_lbl) for lbl in chunk])

    if photo_rows:
        photo_tbl = Table(
            photo_rows,
            colWidths=[box_w] * PHOTO_COLS,
            rowHeights=[box_h] * len(photo_rows),
        )
        photo_tbl.setStyle(TableStyle([
            ("BOX",           (0, 0), (-1, -1), 0.5, _C_GREY_B),
            ("INNERGRID",     (0, 0), (-1, -1), 0.5, _C_GREY_B),
            ("BACKGROUND",    (0, 0), (-1, -1), _C_GREY_L),
            ("VALIGN",        (0, 0), (-1, -1), "BOTTOM"),
            ("ALIGN",         (0, 0), (-1, -1), "CENTER"),
            ("TOPPADDING",    (0, 0), (-1, -1), 2),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING",   (0, 0), (-1, -1), 4),
            ("RIGHTPADDING",  (0, 0), (-1, -1), 4),
        ]))
        story.append(photo_tbl)

    # ── Build PDF ─────────────────────────────────────────────────────────
    try:
        doc_obj.build(story)
    except Exception as exc:
        raise RuntimeError(
            f"[claim-agent] Bulk-report PDF build failed for {pdf_path!r}: {exc}"
        ) from exc

    if not os.path.isfile(pdf_path):
        raise RuntimeError(
            f"[claim-agent] Bulk-report PDF missing after build: {pdf_path!r}"
        )

    # ── Cleanup temp logo ─────────────────────────────────────────────────
    if logo_tmp and os.path.isfile(logo_tmp):
        try:
            os.remove(logo_tmp)
        except OSError:
            pass

    _log(f"Bulk-report PDF generated at: {pdf_path}")
    return pdf_path
'''  # end generate_bulk_report_pdf — disabled


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------
# TODO: moved to selenium_case_opener.py; safe to remove after validation
# ===== BROWSER =====
'''  # ClaimProcessorAgent — disabled; imported from selenium_case_opener
class ClaimProcessorAgent:
    """
    Selenium agent that files a Seller Central help case via the
    'My issue is not listed' path.
    """

    def __init__(self, organization_id: str):
        self.org_id = organization_id
        # TODO: moved to claim_repository.py; safe to remove after validation
        # NOTE: self.supabase is kept active here because run_selenium_navigation
        # still passes it to generate_bulk_report_pdf for logo download.
        self.supabase_url = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
        self.supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        try:
            self.supabase: Client = create_client(self.supabase_url, self.supabase_key)
        except SupabaseException as e:
            if not self.supabase_url:
                print(
                    "[!] Supabase client could not be created: SUPABASE_URL (or "
                    "NEXT_PUBLIC_SUPABASE_URL) is missing or empty. Set one of them in "
                    "backend-python/.env."
                )
            else:
                print(f"[!] Supabase client could not be created: {e}")
            raise

        self.repo = ClaimRepository(self.org_id)

        self._chrome_debugger = (os.getenv("CHROME_DEBUGGER_ADDRESS") or "").strip()
        self._mock_submit = (os.getenv("CLAIM_AGENT_MOCK_SUBMIT") or "").lower() in (
            "1",
            "true",
            "yes",
        )
        if self._mock_submit:
            _log("CLAIM_AGENT_MOCK_SUBMIT enabled — form filled but Submit skipped.")

    # ------------------------------------------------------------------
    # PDF: Supabase Storage → local temp file
    # ------------------------------------------------------------------

    # TODO: moved to claim_repository.py; safe to remove after validation
    def resolve_evidence_pdf_path(self, report_url: str | None) -> str | None:
        """
        `claim_submissions.report_url` is usually a Supabase Storage object path
        under bucket `claim-reports`.  Returns a local path for Selenium send_keys
        on <input type=file>.  Never raises — missing PDF is OK.
        """
        # Delegated to ClaimRepository — full resolution logic lives there.
        return self.repo.resolve_evidence_pdf_path(report_url)
        # ── DISABLED (original body preserved below for reference) ────────────
        # if not report_url or not str(report_url).strip():
        #     print("[WARNING] No report_url in database; proceeding without PDF upload.", flush=True)
        #     _log("No report_url; no PDF upload.")
        #     return None
        # p = str(report_url).strip()
        # if p.lower() in ("generated_locally", "none", "null"):
        #     _log(f"report_url is placeholder {p!r}; no PDF upload.")
        #     return None
        # if os.path.isfile(p):
        #     ab = os.path.abspath(p)
        #     _log(f"Using existing local evidence file: {ab}")
        #     return ab
        # if p.startswith("http://") or p.startswith("https://"):
        #     try:
        #         import urllib.request
        #         fd, tmp = tempfile.mkstemp(suffix=".pdf", prefix="claim_evidence_")
        #         os.close(fd)
        #         _log("Downloading evidence PDF from URL…")
        #         urllib.request.urlretrieve(p, tmp)
        #         _log(f"Evidence saved to {tmp}")
        #         return tmp
        #     except Exception as e:
        #         print(f"[WARNING] Failed to download report URL (continuing without PDF): {e}", flush=True)
        #         _log(f"URL download failed: {e}")
        #         return None
        # bucket = (os.getenv("SUPABASE_REPORTS_BUCKET") or "claim-reports").strip()
        # try:
        #     data = self.supabase.storage.from_(bucket).download(p)
        #     if not data:
        #         _log(f"Storage download empty for {bucket!r}/{p!r}")
        #         return None
        #     fd, tmp = tempfile.mkstemp(suffix=".pdf", prefix="claim_evidence_")
        #     os.close(fd)
        #     with open(tmp, "wb") as f:
        #         f.write(data)
        #     _log(f"Downloaded evidence from storage {bucket!r}/{p!r} → {tmp}")
        #     return tmp
        # except Exception as e:
        #     print(f"[WARNING] Storage PDF download failed (continuing without PDF): {e}", flush=True)
        #     _log(f"Storage download failed ({bucket!r}/{p!r}): {e}")
        #     return None

    # ------------------------------------------------------------------
    # Driver
    # ------------------------------------------------------------------

    def _attach_driver(self):
        """Attach to existing Chrome (CHROME_DEBUGGER_ADDRESS) or launch fresh."""
        if self._chrome_debugger:
            _log(f"Attaching to Chrome via debuggerAddress={self._chrome_debugger!r}")
            opts = webdriver.ChromeOptions()
            opts.add_experimental_option("debuggerAddress", self._chrome_debugger)
            driver = webdriver.Chrome(options=opts)
            return driver, False
        _log("Launching new Chrome (set CHROME_DEBUGGER_ADDRESS to reuse a logged-in session).")
        opts = webdriver.ChromeOptions()
        driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=opts)
        return driver, True

    # ------------------------------------------------------------------
    # Iframe utilities
    # ------------------------------------------------------------------

    def _page_source_lower(self, driver) -> str:
        try:
            return (driver.page_source or "").lower()
        except WebDriverException:
            return ""

    def _frame_has_markers(self, driver, *markers: str) -> bool:
        ps = self._page_source_lower(driver)
        return any(m.lower() in ps for m in markers)

    def _switch_to_hub_iframe(self, driver) -> bool:
        """
        Switch into the hub / contact-us iframe where tiles live.
        Prefers id/name/src containing 'hub', 'contact', 'help'.
        Falls back to the first iframe that contains known hub text.
        Returns True when successfully switched.
        """
        try:
            driver.switch_to.default_content()
        except WebDriverException:
            pass

        # Preferred: hub/contact iframe by attribute
        try:
            frames = driver.find_elements(By.CSS_SELECTOR, "iframe, frame")
        except WebDriverException:
            return False
        for fr in frames:
            try:
                attrs = " ".join(filter(None, [
                    fr.get_attribute("id") or "",
                    fr.get_attribute("name") or "",
                    fr.get_attribute("src") or "",
                ])).lower()
                if any(kw in attrs for kw in ("hub", "contact", "help")):
                    driver.switch_to.frame(fr)
                    _log(f"Hub iframe matched by attribute ({attrs[:80]!r}).")
                    return True
            except WebDriverException:
                continue

        # Fallback: any iframe containing hub content markers
        try:
            driver.switch_to.default_content()
            frames = driver.find_elements(By.CSS_SELECTOR, "iframe, frame")
        except WebDriverException:
            return False
        for fr in frames:
            try:
                driver.switch_to.frame(fr)
                if self._frame_has_markers(driver, *_HUB_IFRAME_MARKERS):
                    _log("Hub iframe matched by content markers.")
                    return True
                driver.switch_to.parent_frame()
            except WebDriverException:
                try:
                    driver.switch_to.default_content()
                except WebDriverException:
                    pass
        _log("No hub iframe found — staying in default content.")
        return False

    def _dfs_switch_to_frame_with_markers(
        self,
        driver,
        markers: tuple[str, ...],
        depth: int = 0,
        max_depth: int = 8,
    ) -> bool:
        """
        Recursively descend iframes (DFS). Leaves driver switched into the frame
        where any marker is present.  Returns True on success.
        """
        if self._frame_has_markers(driver, *markers):
            return True
        if depth >= max_depth:
            return False
        try:
            frames = driver.find_elements(By.CSS_SELECTOR, "iframe, frame")
        except WebDriverException:
            return False
        for fr in frames:
            try:
                driver.switch_to.frame(fr)
            except (StaleElementReferenceException, WebDriverException):
                continue
            if self._dfs_switch_to_frame_with_markers(driver, markers, depth + 1, max_depth):
                return True
            try:
                driver.switch_to.parent_frame()
            except WebDriverException:
                try:
                    driver.switch_to.default_content()
                except WebDriverException:
                    pass
        return False

    # ------------------------------------------------------------------
    # Phase 1 — Click "My issue is not listed" (wrapper-div-aware + nested DFS)
    # ------------------------------------------------------------------

    def _js_click_issue_not_listed(self, driver) -> bool:
        """
        Run the wrapper-aware JS compound click in the currently active frame.
        Logs wrapper / kat-button / shadow-root discovery details.
        Returns True on confirmed click.
        """
        try:
            driver.execute_script("try{window.scrollTo(0, document.body.scrollHeight);}catch(e){}")
            time.sleep(0.35)
        except WebDriverException:
            pass

        r = _safe_js(driver, "issueNotListedButton", _JS_ISSUE_NOT_LISTED)
        if isinstance(r, dict) and r.get("ok"):
            _log(f"'My issue is not listed' clicked — via={r.get('via')!r}")
            return True
        if isinstance(r, dict):
            reason = r.get("reason", "unknown")
            _log(f"issueNotListedButton JS miss in current frame — reason={reason!r}")
        else:
            _log(f"issueNotListedButton JS returned unexpected: {r!r}")
        return False

    def _dfs_click_not_listed(
        self,
        driver,
        path: list[str],
        depth: int = 0,
        max_depth: int = 6,
    ) -> bool:
        """
        Recursive DFS across nested iframes.
        At each level: try the JS click, then recurse into child frames.
        Leaves driver in the matching frame context on success.
        """
        # Try in the current (already-entered) frame
        if self._js_click_issue_not_listed(driver):
            _log(f"Clicked in nested iframe path={path!r}")
            return True

        if depth >= max_depth:
            return False

        try:
            child_frames = driver.find_elements(By.CSS_SELECTOR, "iframe, frame")
        except WebDriverException:
            return False

        _log(f"  DFS depth={depth}: {len(child_frames)} child frame(s) at path={path!r}")
        for idx, fr in enumerate(child_frames):
            label = f"idx={idx}"
            try:
                label = (
                    fr.get_attribute("id") or
                    fr.get_attribute("name") or
                    (fr.get_attribute("src") or "")[:50] or
                    label
                )
            except WebDriverException:
                pass
            try:
                driver.switch_to.frame(fr)
            except (StaleElementReferenceException, NoSuchElementException, WebDriverException) as e:
                _log(f"  Could not enter child frame {label!r}: {e}")
                continue
            # Allow Amazon's slow scripts to hydrate the Shadow DOM before
            # running the JS click — without this, shadowRoot is often null.
            _log(f"  Entered frame {label!r}; waiting 1s for Shadow DOM hydration…")
            time.sleep(1.0)
            new_path = path + [label]
            if self._dfs_click_not_listed(driver, new_path, depth + 1, max_depth):
                return True
            try:
                driver.switch_to.parent_frame()
            except WebDriverException:
                try:
                    driver.switch_to.default_content()
                except WebDriverException:
                    pass
        return False

    def _click_not_listed(self, driver, *, timeout: float = _NOT_LISTED_TIMEOUT) -> bool:
        """
        Find and click 'My issue is not listed' using a layered iframe strategy.

        Per-cycle order:
          1. Default content (quick check — no iframe switch needed).
          2. Preferred hub iframe (id/name/src keyword match) + its nested children.
          3. Full DFS of every top-level iframe and their nested children.
        Repeats the whole cycle until *timeout* expires.
        """
        deadline = time.monotonic() + timeout
        cycle = 0
        while time.monotonic() < deadline:
            cycle += 1
            _log(f"_click_not_listed cycle {cycle}…")

            # ── Pass 1: default content ──────────────────────────────────────
            try:
                driver.switch_to.default_content()
            except WebDriverException:
                pass
            if self._js_click_issue_not_listed(driver):
                return True

            # ── Pass 2: preferred hub iframe (keyword) + nested DFS ──────────
            self._switch_to_hub_iframe(driver)          # leaves driver in hub frame
            if self._js_click_issue_not_listed(driver):
                return True
            # Also check nested iframes inside the hub frame
            if self._dfs_click_not_listed(driver, path=["hub"], depth=1):
                return True

            # ── Pass 3: every top-level iframe + nested DFS ──────────────────
            try:
                driver.switch_to.default_content()
                top_frames = driver.find_elements(By.CSS_SELECTOR, "iframe, frame")
            except WebDriverException:
                top_frames = []

            _log(f"  Top-level frames to scan: {len(top_frames)}")
            for idx, fr in enumerate(top_frames):
                label = f"top-{idx}"
                try:
                    label = (
                        fr.get_attribute("id") or
                        fr.get_attribute("name") or
                        (fr.get_attribute("src") or "")[:50] or
                        label
                    )
                except WebDriverException:
                    pass
                try:
                    driver.switch_to.default_content()
                    driver.switch_to.frame(fr)
                except WebDriverException as e:
                    _log(f"  Cannot enter top frame {label!r}: {e}")
                    continue
                # Try in this top frame, then recurse into its nested children
                if self._dfs_click_not_listed(driver, path=[label], depth=1):
                    return True

            try:
                driver.switch_to.default_content()
            except WebDriverException:
                pass
            time.sleep(0.5)

        _log(f"'My issue is not listed' not clicked after {timeout}s — giving up.")
        return False

    # ------------------------------------------------------------------
    # Phase 2 — Textarea form
    # ------------------------------------------------------------------

    def _find_help_textarea(self, driver) -> Any | None:
        """
        Locate the claim description textarea in the current document.
        Checks aria-label / placeholder / name against _FORM_MARKERS,
        then falls back to any visible textarea,
        then tries deep_query_all for shadow-DOM textareas.
        """
        # Labelled textarea
        for attr in ("aria-label", "placeholder", "name"):
            try:
                for el in driver.find_elements(By.TAG_NAME, "textarea"):
                    try:
                        val = (el.get_attribute(attr) or "").lower()
                        if any(m in val for m in _FORM_MARKERS) and el.is_displayed():
                            _log(f"Textarea matched by {attr!r}: {val[:60]!r}")
                            return el
                    except (StaleElementReferenceException, WebDriverException):
                        continue
            except WebDriverException:
                continue

        # Any visible, enabled textarea
        try:
            for el in driver.find_elements(By.TAG_NAME, "textarea"):
                try:
                    if el.is_displayed() and el.is_enabled():
                        _log("Using first visible textarea (no label match).")
                        return el
                except (StaleElementReferenceException, WebDriverException):
                    continue
        except WebDriverException:
            pass

        # Shadow DOM (amazon_kat_reimbursement JS_DEEP_QUERY_ALL semantics)
        try:
            candidates = deep_query_all(driver, "textarea", None, 10)
            for el in candidates:
                try:
                    if el.is_displayed() and el.is_enabled():
                        _log("Textarea found via deep_query_all shadow walk.")
                        return el
                except (StaleElementReferenceException, WebDriverException):
                    continue
        except WebDriverException:
            pass

        return None

    def _wait_for_help_textarea(self, driver, *, timeout: float = _FORM_APPEAR_TIMEOUT) -> Any | None:
        """
        Poll the current document and all iframes for the help textarea.
        Leaves driver focused on the frame containing the textarea.
        Returns the WebElement or None.
        """
        _log(f"Waiting for help textarea (timeout {timeout}s)…")
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            # Current context
            ta = self._find_help_textarea(driver)
            if ta is not None:
                return ta

            # Scan iframes
            try:
                driver.switch_to.default_content()
            except WebDriverException:
                pass
            ta = self._find_help_textarea(driver)
            if ta is not None:
                return ta

            try:
                frames = driver.find_elements(By.CSS_SELECTOR, "iframe, frame")
            except WebDriverException:
                frames = []
            for fr in frames:
                try:
                    driver.switch_to.default_content()
                    driver.switch_to.frame(fr)
                    ta = self._find_help_textarea(driver)
                    if ta is not None:
                        return ta
                except WebDriverException:
                    continue

            try:
                driver.switch_to.default_content()
            except WebDriverException:
                pass
            time.sleep(0.5)

        _log("Help textarea not found after timeout.")
        return None

    @staticmethod
    def _build_claim_message(amazon_order_id: str, claim_type: str) -> str:
        """Template message for the 'What do you need help with?' textarea."""
        return (
            f"Filing a reimbursement claim for Order ID: {amazon_order_id}. "
            f"Issue type: {claim_type}. "
            "Please refer to the attached PDF evidence."
        )

    def _fill_textarea(self, driver, ta, text: str) -> bool:
        """Clear and type text into a textarea with realistic key and input events."""
        t = (text or "").strip()
        if not t:
            return False
        try:
            driver.execute_script("arguments[0].scrollIntoView({block:'center'});", ta)
        except WebDriverException:
            pass
        try:
            ta.click()
        except WebDriverException:
            try:
                driver.execute_script("arguments[0].focus();", ta)
            except WebDriverException as e:
                _log(f"Textarea focus failed: {e}")
                return False
        time.sleep(0.1)
        try:
            ta.clear()
        except WebDriverException:
            try:
                ta.send_keys(Keys.CONTROL, "a")
                ta.send_keys(Keys.DELETE)
            except WebDriverException:
                pass
        time.sleep(0.05)
        try:
            ta.send_keys(t)
        except WebDriverException as e:
            _log(f"Textarea send_keys failed: {e}")
            return False
        try:
            driver.execute_script(
                "var el=arguments[0];"
                "try{el.dispatchEvent(new Event('input',{bubbles:true}));}catch(a){}"
                "try{el.dispatchEvent(new Event('change',{bubbles:true}));}catch(b){}",
                ta,
            )
        except WebDriverException:
            pass
        _log(f"Textarea filled ({len(t)} chars).")
        return True

    # ------------------------------------------------------------------
    # Multi-field form fill (What do you need help with? / Steps / Reference)
    # ------------------------------------------------------------------

    # Keyword sets for semantic scoring of each field.
    _HELP_KWS   = ("what do you need help with", "help with", "describe your issue",
                   "issue description", "message", "details")
    _STEPS_KWS  = ("what steps have you taken", "steps taken", "steps already",
                   "steps you have", "steps")
    _REF_KWS    = ("reference number", "reference numbers", "relevant reference",
                   "order number", "case number", "optional")

    def _resolve_to_native_field(self, driver, el) -> Any | None:
        """If el is a kat-* host, return inner native textarea/input; else return el."""
        try:
            tag = (el.tag_name or "").lower()
        except WebDriverException:
            return None
        if tag in ("kat-textarea", "kat-input"):
            try:
                inner = driver.execute_script(_JS_INNER_FIELD_IN_KAT, el, 12)
                return inner if inner else None
            except WebDriverException:
                return None
        return el

    def _score_field(self, driver, el, keywords: tuple) -> float:
        score = 0.0
        try:
            attrs = " ".join(filter(None, [
                el.get_attribute("placeholder") or "",
                el.get_attribute("aria-label") or "",
                el.get_attribute("name") or "",
                el.get_attribute("id") or "",
                el.get_attribute("label") or "",
            ])).lower()
        except (StaleElementReferenceException, WebDriverException):
            return -999.0
        for kw in keywords:
            if kw in attrs:
                score += 20.0
        try:
            lbl = _safe_js(driver, "ancestor-label", _JS_ANCESTOR_LABEL, el) or ""
            for kw in keywords:
                if kw in lbl:
                    score += 30.0
        except WebDriverException:
            pass
        return score

    def _collect_form_fields(self, driver) -> list:
        """Return all textarea/input candidates (native + kat-* hosts) in current frame."""
        fields = []
        for sel in ("kat-textarea", "kat-input", "textarea", "input:not([type='hidden'])"):
            try:
                fields.extend(deep_query_all(driver, sel, None, 12))
            except WebDriverException:
                pass
        return fields

    def _set_field_value(self, driver, el, value: str, attempts: int = 3) -> bool:
        """
        Set *value* on native input/textarea.
        Tries JS native setter first, then send_keys fallback.
        Verifies the value stuck after each attempt.
        """
        value = str(value)
        for attempt in range(1, attempts + 1):
            # Method 1 — native prototype setter + full event dispatch
            try:
                res = _safe_js(driver, f"set-value-attempt-{attempt}", _JS_SET_VALUE_EVENTS, el, value)
                actual = (_safe_js(driver, "get-value", _JS_GET_FIELD_VALUE, el) or "").strip()
                if actual == value.strip():
                    _log(f"Field value set via native setter (attempt {attempt}, len={len(value)}).")
                    return True
                _log(f"Native setter mismatch: got {actual[:40]!r}")
            except WebDriverException as e:
                _log(f"Native setter JS error: {e}")

            # Method 2 — send_keys fallback
            try:
                try:
                    el.clear()
                except WebDriverException:
                    pass
                el.send_keys(value)
                actual = (_safe_js(driver, "get-value", _JS_GET_FIELD_VALUE, el) or "").strip()
                if actual == value.strip():
                    _log(f"Field value set via send_keys (attempt {attempt}).")
                    return True
                _log(f"send_keys mismatch: got {actual[:40]!r}")
            except WebDriverException as e:
                _log(f"send_keys error: {e}")

            time.sleep(_SETTLE_SEC * 0.4)

        _log(f"WARNING: could not verify field value after {attempts} attempts.")
        return False

    def _fill_form_fields_multi(
        self,
        driver,
        help_text: str,
        steps_text: str,
        reference_text: str,
        timeout: float | None = None,
    ) -> dict[str, bool]:
        """
        Discover and fill up to three form fields semantically.

        Supports kat-textarea, kat-input, textarea, input.
        Resolves kat-* hosts to their inner native elements before setting.
        Returns a dict of {field_name: success_bool}.
        """
        timeout = timeout or _FORM_APPEAR_TIMEOUT
        deadline = time.monotonic() + timeout
        results: dict[str, bool] = {"help": False, "steps": False, "ref": False}

        _log("_fill_form_fields_multi: scanning for fields…")

        while time.monotonic() < deadline:
            all_fields = self._collect_form_fields(driver)
            _log(f"  {len(all_fields)} field candidate(s) found.")

            def best_for(keywords: tuple) -> Any | None:
                scored = []
                for el in all_fields:
                    sc = self._score_field(driver, el, keywords)
                    if sc > 0:
                        native = self._resolve_to_native_field(driver, el)
                        if native:
                            scored.append((sc, native))
                if not scored:
                    return None
                scored.sort(key=lambda x: -x[0])
                _log(f"  Best field for {keywords[0]!r}: score={scored[0][0]:.1f}")
                return scored[0][1]

            help_f  = best_for(self._HELP_KWS)
            steps_f = best_for(self._STEPS_KWS)
            ref_f   = best_for(self._REF_KWS)

            # Positional fallback when scoring finds nothing
            native_list = []
            for el in all_fields:
                nat = self._resolve_to_native_field(driver, el)
                if nat and nat not in native_list:
                    native_list.append(nat)
            if help_f is None and len(native_list) >= 1:
                help_f = native_list[0]
                _log("  help field: positional fallback (index 0).")
            if steps_f is None and len(native_list) >= 2:
                steps_f = native_list[1]
                _log("  steps field: positional fallback (index 1).")
            if ref_f is None and len(native_list) >= 3:
                ref_f = native_list[2]
                _log("  ref field: positional fallback (index 2).")

            if help_text and help_f and not results["help"]:
                results["help"] = self._set_field_value(driver, help_f, help_text)
            if steps_text and steps_f and not results["steps"]:
                results["steps"] = self._set_field_value(driver, steps_f, steps_text)
            if reference_text and ref_f and not results["ref"]:
                results["ref"] = self._set_field_value(driver, ref_f, reference_text)

            all_done = (
                (not help_text  or results["help"]) and
                (not steps_text or results["steps"]) and
                (not reference_text or results["ref"])
            )
            if all_done:
                _log(f"All requested fields filled: {results}")
                return results

            time.sleep(0.4)

        _log(f"_fill_form_fields_multi partial result: {results}")
        return results

    # ------------------------------------------------------------------
    # PDF upload
    # ------------------------------------------------------------------

    @staticmethod
    def _find_file_input_deep(driver) -> Any | None:
        """Find <input type='file'> walking open shadow roots."""
        return _safe_js(driver, "file input deep query", _JS_FILE_INPUT_DEEP)

    def _upload_evidence_pdf_aggressive(self, driver, abs_pdf: str) -> bool:
        """
        Send abs_pdf to the file input.
        Tries current frame → default_content → each iframe (includes shadow-root search).
        """
        if not abs_pdf or not os.path.isfile(abs_pdf):
            _log(f"PDF not on disk: {abs_pdf!r}")
            return False

        def _try_current() -> bool:
            inp = self._find_file_input_deep(driver)
            if inp is None:
                for by, sel in (
                    (By.CSS_SELECTOR, "input[type='file']"),
                    (By.XPATH, "//input[@type='file']"),
                ):
                    try:
                        for el in driver.find_elements(by, sel):
                            inp = el
                            break
                        if inp is not None:
                            break
                    except WebDriverException:
                        pass
            if inp is None:
                return False
            try:
                driver.execute_script(
                    "arguments[0].style.display='block';"
                    "arguments[0].style.visibility='visible';"
                    "arguments[0].style.opacity='1';",
                    inp,
                )
            except WebDriverException:
                pass
            try:
                inp.send_keys(abs_pdf)
                _log(f"PDF sent to file input: {abs_pdf}")
                return True
            except WebDriverException as e:
                _log(f"send_keys to file input failed: {e}")
                return False

        if _try_current():
            return True
        try:
            driver.switch_to.default_content()
        except WebDriverException:
            pass
        if _try_current():
            return True
        try:
            frames = driver.find_elements(By.CSS_SELECTOR, "iframe, frame")
        except WebDriverException:
            frames = []
        for fr in frames:
            try:
                driver.switch_to.default_content()
                driver.switch_to.frame(fr)
                if _try_current():
                    return True
            except WebDriverException:
                continue
        try:
            driver.switch_to.default_content()
        except WebDriverException:
            pass
        _log("No file input found — PDF upload skipped.")
        return False

    # ------------------------------------------------------------------
    # Continue / Submit
    # ------------------------------------------------------------------

    def _click_continue(self, driver) -> bool:
        """
        Click Continue / Submit:
          1. kat-button#meld-default-continue (shadow inner button).
          2. Broad JS scan (shadow roots + plain buttons).
          3. DOM text fallback (XPath).
        Repeats in default_content and each iframe if first pass fails.
        """
        def _try_in_current() -> bool:
            # meld-default-continue
            r = _safe_js(driver, "meld-default-continue", _JS_MELD_CONTINUE)
            if isinstance(r, dict) and r.get("ok"):
                _log("Continue: kat-button#meld-default-continue.")
                return True

            # Broad shadow + plain button scan
            ok = _safe_js(driver, "Continue broad scan", _JS_BROAD_CONTINUE)
            if ok is True:
                _log("Continue: broad shadow/button scan.")
                return True

            # DOM text XPath fallback
            for label in ("Continue", "Submit", "Send"):
                for xp in (
                    f"//button[normalize-space()='{label}']",
                    f"//a[normalize-space()='{label}']",
                    f"//*[@role='button' and normalize-space()='{label}']",
                ):
                    try:
                        for el in driver.find_elements(By.XPATH, xp):
                            try:
                                if el.is_displayed() and el.is_enabled():
                                    driver.execute_script(
                                        "arguments[0].scrollIntoView({block:'center'});", el
                                    )
                                    try:
                                        el.click()
                                    except WebDriverException:
                                        driver.execute_script("arguments[0].click();", el)
                                    _log(f"Continue: DOM text click ({label!r}).")
                                    return True
                            except (StaleElementReferenceException, WebDriverException):
                                continue
                    except WebDriverException:
                        continue
            return False

        if _try_in_current():
            return True
        try:
            driver.switch_to.default_content()
        except WebDriverException:
            pass
        if _try_in_current():
            return True
        try:
            frames = driver.find_elements(By.CSS_SELECTOR, "iframe, frame")
        except WebDriverException:
            frames = []
        for fr in frames:
            try:
                driver.switch_to.default_content()
                driver.switch_to.frame(fr)
                if _try_in_current():
                    return True
            except WebDriverException:
                continue
        try:
            driver.switch_to.default_content()
        except WebDriverException:
            pass
        _log("Continue/Submit/Send not found.")
        return False

    # ------------------------------------------------------------------
    # Post-submit: confirmation scraping and Supabase sync
    # ------------------------------------------------------------------

    def _wait_for_confirmation_page(self, driver) -> str:
        """
        After clicking Submit, switch to default content and wait (WebDriverWait)
        for known confirmation markers to appear.  Collects page text from the
        top document and every iframe so the caller can run the case-ID regex
        against the full content regardless of where Amazon renders the result.
        Returns the concatenated raw HTML/text of all scanned contexts.
        """
        _log(f"Step 8a: waiting for confirmation page (timeout {_CONFIRMATION_WAIT_SEC}s)…")
        try:
            driver.switch_to.default_content()
        except WebDriverException:
            pass

        def _confirmation_visible(d) -> bool:
            try:
                ps = (d.page_source or "").lower()
                return any(m in ps for m in _CONFIRMATION_MARKERS)
            except WebDriverException:
                return False

        try:
            WebDriverWait(driver, _CONFIRMATION_WAIT_SEC).until(_confirmation_visible)
            _log("Confirmation page detected.")
        except TimeoutException:
            _log("Confirmation markers not found within timeout — scraping anyway.")

        # Collect raw text from default content + all iframes
        collected: list[str] = []
        try:
            driver.switch_to.default_content()
            collected.append(driver.page_source or "")
        except WebDriverException:
            pass
        try:
            frames = driver.find_elements(By.CSS_SELECTOR, "iframe, frame")
        except WebDriverException:
            frames = []
        for fr in frames:
            try:
                driver.switch_to.default_content()
                driver.switch_to.frame(fr)
                collected.append(driver.page_source or "")
            except WebDriverException:
                continue
        try:
            driver.switch_to.default_content()
        except WebDriverException:
            pass
        return " ".join(collected)

    @staticmethod
    def _scrape_case_id(page_text: str) -> str | None:
        """
        Search page_text for an Amazon Case ID using _CASE_ID_RE.
        Returns the first match group (digits only) or None.
        """
        m = _CASE_ID_RE.search(page_text)
        if m:
            return m.group(1)
        return None

    # TODO: moved to claim_repository.py; safe to remove after validation
    def _sync_case_result(
        self,
        submission_id: str,
        amazon_case_id: str | None,
        status: str,
    ) -> None:
        """
        Write the final case status (and case ID when found) to claim_submissions
        using the submission_id as the primary key filter.
        """
        # DISABLED — replaced by self.repo.update_result(); body preserved below for reference.
        # update_payload: dict[str, Any] = {"status": status}
        # if amazon_case_id:
        #     update_payload["amazon_case_id"] = amazon_case_id
        # try:
        #     self.supabase.table("claim_submissions").update(update_payload).eq(
        #         "id", submission_id
        #     ).execute()
        #     _log(
        #         f"Supabase synced — submission_id={submission_id!r} "
        #         f"status={status!r} amazon_case_id={amazon_case_id!r}"
        #     )
        # except Exception as e:
        #     _log(f"Supabase sync failed for submission_id={submission_id!r}: {type(e).__name__}: {e}")

    # ------------------------------------------------------------------
    # Main navigation flow
    # ------------------------------------------------------------------

    def run_selenium_navigation(
        self,
        amazon_order_id: str,
        claim_type: str,
        evidence_pdf_path: str | None = None,
        *,
        submission_id: str | None = None,
        claim_data: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        """
        'My issue is not listed' flow — all steps wrapped in try/except
        to prevent FastAPI 500 errors.

        Returns a result dict on success::

            {"amazon_case_id": "12345678901", "status": "submitted", "message": "…"}
            {"amazon_case_id": None, "status": "submitted_check_manually", "message": "…"}

        Returns None on failure.
        If *submission_id* is supplied, Supabase is updated before returning.

        Parameters
        ----------
        claim_data:
            Optional full claim record dict (e.g. a ``claim_submissions`` row).
            When supplied, a PDF report is generated locally *before* Chrome
            opens and that generated PDF is used for the evidence upload.
            If generation fails, falls back to *evidence_pdf_path* if provided.
        """
        _log(
            f"run_selenium_navigation: order={amazon_order_id!r} type={claim_type!r} "
            f"pdf={'yes' if evidence_pdf_path else 'no'}"
        )

        # ── Pre-flight: generate claim report PDF before Selenium starts ──
        generated_pdf_path: str | None = None
        if claim_data:
            _log("Generating claim PDF report…")
            try:
                # Ensure the claim_data has the order/type fields even if the
                # caller built it externally without them.
                merged: dict[str, Any] = dict(claim_data)
                if amazon_order_id and merged.get("amazon_order_id") in (None, ""):
                    merged["amazon_order_id"] = amazon_order_id
                if claim_type and merged.get("claim_type") in (None, ""):
                    merged["claim_type"] = claim_type
                if submission_id and merged.get("id") in (None, ""):
                    merged["id"] = submission_id
                if self.org_id and merged.get("org_id") in (None, ""):
                    merged["org_id"] = self.org_id
                org_id = str(merged.get("organization_id") or self.org_id or "").strip()
                sid = str(merged.get("id") or submission_id or "").strip()
                pdf_result = generate_claim_evidence_pdf(
                    organization_id=org_id,
                    submission_id=sid or None,
                    claim_data=merged,
                    upload_to_storage=False,
                )
                if pdf_result.get("ok") and pdf_result.get("local_pdf_path"):
                    generated_pdf_path = str(pdf_result["local_pdf_path"])
                _log(f"Evidence PDF generated at: {generated_pdf_path}")
            except Exception as _pdf_exc:
                _log(f"Failed to generate PDF: {type(_pdf_exc).__name__}: {_pdf_exc}")
                generated_pdf_path = None

        # Decide which PDF path to use for upload
        if generated_pdf_path and os.path.isfile(generated_pdf_path):
            _log(f"Using generated PDF for upload: {generated_pdf_path}")
            evidence_pdf_path = generated_pdf_path
        elif evidence_pdf_path and os.path.isfile(evidence_pdf_path):
            _log(f"Falling back to existing evidence PDF path: {evidence_pdf_path}")
        else:
            if generated_pdf_path:
                _log("Generated PDF path does not exist on disk — no PDF upload.")
            elif evidence_pdf_path:
                _log("Provided evidence_pdf_path does not exist on disk — no PDF upload.")
            else:
                _log("No PDF available for upload — continuing without evidence file.")
            evidence_pdf_path = None

        try:
            driver, should_quit = self._attach_driver()
        except Exception as e:
            _log(f"Chrome attach failed: {type(e).__name__}: {e}")
            return None

        try:
            try:
                driver.maximize_window()
            except WebDriverException:
                pass

            # Step 1 — Navigate to browse-issue hub
            _log(f"Step 1: navigate to {BROWSE_ISSUE_HUB_URL}")
            try:
                driver.get(BROWSE_ISSUE_HUB_URL)
            except WebDriverException as e:
                _log(f"Navigation failed: {e}")
                return None
            time.sleep(_HUB_LOAD_WAIT)

            # Step 2 — Switch to hub iframe and let it render
            _log("Step 2: switch to hub iframe.")
            self._switch_to_hub_iframe(driver)
            time.sleep(1.5)

            # Step 3 — FORCE 'Not Listed' path.
            # No tile picking, no keyword matching, no XPath text scan.
            # Only strategy: shadow-root click on kat-button#issueNotListedButton.
            _log(
                "Step 3: FORCING 'Not Listed' path — "
                "JS shadow-root click on kat-button#issueNotListedButton."
            )
            if not self._click_not_listed(driver, timeout=_NOT_LISTED_TIMEOUT):
                _log(
                    "kat-button#issueNotListedButton not found after full timeout — "
                    "aborting. Verify hub iframe loaded and ID is still 'issueNotListedButton'."
                )
                return None
            time.sleep(_SETTLE_SEC)

            # Step 4 — Confirm 'Not Listed' form loaded by waiting for textarea.
            _log("Step 4: verifying 'Not Listed' form — waiting for 'What do you need help with?' textarea.")
            ta = self._wait_for_help_textarea(driver, timeout=_FORM_APPEAR_TIMEOUT)
            if ta is None:
                _log("Step 4 FAILED — textarea not found after timeout. Aborting.")
                return None
            _log("Step 4 OK: 'Not Listed' form is present.")

            # ── Step 5 — Fill ALL text fields FIRST, before any upload. ──────
            #
            # Targets (in order):
            #   • "What do you need help with?"   → claim message
            #   • "What steps have you taken?"    → steps taken sentence
            #   • "Reference numbers"             → amazon_order_id
            #
            # Strategy:
            #   1. _fill_form_fields_multi (semantic label scoring + positional
            #      fallback) fills as many fields as it can find.
            #   2. If the primary "help" field was missed, re-fetch a fresh
            #      element via _wait_for_help_textarea and call _fill_textarea
            #      directly (staleness-safe).
            #   3. Log each field's outcome individually so the operator can
            #      identify which selector needs adjusting.

            _log(
                "Step 5: filling ALL form fields "
                f"(order_id={amazon_order_id!r} claim_type={claim_type!r})."
            )
            message   = self._build_claim_message(amazon_order_id, claim_type)
            steps_msg = (
                "1. Confirmed the issue in Seller Central.\n"
                "2. Checked inventory / order details.\n"
                "3. Contacted support — no resolution yet."
            )
            fill_results = self._fill_form_fields_multi(
                driver,
                help_text=message,
                steps_text=steps_msg,
                reference_text=amazon_order_id,
            )

            # ── Per-field outcome logging ──────────────────────────────────────
            if fill_results.get("help"):
                _log("Step 5 [help] OK — 'What do you need help with?' filled.")
            else:
                _log(
                    "Step 5 [help] MISS — multi-fill did not reach the help field; "
                    "trying _fill_textarea fallback with a fresh element."
                )
                try:
                    ta_fresh = self._wait_for_help_textarea(driver, timeout=6.0)
                    target   = ta_fresh if ta_fresh is not None else ta
                    if self._fill_textarea(driver, target, message):
                        _log("Step 5 [help] OK — help textarea filled via direct fallback.")
                    else:
                        _log(
                            "Step 5 [help] FAILED — direct textarea fallback also failed. "
                            "Aborting submission."
                        )
                        return None
                except Exception as _fe:
                    _log(f"Step 5 [help] ERROR — fallback raised {type(_fe).__name__}: {_fe}. Aborting.")
                    return None

            if fill_results.get("steps"):
                _log("Step 5 [steps] OK — 'What steps have you taken?' filled.")
            else:
                _log(
                    "Step 5 [steps] MISS — field not found or label did not match "
                    "(_STEPS_KWS). Continuing without it (non-fatal)."
                )

            if fill_results.get("ref"):
                _log(
                    f"Step 5 [ref]   OK — 'Reference numbers' filled with {amazon_order_id!r}."
                )
            else:
                _log(
                    "Step 5 [ref]   MISS — reference field not found or label did not "
                    "match (_REF_KWS). Continuing without it (non-fatal)."
                )

            # Brief pause so all input / change events settle before upload.
            time.sleep(0.6)

            # ── Step 6 — Upload evidence PDF (AFTER all fields are filled). ───
            #
            # Re-enter the hub iframe so _upload_evidence_pdf_aggressive starts
            # its search in the correct context (field-fill may have drifted the
            # frame pointer).
            _log("Step 6: starting evidence PDF upload.")
            if evidence_pdf_path and os.path.isfile(evidence_pdf_path):
                abs_pdf = os.path.abspath(evidence_pdf_path)
                _log(f"Step 6: evidence file confirmed on disk → {abs_pdf!r}")
                _log("Step 6: re-entering hub iframe before file input search…")
                try:
                    driver.switch_to.default_content()
                except WebDriverException:
                    pass
                self._switch_to_hub_iframe(driver)
                time.sleep(0.4)

                _log("Step 6: calling _upload_evidence_pdf_aggressive…")
                upload_ok = self._upload_evidence_pdf_aggressive(driver, abs_pdf)
                if upload_ok:
                    _log(f"Step 6 OK — evidence PDF attached: {abs_pdf!r}")
                else:
                    _log(
                        "Step 6 MISS — no <input type='file'> found in any frame; "
                        "continuing without evidence attachment."
                    )
            elif evidence_pdf_path:
                _log(
                    f"Step 6 SKIP — evidence_pdf_path is set but file is not on disk: "
                    f"{evidence_pdf_path!r}"
                )
            else:
                _log("Step 6 SKIP — no evidence_pdf_path provided.")
            time.sleep(0.5)

            # Mock submit gate
            if self._mock_submit:
                _log("CLAIM_AGENT_MOCK_SUBMIT: form ready, submit skipped.")
                return {
                    "amazon_case_id": None,
                    "status": "mock_submit",
                    "message": "mock_submit: form filled, submit skipped",
                }

            # Step 7 — Click Continue / Submit
            _log("Step 7: click Continue / Submit.")
            if not self._click_continue(driver):
                _log("Continue/Submit not clicked — form may still be open.")
                return None

            # Step 8 — Wait for confirmation page and scrape case ID
            _log("Step 8: waiting for confirmation page and scraping Case ID.")
            page_text = self._wait_for_confirmation_page(driver)
            amazon_case_id = self._scrape_case_id(page_text)
            if amazon_case_id:
                _log(f"Scraped Amazon Case ID: {amazon_case_id}")
                final_status = "submitted"
            else:
                _log(
                    "Case ID not found on confirmation page — marking as "
                    "'submitted_check_manually'."
                )
                final_status = "submitted_check_manually"

            # Step 9 — Sync result to Supabase
            if submission_id:
                _log(
                    f"Step 9: syncing to Supabase "
                    f"(submission_id={submission_id!r} status={final_status!r} "
                    f"amazon_case_id={amazon_case_id!r})."
                )
                self.repo.update_result(submission_id, amazon_case_id, final_status)
            else:
                _log("Step 9: no submission_id supplied — Supabase sync skipped.")

            return {
                "amazon_case_id": amazon_case_id,
                "status": final_status,
                "message": f"Amazon case flow complete: {final_status}",
            }

        except Exception as e:
            _log(f"run_selenium_navigation error: {type(e).__name__}: {e}")
            return None
        finally:
            _log(
                "Done. If the row was not auto-synced, reset it manually: "
                "UPDATE claim_submissions SET status = 'ready_to_send' WHERE id = …"
            )
            if should_quit:
                try:
                    driver.quit()
                except WebDriverException:
                    pass

    # ------------------------------------------------------------------
    # Async entry point (called from FastAPI via asyncio.to_thread)
    # ------------------------------------------------------------------

    async def check_permissions(self) -> bool:
        _log("check_permissions: returning True.")
        return True

    async def start_process(
        self,
        order_id: str,
        claim_type: str,
        evidence_pdf_path: str | None = None,
        *,
        submission_id: str | None = None,
        claim_data: dict[str, Any] | None = None,
    ):
        _log("start_process: running 'My issue is not listed' navigation.")
        return self.run_selenium_navigation(
            order_id,
            claim_type,
            evidence_pdf_path,
            submission_id=submission_id,
            claim_data=claim_data,
        )
'''  # end ClaimProcessorAgent — disabled


# ---------------------------------------------------------------------------
# Module-level orchestration (no Supabase dependency — pure Selenium)
# ---------------------------------------------------------------------------

# TODO: migrate remaining browser helper to selenium_case_opener.py
def build_driver(debugger_address: str = "127.0.0.1:9222") -> Any:
    """
    Attach to an existing Chrome instance via remote debugging port.
    Returns a WebDriver ready to use.
    """
    from selenium.webdriver.chrome.options import Options as _ChromeOptions
    opts = _ChromeOptions()
    opts.add_experimental_option("debuggerAddress", debugger_address)
    driver = webdriver.Chrome(options=opts)
    driver.set_page_load_timeout(120)
    _log(f"build_driver: attached to Chrome at {debugger_address!r}")
    return driver


# TODO: migrate remaining browser helper to selenium_case_opener.py
def submit_not_listed_issue(
    driver: Any,
    help_text: str,
    steps_text: str,
    reference_text: str = "",
    file_paths: list[str] | None = None,
    *,
    hub_url: str = BROWSE_ISSUE_HUB_URL,
    navigate: bool = True,
    iframe_timeout: float = _NOT_LISTED_TIMEOUT,
    form_timeout: float = _FORM_APPEAR_TIMEOUT,
    continue_timeout: float = 20.0,
) -> dict[str, Any]:
    """
    Standalone orchestration for the 'My issue is not listed' flow.
    Does NOT require a ClaimProcessorAgent or Supabase.

    Steps:
      1. (Optionally) navigate to hub_url.
      2. Recursive iframe scan → switch into the Hub frame.
      3. Click 'My issue is not listed' (wrapper-aware, nested-iframe DFS).
      4. Wait for form fields.
      5. Fill help / steps / reference fields semantically.
      6. Upload file(s) via real <input type="file">.
      7. Click Continue.

    Returns dict with keys: ok, step_failed, amazon_case_id (if scraped).
    """
    file_paths = file_paths or []

    # Use a throw-away ClaimProcessorAgent shell (no Supabase init needed here)
    # We borrow its stateless helper methods via a lightweight proxy.
    class _AgentProxy:
        """Minimal proxy — only stateless helper methods, no Supabase."""
        def __init__(self):
            self._mock_submit = False
        # Borrow all helper methods from the real class
        _switch_to_hub_iframe = ClaimProcessorAgent._switch_to_hub_iframe
        _dfs_switch_to_frame_with_markers = ClaimProcessorAgent._dfs_switch_to_frame_with_markers
        _frame_has_markers = ClaimProcessorAgent._frame_has_markers
        _page_source_lower = ClaimProcessorAgent._page_source_lower
        _js_click_issue_not_listed = ClaimProcessorAgent._js_click_issue_not_listed
        _dfs_click_not_listed = ClaimProcessorAgent._dfs_click_not_listed
        _click_not_listed = ClaimProcessorAgent._click_not_listed
        _wait_for_help_textarea = ClaimProcessorAgent._wait_for_help_textarea
        _find_help_textarea = ClaimProcessorAgent._find_help_textarea
        _fill_textarea = ClaimProcessorAgent._fill_textarea
        _fill_form_fields_multi = ClaimProcessorAgent._fill_form_fields_multi
        _collect_form_fields = ClaimProcessorAgent._collect_form_fields
        _score_field = ClaimProcessorAgent._score_field
        _resolve_to_native_field = ClaimProcessorAgent._resolve_to_native_field
        _set_field_value = ClaimProcessorAgent._set_field_value
        _find_file_input_deep = staticmethod(ClaimProcessorAgent._find_file_input_deep.__func__
                                             if hasattr(ClaimProcessorAgent._find_file_input_deep, '__func__')
                                             else ClaimProcessorAgent._find_file_input_deep)
        _upload_evidence_pdf_aggressive = ClaimProcessorAgent._upload_evidence_pdf_aggressive
        _click_continue = ClaimProcessorAgent._click_continue
        _wait_for_confirmation_page = ClaimProcessorAgent._wait_for_confirmation_page
        _scrape_case_id = staticmethod(ClaimProcessorAgent._scrape_case_id.__func__
                                       if hasattr(ClaimProcessorAgent._scrape_case_id, '__func__')
                                       else ClaimProcessorAgent._scrape_case_id)
        HELP_KWS  = ClaimProcessorAgent._HELP_KWS
        STEPS_KWS = ClaimProcessorAgent._STEPS_KWS
        REF_KWS   = ClaimProcessorAgent._REF_KWS
        _HELP_KWS  = ClaimProcessorAgent._HELP_KWS
        _STEPS_KWS = ClaimProcessorAgent._STEPS_KWS
        _REF_KWS   = ClaimProcessorAgent._REF_KWS

    proxy = _AgentProxy()

    try:
        # Step 1 — navigate
        if navigate:
            _log(f"submit_not_listed_issue: navigating to {hub_url}")
            driver.get(hub_url)
            time.sleep(_HUB_LOAD_WAIT)

        # Step 2 — switch into hub iframe
        _log("submit_not_listed_issue: switching to hub iframe…")
        proxy._switch_to_hub_iframe(proxy, driver)
        time.sleep(1.2)

        # Step 3 — click 'My issue is not listed'
        _log("submit_not_listed_issue: clicking 'My issue is not listed'…")
        if not proxy._click_not_listed(proxy, driver, timeout=iframe_timeout):
            return {"ok": False, "step_failed": "click_not_listed"}
        time.sleep(_SETTLE_SEC)

        # Step 4 — wait for form (re-scan iframes if needed)
        _log("submit_not_listed_issue: waiting for form…")
        ta = proxy._wait_for_help_textarea(proxy, driver, timeout=form_timeout)
        if ta is None:
            return {"ok": False, "step_failed": "form_not_found"}

        # Step 5 — fill fields (multi-field semantic)
        _log("submit_not_listed_issue: filling form fields…")
        results = proxy._fill_form_fields_multi(
            proxy, driver, help_text, steps_text, reference_text
        )
        _log(f"  Fill results: {results}")

        # Step 6 — upload files
        if file_paths:
            for fp in file_paths:
                abs_fp = os.path.abspath(fp)
                _log(f"submit_not_listed_issue: uploading {abs_fp!r}…")
                proxy._upload_evidence_pdf_aggressive(proxy, driver, abs_fp)
            time.sleep(0.5)

        # Step 7 — click Continue
        _log("submit_not_listed_issue: clicking Continue…")
        if not proxy._click_continue(proxy, driver):
            return {"ok": False, "step_failed": "continue_not_clicked"}

        # Step 8 — wait and scrape case ID
        page_text = proxy._wait_for_confirmation_page(proxy, driver)
        case_id = proxy._scrape_case_id(page_text)
        _log(f"submit_not_listed_issue: complete. case_id={case_id!r}")
        return {"ok": True, "amazon_case_id": case_id, "step_failed": None}

    except Exception as exc:
        _log(f"submit_not_listed_issue error: {type(exc).__name__}: {exc}")
        return {"ok": False, "step_failed": f"exception:{type(exc).__name__}", "error": str(exc)}


# TODO: migrate remaining browser helper to selenium_case_opener.py
def safe_submit_not_listed_issue(
    driver: Any,
    help_text: str,
    steps_text: str,
    reference_text: str = "",
    file_paths: list[str] | None = None,
    *,
    retries: int = 3,
    **kwargs: Any,
) -> dict[str, Any]:
    """
    Retry wrapper around submit_not_listed_issue.
    Resets to default_content and pauses before each retry.
    Returns the last result dict.
    """
    file_paths = file_paths or []
    last: dict[str, Any] = {"ok": False, "step_failed": "no_attempts"}

    for attempt in range(1, retries + 1):
        _log(f"safe_submit_not_listed_issue: attempt {attempt}/{retries}")
        try:
            driver.switch_to.default_content()
        except WebDriverException:
            pass
        last = submit_not_listed_issue(
            driver, help_text, steps_text, reference_text, file_paths, **kwargs
        )
        if last.get("ok"):
            _log(f"safe_submit_not_listed_issue: succeeded on attempt {attempt}.")
            return last
        _log(f"  Attempt {attempt} failed: step_failed={last.get('step_failed')!r}")
        if attempt < retries:
            pause = _SETTLE_SEC * (attempt + 1)
            _log(f"  Waiting {pause:.1f}s before retry…")
            time.sleep(pause)

    _log("safe_submit_not_listed_issue: all attempts exhausted.")
    return last


if __name__ == "__main__":
    # ── ClaimProcessorAgent path (needs Supabase creds in .env) ──────────────
    # ORG_ID = "PASTE_YOUR_ORGANIZATION_ID_HERE"
    # agent = ClaimProcessorAgent(ORG_ID)
    # asyncio.run(agent.start_process("114-9988776-5544332", "DAMAGED", None))

    # ── Standalone path (no Supabase required) ────────────────────────────────
    _driver = build_driver("127.0.0.1:9222")

    _help_text = """\
Update the product title

Existing title: Leather Laptop Bag Black
New Title: Premium Leather Laptop Bag 15.6 inch, Black"""

    _steps_text = (
        "I tried to update it on 4/5 on Manage All Inventory page "
        'but received an error code "8541"'
    )

    _reference_text = "B01234567X, FBA1234567X, 123-1234567-1234567"

    _file_paths = [r"C:\path\to\file.pdf"]   # set to [] if no file

    result = safe_submit_not_listed_issue(
        _driver,
        _help_text,
        _steps_text,
        _reference_text,
        _file_paths,
        retries=3,
    )
    print("Result:", result)
