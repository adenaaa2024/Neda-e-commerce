"""
playwright_case_opener.py
=========================
Playwright-based automation for the Amazon Seller Central
"My issue is not listed" help case flow.

Mirrors the logic of selenium_case_opener.py without modifying it.
Uses the Playwright Python sync API.

Flow:
  1. Navigate to the Help Hub browse-issue URL.
  2. Find the hub iframe via DFS content-marker scan.
  3. Always click "My issue is not listed" (never select other hub issue tiles).
  4. Wait for the form fields to appear.
  5. Fill: What do you need help with? / Steps taken / Reference numbers.
  6. Upload evidence PDF via <input type="file">.
  7. Click Continue / Submit.
  8. Detect post-Continue state (confirmation, same-form errors, unknown / intermediate UI).
  9. Scrape Case ID on confirmation; return explicit outcomes for other states.

Shadow DOM reality:
  Amazon uses open shadow roots (kat-button, kat-input, kat-textarea, …).
  Elements exist in the DOM but inner controls are inside shadowRoot.
  All JS helpers walk every shadowRoot recursively (depth ≤ 16).

Playwright vs Selenium key differences:
  - No switch_to.frame() needed — use Frame objects directly.
  - frame.evaluate() runs JS in that frame's document context.
  - evaluate_handle() returns a JSHandle; .as_element() gives an
    ElementHandle supporting set_input_files(), click(), etc.
  - Locator.wait_for() / is_visible() replace WebDriverWait.
"""

from __future__ import annotations

import os
import random
import re
import tempfile
import time
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from playwright.sync_api import (
    Browser,
    BrowserContext,
    ElementHandle,
    Frame,
    Locator,
    Page,
    sync_playwright,
    TimeoutError as PWTimeoutError,
)

_env_file = Path(__file__).resolve().parent / ".env"
load_dotenv(dotenv_path=_env_file)

_LOG_PREFIX = "[pw-case-opener]"

BROWSE_ISSUE_HUB_URL = "https://sellercentral.amazon.com/help/hub/support/browse-issue"

# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------
_PAGE_LOAD_TIMEOUT_MS    = 30_000
_HUB_FRAME_TIMEOUT_SEC   = 25.0
_HUB_READY_TIMEOUT_MS    = 8_000   # wait for shadow DOM to hydrate
_NOT_LISTED_TIMEOUT_SEC  = 25.0
_NOT_LISTED_RETRY_INTERVAL_SEC = 1.0
_FORM_APPEAR_TIMEOUT_SEC = 25.0
_CONTINUE_TIMEOUT_SEC    = 20.0
_CONFIRMATION_TIMEOUT_SEC = 15.0
_POLL_INTERVAL_SEC       = 0.4

# Inline ASIN placeholder label (chip and/or textarea text on the lower form).
_AMAZON_HELP_ASIN_PLACEHOLDER = "[Enter ASIN]"

# Content markers for hub iframe detection
_HUB_CONTENT_MARKERS = (
    "issuenotlistedbutton",
    "my issue is not listed",
    "contact us",
    "browse-issue",
    "kat-button",
)

# Content markers for the "describe your issue" form
_FORM_CONTENT_MARKERS = (
    "what do you need help with",
    "what steps have you taken",
    "describe your issue",
    "tell us more",
)

# Confirmation page markers
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

# After Continue: same form still visible with Amazon validation / errors
_SAME_FORM_VALIDATION_MARKERS = (
    "select an issue or complete the required",
    "complete the required questions",
    "please correct the following",
    "please address the following",
    "this field is required",
    "is required to continue",
    "fix the errors",
    "error below",
)

# After first Continue: intermediate pages (Suggested description + ASIN chip, or legacy copy).
_INTERMEDIATE_STEP_MARKERS = (
    "suggested description",
    "troubleshoot issue",
    "let's troubleshoot",
    "try troubleshooting",
    "troubleshoot your issue",
)

# TRID page: Amazon asks for a Transaction Reference ID before confirming.
# Checked with higher priority than intermediate_ui so it is never misclassified.
_TRID_STEP_MARKERS = (
    "enter reference id (trid)",
    "transaction reference id",
    "enter up to 25 transaction ids",
    "enter trid",
)

# Amazon case IDs are typically 11 digits; accept 5–20 to be future-safe.
_CASE_ID_RE = re.compile(
    r"[Cc]ase\s*(?:ID|Id|id|#|Number|number)?\s*[:#]?\s*(\d{5,20})",
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# JavaScript helpers
# All written as arrow-function strings for frame.evaluate() /
# frame.evaluate_handle().  Each is self-contained with no external deps.
# ---------------------------------------------------------------------------

# Click "My issue is not listed" — wrapper-div-aware, shadow-DOM-piercing.
#
# Amazon DOM structure (confirmed from live inspection):
#   <div id="issueNotListedButton">   ← ID is on the wrapper div, NOT kat-button
#     <kat-button>
#       #shadow-root
#         <button>...</button>        ← real click target
#     </kat-button>
#   </div>
#
# Layer 1 — find #issueNotListedButton wrapper → descend to kat-button → inner <button>
# Layer 2 — deep text scan across all shadow roots as fallback
_JS_CLICK_ISSUE_NOT_LISTED = """
() => {
  function scrollCenter(el) {
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch(e) {}
  }
  function tryClick(el) {
    if (!el) return false;
    scrollCenter(el);
    try { el.click(); return true; } catch(e) {}
    try {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    } catch(e2) {}
    return false;
  }
  function innerBtn(host, depth) {
    if (!host || depth < 0) return null;
    var root = host.shadowRoot || host;
    var btn; try { btn = root.querySelector('button'); } catch(e) {}
    if (btn) return btn;
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return null; }
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) { var f = innerBtn(nodes[i], depth - 1); if (f) return f; }
    }
    return null;
  }
  function deepTextScan(root, wantText, depth, acc) {
    if (!root || depth < 0) return;
    var sels;
    try { sels = root.querySelectorAll('kat-button, button, [role="button"], div[id*="issue"]'); }
    catch(e) { sels = []; }
    for (var i = 0; i < sels.length; i++) {
      var txt = ((sels[i].innerText || sels[i].textContent || '')).trim().toLowerCase();
      if (txt.indexOf(wantText) !== -1) acc.push(sels[i]);
    }
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return; }
    for (var j = 0; j < nodes.length; j++) {
      if (nodes[j].shadowRoot) deepTextScan(nodes[j].shadowRoot, wantText, depth - 1, acc);
    }
  }

  try { window.scrollTo(0, document.body.scrollHeight); } catch(e) {}

  // Layer 1 — wrapper div with #issueNotListedButton
  var wrapper = null;
  try { wrapper = document.querySelector('#issueNotListedButton'); } catch(e) {}
  if (wrapper) {
    var wTag = (wrapper.tagName || '').toLowerCase();
    if (wTag === 'kat-button') {
      var b = innerBtn(wrapper, 12);
      if (b && tryClick(b)) return { ok: true, via: 'wrapper_kat_inner' };
      if (tryClick(wrapper)) return { ok: true, via: 'wrapper_kat_host' };
    }
    var katChild = null;
    try { katChild = wrapper.querySelector('kat-button'); } catch(e) {}
    if (katChild) {
      var ib = innerBtn(katChild, 12);
      if (ib && tryClick(ib)) return { ok: true, via: 'child_kat_inner' };
      if (tryClick(katChild)) return { ok: true, via: 'child_kat_host' };
    }
    if (tryClick(wrapper)) return { ok: true, via: 'wrapper_direct' };
  }

  // Layer 2 — deep text scan across all shadow roots
  var acc = [];
  deepTextScan(document, 'my issue is not listed', 16, acc);
  if (!acc.length) deepTextScan(document, "my issue isn't listed", 16, acc);
  for (var k = acc.length - 1; k >= 0; k--) {
    var cand = acc[k];
    var cTag = (cand.tagName || '').toLowerCase();
    if (cTag === 'kat-button') {
      var cb = innerBtn(cand, 12);
      if (cb && tryClick(cb)) return { ok: true, via: 'text_scan_kat_inner' };
    }
    if (tryClick(cand)) return { ok: true, via: 'text_scan_direct' };
  }

  return { ok: false, reason: 'not_found' };
}
"""

# Fill all three form fields in one shot (no DOM element round-trips).
# Discovers fields via deep shadow-DOM walk, scores each by keyword proximity,
# sets values via native prototype setter + full React/KAT event dispatch.
# Returns { help: bool, steps: bool, ref: bool }
_JS_FILL_FIELDS = """
([helpText, stepsText, refText]) => {
  var HELP_KWS  = ['what do you need help with', 'help with', 'describe your issue',
                   'issue description', 'message', 'details'];
  var STEPS_KWS = ['what steps have you taken', 'steps taken', 'steps already',
                   'steps you have taken'];
  var REF_KWS   = ['reference number', 'reference numbers', 'relevant reference',
                   'order number', 'case number', 'optional'];

  function scoreField(el, keywords) {
    var attrs = [
      el.getAttribute('placeholder') || '',
      el.getAttribute('aria-label')  || '',
      el.getAttribute('name')        || '',
      el.getAttribute('id')          || '',
      el.getAttribute('label')       || '',
    ].join(' ').toLowerCase();
    var score = 0;
    keywords.forEach(function(kw) { if (attrs.indexOf(kw) !== -1) score += 20; });
    // Walk up to 5 ancestors for label text.
    // NOTE: [class*="label"] is intentionally broad — scoring prevents false-positive wins.
    var n = el;
    for (var i = 0; i < 5; i++) {
      if (!n) break;
      n = n.parentElement;
      if (!n) break;
      var lbls = n.querySelectorAll('label, kat-label, [class*="label"]');
      for (var j = 0; j < lbls.length; j++) {
        var t = (lbls[j].innerText || lbls[j].textContent || '').trim().toLowerCase();
        keywords.forEach(function(kw) { if (t.indexOf(kw) !== -1) score += 30; });
      }
    }
    return score;
  }

  function resolveNative(el) {
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'kat-textarea' || tag === 'kat-input') {
      var root = el.shadowRoot;
      if (root) {
        var ta  = root.querySelector('textarea');
        if (ta) return ta;
        var inp = root.querySelector('input:not([type="hidden"])');
        if (inp) return inp;
      }
    }
    return el;
  }

  function setValue(el, val) {
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
    return el.value;
  }

  // Collect all field candidates via deep shadow walk
  var fields = [];
  var SELS = ['kat-textarea', 'kat-input', 'textarea', 'input:not([type="hidden"])'];
  function walkDoc(root, depth) {
    if (!root || depth < 0) return;
    SELS.forEach(function(sel) {
      try { root.querySelectorAll(sel).forEach(function(el) { fields.push(el); }); } catch(e) {}
    });
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return; }
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) walkDoc(nodes[i].shadowRoot, depth - 1);
    }
  }
  walkDoc(document, 12);

  // Resolve to native elements, de-duplicate
  var native = [];
  fields.forEach(function(el) {
    var n = resolveNative(el);
    if (n && native.indexOf(n) === -1) native.push(n);
  });

  function bestFor(kws) {
    var best = null, bestScore = 0;
    native.forEach(function(el) {
      var sc = scoreField(el, kws);
      if (sc > bestScore) { bestScore = sc; best = el; }
    });
    return best;
  }

  var helpF  = bestFor(HELP_KWS)  || native[0] || null;
  var stepsF = bestFor(STEPS_KWS) || native[1] || null;
  var refF   = bestFor(REF_KWS)   || native[2] || null;

  var results = { help: false, steps: false, ref: false };
  if (helpText  && helpF)  results.help  = setValue(helpF,  helpText).trim()  === helpText.trim();
  if (stepsText && stepsF) results.steps = setValue(stepsF, stepsText).trim() === stepsText.trim();
  if (refText   && refF)   results.ref   = setValue(refF,   refText).trim()   === refText.trim();

  return results;
}
"""

# Resolve best native <textarea>/<input> for "help" or "steps" (same scoring as _JS_FILL_FIELDS).
_JS_FIND_BEST_NATIVE = """
(kind) => {
  var HELP_KWS  = ['what do you need help with', 'help with', 'describe your issue',
                   'issue description', 'message', 'details'];
  var STEPS_KWS = ['what steps have you taken', 'steps taken', 'steps already',
                   'steps you have taken'];

  function scoreField(el, keywords) {
    var attrs = [
      el.getAttribute('placeholder') || '',
      el.getAttribute('aria-label')  || '',
      el.getAttribute('name')        || '',
      el.getAttribute('id')          || '',
      el.getAttribute('label')       || '',
    ].join(' ').toLowerCase();
    var score = 0;
    keywords.forEach(function(kw) { if (attrs.indexOf(kw) !== -1) score += 20; });
    var n = el;
    for (var i = 0; i < 5; i++) {
      if (!n) break;
      n = n.parentElement;
      if (!n) break;
      var lbls = n.querySelectorAll('label, kat-label, [class*="label"]');
      for (var j = 0; j < lbls.length; j++) {
        var t = (lbls[j].innerText || lbls[j].textContent || '').trim().toLowerCase();
        keywords.forEach(function(kw) { if (t.indexOf(kw) !== -1) score += 30; });
      }
    }
    return score;
  }

  function resolveNative(el) {
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'kat-textarea' || tag === 'kat-input') {
      var root = el.shadowRoot;
      if (root) {
        var ta  = root.querySelector('textarea');
        if (ta) return ta;
        var inp = root.querySelector('input:not([type="hidden"])');
        if (inp) return inp;
      }
    }
    return el;
  }

  var fields = [];
  var SELS = ['kat-textarea', 'kat-input', 'textarea', 'input:not([type="hidden"])'];
  function walkDoc(root, depth) {
    if (!root || depth < 0) return;
    SELS.forEach(function(sel) {
      try { root.querySelectorAll(sel).forEach(function(el) { fields.push(el); }); } catch(e) {}
    });
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return; }
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) walkDoc(nodes[i].shadowRoot, depth - 1);
    }
  }
  walkDoc(document, 12);

  var native = [];
  fields.forEach(function(el) {
    var n = resolveNative(el);
    if (n && native.indexOf(n) === -1) native.push(n);
  });

  function bestFor(kws) {
    var best = null, bestScore = 0;
    native.forEach(function(el) {
      var sc = scoreField(el, kws);
      if (sc > bestScore) { bestScore = sc; best = el; }
    });
    return best;
  }

  if (kind === 'help')
    return bestFor(HELP_KWS) || native[0] || null;
  if (kind === 'steps')
    return bestFor(STEPS_KWS) || (native.length > 1 ? native[1] : null) || null;
  return null;
}
"""

# Inspect validation-related signals on a native textarea/input (runs as locator.evaluate / element.evaluate).
_JS_INSPECT_NATIVE_CONTROL = """
(el) => {
  if (!el) {
    return {
      valueLen: 0, ariaInvalid: true, invalidClass: true, redHint: false,
      looksInvalid: true, summary: 'null element'
    };
  }
  var len = (el.value || '').trim().length;
  var aria = el.getAttribute('aria-invalid') === 'true';
  var cls = (el.getAttribute('class') || '').toLowerCase();
  var invalidClass = /\\binvalid\\b|\\berror\\b|has-error|is-invalid|field-error/.test(cls);
  var st = window.getComputedStyle(el);
  var bc = (st.borderColor || '').toLowerCase();
  var oc = (st.outlineColor || '').toLowerCase();
  var redHint = bc.indexOf('rgb(255') !== -1 || bc.indexOf('rgb(221') !== -1 ||
    bc.indexOf('rgb(220') !== -1 || oc.indexOf('255, 0, 0') !== -1;
  var n = el;
  for (var i = 0; i < 10 && n; i++) {
    var tc = (n.tagName || '').toLowerCase();
    if (n.getAttribute && n.getAttribute('aria-invalid') === 'true') aria = true;
    var cn = ((n.getAttribute && n.getAttribute('class')) || '').toLowerCase();
    if (/\\binvalid\\b|\\berror\\b|has-error|is-invalid|field-error/.test(cn)) invalidClass = true;
    if (tc === 'kat-textarea') {
      var inv = n.getAttribute && n.getAttribute('invalid');
      if (inv === 'true' || inv === '') invalidClass = true;
    }
    n = n.parentElement;
  }
  var looksInvalid = aria || invalidClass || redHint;
  var summary = 'len=' + len + ' aria-invalid=' + aria + ' invalidClass=' + invalidClass +
    ' redHint=' + redHint + ' looksInvalid=' + looksInvalid;
  return {
    valueLen: len, ariaInvalid: aria, invalidClass: invalidClass, redHint: redHint,
    looksInvalid: looksInvalid, summary: summary
  };
}
"""

# JS fallback: native value setter + focus/input/change/blur (after Playwright type path).
_JS_REQUIRED_FIELD_VALUE_EVENTS = """
([el, val]) => {
  if (!el) return false;
  try { el.focus(); } catch(e) {}
  try { el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); } catch(e) {}
  var tag = (el.tagName || '').toLowerCase();
  var proto = (tag === 'textarea')
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  var desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) { desc.set.call(el, val); } else { el.value = val; }
  try { el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: val })); } catch(e) {
    try { el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true })); } catch(e2) {}
  }
  try { el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true })); } catch(e) {}
  try { el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); } catch(e) {}
  try { el.blur(); } catch(e) {}
  return (el.value || '').trim().length > 0;
}
"""

# Find the first <input type="file"> anywhere in deep shadow DOM.
# Returns the element for evaluate_handle() → as_element() → set_input_files().
_JS_FIND_FILE_INPUT = """
() => {
  function walk(root, depth) {
    if (!root || depth < 0) return null;
    try {
      var inp = root.querySelector('input[type="file"]');
      if (inp) return inp;
    } catch(e) {}
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return null; }
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) {
        var f = walk(nodes[i].shadowRoot, depth - 1);
        if (f) return f;
      }
    }
    return null;
  }
  return walk(document, 16);
}
"""

# Make a hidden file input interactable.
# Playwright's set_input_files() works on display:none inputs in most cases,
# but some Amazon builds add explicit guards — this removes them.
_JS_UNHIDE_INPUT = """
(el) => {
  if (!el) return false;
  try {
    el.removeAttribute('hidden');
    el.style.display  = 'block';
    el.style.opacity  = '1';
    el.style.position = 'fixed';
    el.style.top      = '0';
    el.style.left     = '0';
    el.style.width    = '1px';
    el.style.height   = '1px';
    el.style.zIndex   = '99999';
    return true;
  } catch(e) { return false; }
}
"""

# Find and click Continue/Submit across the full deep shadow DOM.
# Prefers kat-button#meld-default-continue inner shadow button,
# then any kat-button/button/role=button with matching text,
# then XPath fallback for visible plain buttons.
_JS_CLICK_CONTINUE = """
() => {
  function textOf(el) {
    return ((el.innerText || el.textContent || '')).replace(/\\s+/g, ' ').trim().toLowerCase();
  }
  function innerBtn(host, depth) {
    if (!host || depth < 0) return null;
    var root = host.shadowRoot || host;
    var btn; try { btn = root.querySelector('button'); } catch(e) {}
    if (btn) return btn;
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return null; }
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) { var f = innerBtn(nodes[i], depth-1); if (f) return f; }
    }
    return null;
  }

  // Prefer the meld-default-continue button if present (most reliable selector)
  var meld = null;
  try { meld = document.querySelector('kat-button#meld-default-continue'); } catch(e) {}
  if (meld) {
    var mi = innerBtn(meld, 12);
    if (mi) { try { mi.click(); return true; } catch(e) {} }
    try { meld.click(); return true; } catch(e) {}
  }

  var LABELS = ['continue', 'submit', 'send'];
  function walk(root, depth) {
    if (!root || depth < 0) return false;
    try {
      var els = root.querySelectorAll('kat-button, button, [role="button"]');
      for (var i = 0; i < els.length; i++) {
        var t = textOf(els[i]);
        if (LABELS.indexOf(t) !== -1 || t.indexOf('continue') !== -1) {
          var tag = (els[i].tagName || '').toLowerCase();
          if (tag === 'kat-button') {
            var inner = innerBtn(els[i], 12);
            if (inner) { try { inner.click(); return true; } catch(e) {} }
          }
          try { els[i].click(); return true; } catch(e) {}
        }
      }
    } catch(e) {}
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return false; }
    for (var j = 0; j < nodes.length; j++) {
      if (nodes[j].shadowRoot && walk(nodes[j].shadowRoot, depth - 1)) return true;
    }
    return false;
  }
  if (walk(document, 16)) return true;

  // XPath fallback for plain visible buttons
  var xp = document.evaluate(
    "//button[normalize-space()='Continue' or normalize-space()='Submit' or normalize-space()='Send']",
    document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
  );
  for (var k = 0; k < xp.snapshotLength; k++) {
    try { xp.snapshotItem(k).click(); return true; } catch(e) {}
  }
  return false;
}
"""

# Post–first-Continue: "Enter ASIN" chip lives in open shadow (kat-chip / kat-pill / kat-button).
_JS_FIND_POST_CONTINUE_ASIN_CHIP_CLICKABLE = """
() => {
  function textNorm(s) {
    return ((s || '')).replace(/\\s+/g, ' ').trim().toLowerCase();
  }
  function textOf(el) {
    return textNorm((el.innerText || el.textContent || ''));
  }
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var st = window.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none') return false;
    return true;
  }
  function innerBtn(host, depth) {
    if (!host || depth < 0) return null;
    var root = host.shadowRoot || host;
    var btn; try { btn = root.querySelector('button'); } catch(e) {}
    if (btn) return btn;
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return null; }
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) {
        var f = innerBtn(nodes[i], depth - 1);
        if (f) return f;
      }
    }
    return null;
  }
  function hasAsinLabel(t) {
    return t.indexOf('enter asin') !== -1 || t.indexOf('[enter asin]') !== -1;
  }
  function clickTargetFor(el) {
    var p = el;
    for (var u = 0; u < 14 && p; u++) {
      var tg = (p.tagName || '').toLowerCase();
      if (tg === 'kat-chip' || tg === 'kat-pill' || tg === 'kat-button') {
        var ib = innerBtn(p, 12);
        if (ib && visible(ib)) return ib;
        if (visible(p)) return p;
      }
      if (tg === 'button' || p.getAttribute('role') === 'button') {
        return p;
      }
      p = p.parentElement;
    }
    return visible(el) ? el : null;
  }
  function walk(root, depth) {
    if (!root || depth < 0) return null;
    var nodes;
    try { nodes = root.querySelectorAll('*'); } catch(e) { return null; }
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.shadowRoot) {
        var hit = walk(el.shadowRoot, depth - 1);
        if (hit) return hit;
      }
      if (!visible(el)) continue;
      if (!hasAsinLabel(textOf(el))) continue;
      var ct = clickTargetFor(el);
      if (ct) return ct;
    }
    return null;
  }
  return walk(document, 18);
}
"""

# Popup / sheet: ASIN text field is often inside kat-input shadow.
_JS_FIND_POST_CONTINUE_ASIN_POPUP_INPUT = """
() => {
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var st = window.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none') return false;
    return true;
  }
  function walkInputs(root, depth, acc) {
    if (!root || depth < 0) return;
    try {
      root.querySelectorAll('input').forEach(function(inp) {
        var ty = (inp.type || '').toLowerCase();
        if (ty === 'hidden' || ty === 'file' || ty === 'submit' || ty === 'button' ||
            ty === 'checkbox' || ty === 'radio') return;
        if (visible(inp)) acc.push(inp);
      });
      root.querySelectorAll('kat-input').forEach(function(host) {
        if (!host.shadowRoot) return;
        var inp = host.shadowRoot.querySelector('input');
        if (inp && visible(inp)) acc.push(inp);
      });
    } catch(e) {}
    try {
      var nodes = root.querySelectorAll('*');
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].shadowRoot) walkInputs(nodes[i].shadowRoot, depth - 1, acc);
      }
    } catch(e2) {}
  }
  var acc = [];
  walkInputs(document, 18, acc);
  var j;
  for (j = 0; j < acc.length; j++) {
    var meta = ((acc[j].placeholder || '') + ' ' + (acc[j].name || '') + ' ' +
      (acc[j].id || '') + ' ' + (acc[j].getAttribute('aria-label') || '')).toLowerCase();
    if (meta.indexOf('asin') !== -1) return acc[j];
  }
  return acc.length ? acc[acc.length - 1] : null;
}
"""

# Prefer Save inside dialog / modal; then full document (shadow-piercing).
_JS_CLICK_SAVE_POST_CONTINUE = """
() => {
  function textOf(el) {
    return ((el.innerText || el.textContent || '')).replace(/\\s+/g, ' ').trim().toLowerCase();
  }
  function innerBtn(host, depth) {
    if (!host || depth < 0) return null;
    var root = host.shadowRoot || host;
    var btn; try { btn = root.querySelector('button'); } catch(e) {}
    if (btn) return btn;
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return null; }
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) {
        var f = innerBtn(nodes[i], depth - 1);
        if (f) return f;
      }
    }
    return null;
  }
  function isSaveLabel(t) {
    return t === 'save' || t === 'save changes';
  }
  function clickSaveIn(root, depth) {
    if (!root || depth < 0) return false;
    try {
      var els = root.querySelectorAll('kat-button, button, [role="button"]');
      for (var i = 0; i < els.length; i++) {
        var t = textOf(els[i]);
        if (!isSaveLabel(t)) continue;
        var tag = (els[i].tagName || '').toLowerCase();
        if (tag === 'kat-button') {
          var inner = innerBtn(els[i], 12);
          if (inner) { try { inner.click(); return true; } catch(e) {} }
        }
        try { els[i].click(); return true; } catch(e2) {}
      }
    } catch(e3) {}
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e4) { return false; }
    for (var j = 0; j < nodes.length; j++) {
      if (nodes[j].shadowRoot && clickSaveIn(nodes[j].shadowRoot, depth - 1)) return true;
    }
    return false;
  }
  function collectDialogRoots(root, depth, acc) {
    if (!root || depth < 0) return;
    try {
      root.querySelectorAll('[role="dialog"], kat-modal').forEach(function(d) {
        if (acc.indexOf(d) === -1) acc.push(d);
      });
    } catch(e) {}
    try {
      var nodes = root.querySelectorAll('*');
      for (var k = 0; k < nodes.length; k++) {
        if (nodes[k].shadowRoot) collectDialogRoots(nodes[k].shadowRoot, depth - 1, acc);
      }
    } catch(e2) {}
  }
  var roots = [];
  collectDialogRoots(document, 16, roots);
  var r;
  for (r = 0; r < roots.length; r++) {
    if (clickSaveIn(roots[r], 12)) return true;
  }
  return clickSaveIn(document, 16);
}
"""

# JS-based click for the ASIN chip — more reliable than ElementHandle.click() on shadow DOM.
_JS_CLICK_POST_CONTINUE_ASIN_CHIP = """
() => {
  function textNorm(s) { return ((s || '')).replace(/\\s+/g, ' ').trim().toLowerCase(); }
  function textOf(el) { return textNorm((el.innerText || el.textContent || '')); }
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var st = window.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none') return false;
    return true;
  }
  function innerBtn(host, depth) {
    if (!host || depth < 0) return null;
    var root = host.shadowRoot || host;
    var btn; try { btn = root.querySelector('button'); } catch(e) {}
    if (btn) return btn;
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return null; }
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) { var f = innerBtn(nodes[i], depth - 1); if (f) return f; }
    }
    return null;
  }
  function hasAsinLabel(t) {
    return t.indexOf('enter asin') !== -1 || t.indexOf('[enter asin]') !== -1;
  }
  function clickTargetFor(el) {
    var p = el;
    for (var u = 0; u < 14 && p; u++) {
      var tg = (p.tagName || '').toLowerCase();
      if (tg === 'kat-chip' || tg === 'kat-pill' || tg === 'kat-button') {
        var ib = innerBtn(p, 12);
        if (ib && visible(ib)) return ib;
        if (visible(p)) return p;
      }
      if (tg === 'button' || p.getAttribute('role') === 'button') return p;
      p = p.parentElement;
    }
    return visible(el) ? el : null;
  }
  function walk(root, depth) {
    if (!root || depth < 0) return null;
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return null; }
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.shadowRoot) { var hit = walk(el.shadowRoot, depth - 1); if (hit) return hit; }
      if (!visible(el)) continue;
      if (!hasAsinLabel(textOf(el))) continue;
      var ct = clickTargetFor(el);
      if (ct) return ct;
    }
    return null;
  }
  var target = walk(document, 18);
  if (!target) return false;
  try { target.click(); return true; } catch(e) { return false; }
}
"""

# Broad ASIN element finder — scores all visible elements by how likely they are to
# be the "Enter ASIN" chip; returns the best click-target found, or null.
_JS_FIND_ASIN_ELEMENT_BROAD = """
() => {
  function textNorm(s) { return ((s||'')).replace(/\\s+/g,' ').trim().toLowerCase(); }
  function textOf(el) { return textNorm(el.innerText||el.textContent||''); }
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  }
  function innerBtn(host, depth) {
    if (!host || depth < 0) return null;
    var root = host.shadowRoot || host;
    var btn; try { btn = root.querySelector('button'); } catch(e) {}
    if (btn) return btn;
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return null; }
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) { var f = innerBtn(nodes[i], depth-1); if (f) return f; }
    }
    return null;
  }
  var best = null, bestScore = -1;
  function walk(root, depth) {
    if (!root || depth < 0) return;
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return; }
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.shadowRoot) walk(el.shadowRoot, depth-1);
      if (!visible(el)) continue;
      var t = textOf(el);
      if (t.indexOf('asin') === -1) continue;
      var score = 0;
      if (t === 'enter asin' || t === '[enter asin]') score += 20;
      else if (t.indexOf('enter asin') !== -1 || t.indexOf('[enter asin]') !== -1) score += 12;
      var tg = (el.tagName||'').toLowerCase();
      if (tg === 'kat-chip' || tg === 'kat-pill') score += 10;
      else if (tg === 'kat-button') score += 8;
      else if (tg === 'button') score += 6;
      else if (el.getAttribute('role') === 'button') score += 5;
      else if (tg === 'span' || tg === 'div') score += 1;
      if (score > bestScore) { best = el; bestScore = score; }
    }
  }
  walk(document, 18);
  if (!best) return null;
  var tg = (best.tagName||'').toLowerCase();
  if (tg === 'kat-button' || tg === 'kat-chip' || tg === 'kat-pill') {
    var inner = innerBtn(best, 12);
    if (inner) return inner;
  }
  return best;
}
"""

# ---------------------------------------------------------------------------
# Container-scoped ASIN helpers
# All five functions work ONLY within the "Suggested description" section so
# they can never accidentally target the top-of-page search bar.
# ---------------------------------------------------------------------------

# 1. Find the "Suggested description" container element (shadow-aware).
_JS_FIND_SUGGESTED_DESC_CONTAINER = """
() => {
  function textNorm(s) { return (s||'').replace(/\\s+/g,' ').trim().toLowerCase(); }
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return false;
    var st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  }
  function isContainer(el) {
    var tg = (el.tagName||'').toLowerCase();
    if (tg === 'kat-expander' || tg === 'kat-card' || tg === 'section' || tg === 'article') return true;
    if (tg === 'div') {
      var r = el.getBoundingClientRect();
      return r.width > 200 && r.height > 50;
    }
    return false;
  }
  function findSD(root, depth) {
    if (!root || depth < 0) return null;
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return null; }
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.shadowRoot) { var r = findSD(el.shadowRoot, depth-1); if (r) return r; }
      if (!visible(el)) continue;
      var tg = (el.tagName||'').toLowerCase();
      if (tg !== 'span' && tg !== 'p' && tg !== 'div' && tg !== 'h1' && tg !== 'h2' &&
          tg !== 'h3' && tg !== 'h4' && tg !== 'label' && tg !== 'strong') continue;
      var t = textNorm(el.innerText||el.textContent||'');
      if (t.indexOf('suggested description') === -1) continue;
      // Walk up to find the enclosing container section
      var p = el;
      for (var u = 0; u < 14 && p; u++) {
        if (isContainer(p)) return p;
        p = p.parentElement;
      }
      p = el.parentElement;
      if (p && p.parentElement) p = p.parentElement;
      if (p && p.parentElement) p = p.parentElement;
      return p || el;
    }
    return null;
  }
  return findSD(document, 18);
}
"""

# 2. Find the "Enter ASIN" clickable chip INSIDE a given container.
_JS_SCOPED_FIND_ASIN_CHIP = """
(container) => {
  if (!container) return null;
  function textNorm(s) { return (s||'').replace(/\\s+/g,' ').trim().toLowerCase(); }
  function textOf(el) { return textNorm(el.innerText||el.textContent||''); }
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  }
  function hasAsinLabel(t) {
    return t === 'enter asin' || t === '[enter asin]' ||
           t.indexOf('enter asin') !== -1 || t.indexOf('[enter asin]') !== -1;
  }
  function innerBtn(host, depth) {
    if (!host || depth < 0) return null;
    var root = host.shadowRoot || host;
    var btn; try { btn = root.querySelector('button'); } catch(e) {}
    if (btn && visible(btn)) return btn;
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return null; }
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) { var f = innerBtn(nodes[i], depth-1); if (f) return f; }
    }
    return null;
  }
  function findChip(root, depth) {
    if (!root || depth < 0) return null;
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return null; }
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.shadowRoot) { var c = findChip(el.shadowRoot, depth-1); if (c) return c; }
      if (!visible(el)) continue;
      if (!hasAsinLabel(textOf(el))) continue;
      var tg = (el.tagName||'').toLowerCase();
      if (tg === 'kat-chip' || tg === 'kat-pill' || tg === 'kat-button') {
        var ib = innerBtn(el, 8); return ib || el;
      }
      if (tg === 'button' || el.getAttribute('role') === 'button') return el;
      var p = el;
      for (var u = 0; u < 6 && p; u++) {
        var ptg = (p.tagName||'').toLowerCase();
        if (ptg === 'kat-chip' || ptg === 'kat-pill' || ptg === 'kat-button') {
          var ib2 = innerBtn(p, 8); return ib2 || p;
        }
        if (ptg === 'button' || p.getAttribute('role') === 'button') return p;
        p = p.parentElement;
      }
      if (visible(el)) return el;
    }
    return null;
  }
  var chip = findChip(container, 14);
  if (!chip && container.shadowRoot) chip = findChip(container.shadowRoot, 14);
  return chip;
}
"""

# 3. Click the ASIN chip INSIDE a given container via JS (shadow-aware).
_JS_SCOPED_CLICK_ASIN_CHIP = """
(container) => {
  if (!container) return false;
  function textNorm(s) { return (s||'').replace(/\\s+/g,' ').trim().toLowerCase(); }
  function textOf(el) { return textNorm(el.innerText||el.textContent||''); }
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  }
  function hasAsinLabel(t) {
    return t === 'enter asin' || t === '[enter asin]' ||
           t.indexOf('enter asin') !== -1 || t.indexOf('[enter asin]') !== -1;
  }
  function innerBtn(host, depth) {
    if (!host || depth < 0) return null;
    var root = host.shadowRoot || host;
    var btn; try { btn = root.querySelector('button'); } catch(e) {}
    if (btn && visible(btn)) return btn;
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return null; }
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) { var f = innerBtn(nodes[i], depth-1); if (f) return f; }
    }
    return null;
  }
  function clickChipIn(root, depth) {
    if (!root || depth < 0) return false;
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return false; }
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.shadowRoot) { if (clickChipIn(el.shadowRoot, depth-1)) return true; }
      if (!visible(el)) continue;
      if (!hasAsinLabel(textOf(el))) continue;
      var tg = (el.tagName||'').toLowerCase();
      var target = null;
      if (tg === 'kat-chip' || tg === 'kat-pill' || tg === 'kat-button') {
        target = innerBtn(el, 8) || el;
      } else if (tg === 'button' || el.getAttribute('role') === 'button') {
        target = el;
      } else {
        var p = el;
        for (var u = 0; u < 6 && p; u++) {
          var ptg = (p.tagName||'').toLowerCase();
          if (ptg === 'kat-chip' || ptg === 'kat-pill' || ptg === 'kat-button') {
            target = innerBtn(p, 8) || p; break;
          }
          if (ptg === 'button' || p.getAttribute('role') === 'button') { target = p; break; }
          p = p.parentElement;
        }
        if (!target && visible(el)) target = el;
      }
      if (target) { try { target.click(); return true; } catch(e) {} }
    }
    return false;
  }
  if (clickChipIn(container, 14)) return true;
  if (container.shadowRoot && clickChipIn(container.shadowRoot, 14)) return true;
  return false;
}
"""

# 4. Find the local inline ASIN editor/input inside or NEAR the container.
#    Explicitly excludes global search bars and nav inputs.
_JS_SCOPED_FIND_ASIN_INPUT = """
(container) => {
  if (!container) return null;
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  }
  function isSearchBar(inp) {
    var id   = (inp.id||'').toLowerCase();
    var name = (inp.name||'').toLowerCase();
    var ph   = (inp.placeholder||'').toLowerCase();
    var role = (inp.getAttribute('role')||'').toLowerCase();
    var cls  = (inp.className||'').toLowerCase();
    var aria = (inp.getAttribute('aria-label')||'').toLowerCase();
    if (id.indexOf('search') !== -1   && id.indexOf('asin') === -1)   return true;
    if (name.indexOf('search') !== -1 && name.indexOf('asin') === -1) return true;
    if (ph.indexOf('search') !== -1   && ph.indexOf('asin') === -1)   return true;
    if (role === 'searchbox' || role === 'search')                     return true;
    if (cls.indexOf('search') !== -1  && cls.indexOf('asin') === -1)  return true;
    if (aria.indexOf('search') !== -1 && aria.indexOf('asin') === -1) return true;
    if (inp.name === 'field-keywords') return true;
    return false;
  }
  function collectInputs(root, depth, acc) {
    if (!root || depth < 0) return;
    try {
      root.querySelectorAll('input, textarea').forEach(function(inp) {
        var ty = (inp.type||'').toLowerCase();
        if (ty === 'hidden' || ty === 'file' || ty === 'submit' ||
            ty === 'button'  || ty === 'checkbox' || ty === 'radio') return;
        if (!visible(inp) || isSearchBar(inp)) return;
        acc.push(inp);
      });
      root.querySelectorAll('kat-input').forEach(function(host) {
        if (!host.shadowRoot) return;
        var inp = host.shadowRoot.querySelector('input');
        if (inp && visible(inp) && !isSearchBar(inp)) acc.push(inp);
      });
    } catch(e) {}
    try {
      var nodes = root.querySelectorAll('*');
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].shadowRoot) collectInputs(nodes[i].shadowRoot, depth-1, acc);
      }
    } catch(e2) {}
  }
  function preferAsin(acc) {
    for (var j = 0; j < acc.length; j++) {
      var meta = ((acc[j].placeholder||'')+' '+(acc[j].name||'')+' '+
                  (acc[j].id||'')+' '+(acc[j].getAttribute('aria-label')||'')).toLowerCase();
      if (meta.indexOf('asin') !== -1) return acc[j];
    }
    return acc.length ? acc[0] : null;
  }
  // 1. Search inside the container
  var acc = []; collectInputs(container, 12, acc);
  var found = preferAsin(acc);
  if (found) return found;
  // 2. Walk up ancestors (editor may be rendered as sibling of container)
  var ancestor = container.parentElement;
  for (var k = 0; k < 5 && ancestor; k++) {
    acc = []; collectInputs(ancestor, 6, acc);
    found = preferAsin(acc);
    if (found) return found;
    ancestor = ancestor.parentElement;
  }
  return null;
}
"""

# 4b. Strict container-only inline input finder — NO ancestor walk, NO global page search.
#     Pass 1: input[type="text"] or input with no type (most likely the inline editor).
#     Pass 2: any non-button visible input inside the container.
#     Both passes recurse through shadow roots inside the container only.
_JS_CONTAINER_FIND_INLINE_INPUT = """
(container) => {
  if (!container) return null;
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  }
  // Pass 1: text inputs / kat-input shadow, shadow-recursive, container-scoped only
  function findText(root, depth) {
    if (!root || depth < 0) return null;
    var inputs;
    try { inputs = root.querySelectorAll('input[type="text"], input:not([type])'); } catch(e) {}
    if (inputs) {
      for (var i = 0; i < inputs.length; i++) {
        if (visible(inputs[i])) return inputs[i];
      }
    }
    var katInputs;
    try { katInputs = root.querySelectorAll('kat-input'); } catch(e) {}
    if (katInputs) {
      for (var j = 0; j < katInputs.length; j++) {
        if (!katInputs[j].shadowRoot) continue;
        var inp = katInputs[j].shadowRoot.querySelector('input');
        if (inp && visible(inp)) return inp;
      }
    }
    var all; try { all = root.querySelectorAll('*'); } catch(e) { return null; }
    for (var k = 0; k < all.length; k++) {
      if (all[k].shadowRoot) {
        var r = findText(all[k].shadowRoot, depth - 1);
        if (r) return r;
      }
    }
    return null;
  }
  var result = findText(container, 14);
  if (result) return result;
  // Pass 2: any visible non-button input inside container
  function findAny(root, depth) {
    if (!root || depth < 0) return null;
    var inputs; try { inputs = root.querySelectorAll('input, textarea'); } catch(e) {}
    if (inputs) {
      for (var i = 0; i < inputs.length; i++) {
        var ty = (inputs[i].type||'').toLowerCase();
        if (ty === 'hidden' || ty === 'file' || ty === 'submit' ||
            ty === 'button' || ty === 'checkbox' || ty === 'radio') continue;
        if (visible(inputs[i])) return inputs[i];
      }
    }
    var all; try { all = root.querySelectorAll('*'); } catch(e) { return null; }
    for (var k = 0; k < all.length; k++) {
      if (all[k].shadowRoot) {
        var r2 = findAny(all[k].shadowRoot, depth - 1);
        if (r2) return r2;
      }
    }
    return null;
  }
  return findAny(container, 14);
}
"""

# 4c-i. Global floating-input metadata (serialisable — for logging only).
# Returns {count: N, index: N, selector: '...'} so the Python side can log it.
_JS_GLOBAL_ASIN_INPUT_META = """
() => {
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && !el.disabled;
  }
  function collectAll(root, depth, acc) {
    if (!root || depth < 0) return;
    try {
      root.querySelectorAll('input, textarea').forEach(function(inp) {
        var ty = (inp.type||'').toLowerCase();
        if (ty === 'hidden' || ty === 'file' || ty === 'submit' ||
            ty === 'button' || ty === 'checkbox' || ty === 'radio') return;
        if (visible(inp)) acc.push(inp);
      });
      root.querySelectorAll('kat-input').forEach(function(host) {
        if (!host.shadowRoot) return;
        var inp = host.shadowRoot.querySelector('input');
        if (inp && visible(inp)) acc.push(inp);
      });
    } catch(e) {}
    try {
      var nodes = root.querySelectorAll('*');
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].shadowRoot) collectAll(nodes[i].shadowRoot, depth - 1, acc);
      }
    } catch(e2) {}
  }
  var acc = [];
  collectAll(document, 18, acc);
  if (!acc.length) return {count: 0, index: -1, selector: 'none'};
  try {
    var ric = document.querySelectorAll('.regex-input-container input');
    for (var i = 0; i < ric.length; i++) {
      if (visible(ric[i])) return {count: acc.length, index: acc.indexOf(ric[i]), selector: '.regex-input-container input'};
    }
  } catch(e) {}
  return {count: acc.length, index: acc.length - 1, selector: 'last-visible-input'};
}
"""

# 4c-ii. Global floating-input element finder — returns the DOM element (not serialisable).
# Use evaluate_handle() so Playwright gets back an ElementHandle reference.
_JS_GLOBAL_FIND_ASIN_FLOATING_INPUT = """
() => {
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && !el.disabled;
  }
  function collectAll(root, depth, acc) {
    if (!root || depth < 0) return;
    try {
      root.querySelectorAll('input, textarea').forEach(function(inp) {
        var ty = (inp.type||'').toLowerCase();
        if (ty === 'hidden' || ty === 'file' || ty === 'submit' ||
            ty === 'button' || ty === 'checkbox' || ty === 'radio') return;
        if (visible(inp)) acc.push(inp);
      });
      root.querySelectorAll('kat-input').forEach(function(host) {
        if (!host.shadowRoot) return;
        var inp = host.shadowRoot.querySelector('input');
        if (inp && visible(inp)) acc.push(inp);
      });
    } catch(e) {}
    try {
      var nodes = root.querySelectorAll('*');
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].shadowRoot) collectAll(nodes[i].shadowRoot, depth - 1, acc);
      }
    } catch(e2) {}
  }
  var acc = [];
  collectAll(document, 18, acc);
  if (!acc.length) return null;
  try {
    var ric = document.querySelectorAll('.regex-input-container input');
    for (var i = 0; i < ric.length; i++) {
      if (visible(ric[i])) return ric[i];
    }
  } catch(e) {}
  return acc[acc.length - 1];
}
"""

# Click Save near a given input element: walks up ancestors first, then falls back globally.
_JS_CLICK_SAVE_NEAR_INPUT = """
(inp) => {
  if (!inp) return false;
  function textOf(el) {
    return ((el.innerText||el.textContent||'')).replace(/\\s+/g,' ').trim().toLowerCase();
  }
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  }
  function innerBtn(host, depth) {
    if (!host || depth < 0) return null;
    var root = host.shadowRoot || host;
    var btn; try { btn = root.querySelector('button'); } catch(e) {}
    if (btn) return btn;
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return null; }
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) { var f = innerBtn(nodes[i], depth-1); if (f) return f; }
    }
    return null;
  }
  function isSave(t) { return t === 'save' || t === 'save changes'; }
  function clickSaveIn(root, depth) {
    if (!root || depth < 0) return false;
    try {
      var els = root.querySelectorAll('kat-button, button, [role="button"]');
      for (var i = 0; i < els.length; i++) {
        if (!isSave(textOf(els[i])) || !visible(els[i])) continue;
        var tg = (els[i].tagName||'').toLowerCase();
        if (tg === 'kat-button') { var inner = innerBtn(els[i], 6); if (inner) { try { inner.click(); return true; } catch(e) {} } }
        try { els[i].click(); return true; } catch(e2) {}
      }
    } catch(e3) {}
    try {
      var nodes = root.querySelectorAll('*');
      for (var j = 0; j < nodes.length; j++) {
        if (nodes[j].shadowRoot && clickSaveIn(nodes[j].shadowRoot, depth-1)) return true;
      }
    } catch(e4) {}
    return false;
  }
  // 1. Walk up ancestors from the input (up to 10 levels)
  var p = inp.parentElement;
  for (var k = 0; k < 10 && p; k++) {
    if (clickSaveIn(p, 6)) return true;
    p = p.parentElement;
  }
  // 2. Global fallback
  return clickSaveIn(document, 14);
}
"""

# 5. Click Save inside or near the container.
_JS_SCOPED_CLICK_SAVE = """
(container) => {
  if (!container) return false;
  function textOf(el) {
    return ((el.innerText||el.textContent||'')).replace(/\\s+/g,' ').trim().toLowerCase();
  }
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  }
  function innerBtn(host, depth) {
    if (!host || depth < 0) return null;
    var root = host.shadowRoot || host;
    var btn; try { btn = root.querySelector('button'); } catch(e) {}
    if (btn) return btn;
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return null; }
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) { var f = innerBtn(nodes[i], depth-1); if (f) return f; }
    }
    return null;
  }
  function isSaveLabel(t) { return t === 'save' || t === 'save changes'; }
  function clickSaveIn(root, depth) {
    if (!root || depth < 0) return false;
    try {
      var els = root.querySelectorAll('kat-button, button, [role="button"]');
      for (var i = 0; i < els.length; i++) {
        if (!isSaveLabel(textOf(els[i]))) continue;
        if (!visible(els[i])) continue;
        var tg = (els[i].tagName||'').toLowerCase();
        if (tg === 'kat-button') {
          var inner = innerBtn(els[i], 8);
          if (inner) { try { inner.click(); return true; } catch(e) {} }
        }
        try { els[i].click(); return true; } catch(e2) {}
      }
    } catch(e3) {}
    try {
      var nodes = root.querySelectorAll('*');
      for (var j = 0; j < nodes.length; j++) {
        if (nodes[j].shadowRoot && clickSaveIn(nodes[j].shadowRoot, depth-1)) return true;
      }
    } catch(e4) {}
    return false;
  }
  if (clickSaveIn(container, 10)) return true;
  var p = container.parentElement;
  for (var k = 0; k < 6 && p; k++) {
    if (clickSaveIn(p, 6)) return true;
    p = p.parentElement;
  }
  return false;
}
"""

# 6. Verify ASIN was saved — scoped to the container and its ancestors.
_JS_SCOPED_VERIFY_ASIN = """
(args) => {
  var container = args[0], asin = (args[1]||'').toLowerCase();
  function textNorm(s) { return (s||'').replace(/\\s+/g,' ').trim().toLowerCase(); }
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }
  function hasPlaceholder(t) {
    return t.indexOf('enter asin') !== -1 || t.indexOf('[enter asin]') !== -1;
  }
  function containsAsin(t) { return asin && t.indexOf(asin) !== -1; }
  function walk(root, depth, fn) {
    if (!root || depth < 0) return false;
    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return false; }
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.shadowRoot && walk(el.shadowRoot, depth-1, fn)) return true;
      if (visible(el) && fn(textNorm(el.innerText||el.textContent||''))) return true;
    }
    return false;
  }
  var searchRoot = container || document;
  for (var u = 0; u < 4 && searchRoot && searchRoot.parentElement; u++) {
    searchRoot = searchRoot.parentElement;
  }
  var placeholderGone = !walk(searchRoot, 12, hasPlaceholder);
  if (!placeholderGone) return false;
  if (asin) return walk(searchRoot, 12, containsAsin);
  return true;
}
"""

_JS_POST_CONTINUE_ASIN_PLACEHOLDER_VISIBLE = """
() => {
  function textNorm(s) {
    return ((s || '')).replace(/\\s+/g, ' ').trim().toLowerCase();
  }
  function textOf(el) {
    return textNorm((el.innerText || el.textContent || ''));
  }
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }
  function hasPlaceholder(t) {
    return t.indexOf('enter asin') !== -1 || t.indexOf('[enter asin]') !== -1;
  }
  function walk(root, depth) {
    if (!root || depth < 0) return false;
    var nodes;
    try { nodes = root.querySelectorAll('*'); } catch(e) { return false; }
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.shadowRoot && walk(el.shadowRoot, depth - 1)) return true;
      if (visible(el) && hasPlaceholder(textOf(el))) return true;
    }
    return false;
  }
  return walk(document, 18);
}
"""

_JS_FRAME_CONTAINS_VISIBLE_TEXT = """
(needle) => {
  var n = (needle || '').trim();
  if (!n) return false;
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }
  function walk(root, depth) {
    if (!root || depth < 0) return false;
    var nodes;
    try { nodes = root.querySelectorAll('*'); } catch(e) { return false; }
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.shadowRoot && walk(el.shadowRoot, depth - 1)) return true;
      try {
        var t = (el.innerText || el.textContent || '');
        if (t.indexOf(n) === -1) continue;
        if (visible(el)) return true;
      } catch(e2) {}
    }
    return false;
  }
  return walk(document, 18);
}
"""

# Deep walk: collect textarea/input entries with ancestor text blobs (verify + steps scan).
_JS_FORM_FIELD_WALK_BASE = r"""
function __pwVisible(el) {
  if (!el) return false;
  var r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}
function __pwWalkFormFields(root, depth, acc) {
  if (!root || depth < 0) return;
  try {
    root.querySelectorAll('textarea, input:not([type="hidden"])').forEach(function(el) {
      var t = (el.tagName || '').toLowerCase();
      if (t === 'input') {
        var ty = (el.type || '').toLowerCase();
        if (ty === 'hidden' || ty === 'file' || ty === 'submit' || ty === 'button' || ty === 'checkbox' || ty === 'radio') return;
      }
      if (!__pwVisible(el)) return;
      if (acc.seen.indexOf(el) !== -1) return;
      acc.seen.push(el);
      var blob = '';
      var n = el;
      for (var j = 0; j < 14; j++) {
        if (!n) break;
        blob += (n.innerText || n.textContent || '') + ' ';
        n = n.parentElement;
      }
      acc.items.push({ el: el, value: (el.value || '').trim(), blob: blob.toLowerCase() });
    });
    root.querySelectorAll('kat-textarea').forEach(function(host) {
      if (!host.shadowRoot) return;
      var inner = host.shadowRoot.querySelector('textarea');
      if (!inner || !__pwVisible(inner) || acc.seen.indexOf(inner) !== -1) return;
      acc.seen.push(inner);
      var blob = '';
      var n = host;
      for (var j = 0; j < 14; j++) {
        if (!n) break;
        blob += (n.innerText || n.textContent || '') + ' ';
        n = n.parentElement;
      }
      acc.items.push({ el: inner, value: (inner.value || '').trim(), blob: blob.toLowerCase() });
    });
  } catch(e) {}
  try {
    root.querySelectorAll('*').forEach(function(n) {
      if (n.shadowRoot) __pwWalkFormFields(n.shadowRoot, depth - 1, acc);
    });
  } catch(e2) {}
}
"""

_JS_VERIFY_FORM_VALUES = (
    """
([helpText, stepsText, refText]) => {
"""
    + _JS_FORM_FIELD_WALK_BASE
    + """
  var acc = { seen: [], items: [] };
  __pwWalkFormFields(document, 16, acc);
  var items = acc.items;
  var helpNeed = !!(helpText && String(helpText).trim().length);
  var stepsNeed = !!(stepsText && String(stepsText).trim().length);
  var refNeed = !!(refText && String(refText).trim().length);
  var helpOk = !helpNeed;
  var stepsOk = !stepsNeed;
  var refOk = !refNeed;
  var rl = refNeed ? String(refText).trim().toLowerCase() : '';
  var i;
  for (i = 0; i < items.length; i++) {
    var v = items[i].value;
    var vl = v.toLowerCase();
    var b = items[i].blob;
    if (helpNeed && v.length > 0) {
      if (b.indexOf('what do you need help') !== -1 || b.indexOf('need help with') !== -1 || b.indexOf('describe your issue') !== -1)
        helpOk = true;
    }
    if (stepsNeed && v.length > 0) {
      if (b.indexOf('what steps have you taken already') !== -1 ||
          (b.indexOf('what steps have you taken') !== -1 && b.indexOf('already') !== -1))
        stepsOk = true;
    }
    if (refNeed && v.length > 0 && rl) {
      if ((b.indexOf('reference') !== -1 || b.indexOf('order') !== -1) && vl.indexOf(rl) !== -1)
        refOk = true;
    }
  }
  if (refNeed && !refOk && rl) {
    for (i = 0; i < items.length; i++) {
      if (items[i].value.toLowerCase().indexOf(rl) !== -1) { refOk = true; break; }
    }
  }
  if (helpNeed && !helpOk && items.length > 0 && items[0].value.length > 0)
    helpOk = true;
  return { helpOk: helpOk, stepsOk: stepsOk, refOk: refOk };
}
"""
)

_JS_FILL_STEPS_BY_LABEL_SCAN = (
    """
(stepsText) => {
"""
    + _JS_FORM_FIELD_WALK_BASE
    + """
  var acc = { seen: [], items: [] };
  __pwWalkFormFields(document, 16, acc);
  var items = acc.items;
  var count = items.length;
  var NEEDLE = 'what steps have you taken already';
  var NEEDLE2 = 'what steps have you taken';
  var j;
  for (j = 0; j < items.length; j++) {
    var b = items[j].blob;
    var matched = (b.indexOf(NEEDLE) !== -1) ||
      (b.indexOf(NEEDLE2) !== -1 && b.indexOf('already') !== -1);
    if (!matched) continue;
    var el = items[j].el;
    try { el.focus(); } catch(e) {}
    var tag = (el.tagName || '').toLowerCase();
    var proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) { desc.set.call(el, stepsText); } else { el.value = stepsText; }
    ['input', 'change', 'blur'].forEach(function(t) {
      try { el.dispatchEvent(new Event(t, { bubbles: true, cancelable: true })); } catch(e) {}
    });
    var L = (el.value || '').trim().length;
    return { ok: L > 0, count: count, matchedByLabel: true, finalLen: L };
  }
  return { ok: false, count: count, matchedByLabel: false, finalLen: 0 };
}
"""
)


def _log(msg: str) -> None:
    print(f"{_LOG_PREFIX} {msg}", flush=True)


def _human_pause(label: str, min_ms: int = 700, max_ms: int = 1800) -> None:
    """Randomized human-like delay with a log line so every pause is traceable."""
    ms = random.randint(min_ms, max_ms)
    _log(f"human pause: {ms}ms at {label}")
    time.sleep(ms / 1000.0)


# ---------------------------------------------------------------------------
# Structured result builder
# ---------------------------------------------------------------------------

def _result(
    ok: bool,
    status: str,
    amazon_case_id: Optional[str] = None,
    step_failed: Optional[str] = None,
    error: Optional[str] = None,
) -> dict:
    """Build a canonical result dict for all public methods."""
    return {
        "ok": ok,
        "status": status,
        "amazon_case_id": amazon_case_id,
        "step_failed": step_failed,
        "error": error,
    }


# ---------------------------------------------------------------------------
# Main class
# ---------------------------------------------------------------------------

class PlaywrightCaseOpener:
    """
    Playwright-based agent for filing an Amazon Seller Central help case
    via the "My issue is not listed" flow (sync API).

    Preferred usage (context manager)::

        with PlaywrightCaseOpener(cdp_endpoint="http://127.0.0.1:9222") as opener:
            result = opener.submit_not_listed_claim(
                payload={
                    "help_text": "Lost FBA unit — requesting reimbursement.",
                    "steps_text": "Checked inventory; no unit present.",
                    "reference_text": "114-1234567-1234567",
                },
                pdf_path=r"C:\\evidence\\report.pdf",
            )

    Manual lifecycle::

        opener = PlaywrightCaseOpener()
        opener.start()
        result = opener.submit_not_listed_claim(payload={...})
        opener.stop()
    """

    def __init__(
        self,
        cdp_endpoint: Optional[str] = None,
        hub_url: str = BROWSE_ISSUE_HUB_URL,
        headless: bool = False,
        mock_submit: bool = False,
    ):
        """
        Parameters
        ----------
        cdp_endpoint:
            Chrome DevTools Protocol URL, e.g. "http://127.0.0.1:9222".
            If omitted, reads CHROME_DEBUGGER_ADDRESS from .env.
            If still empty, launches a fresh Chromium instance.
        hub_url:
            Amazon Help Hub entry URL.
        headless:
            Only used when launching a fresh browser (no CDP endpoint).
        mock_submit:
            Fill the form but skip the final Submit click — for testing.
        """
        raw_ep = cdp_endpoint or os.getenv("CHROME_DEBUGGER_ADDRESS", "").strip()
        if raw_ep and not raw_ep.startswith("http"):
            raw_ep = f"http://{raw_ep}"
        self.cdp_endpoint = raw_ep
        self.hub_url      = hub_url
        self.headless     = headless
        self.mock_submit  = mock_submit

        self._pw          = None
        self._browser: Optional[Browser]        = None
        self._context: Optional[BrowserContext] = None
        self._page:    Optional[Page]           = None
        self._hub_frame: Optional[Frame]        = None  # active hub iframe context
        # Step 3: always "not_listed_fallback" — hub issue tiles are never selected.
        self._help_hub_path: Optional[str] = None
        # Step 5: last Playwright locators used for required textareas (pre-submit prefers these).
        self._help_field_locator: Optional[Locator] = None
        self._steps_field_locator: Optional[Locator] = None

    # ------------------------------------------------------------------
    # Browser lifecycle
    # ------------------------------------------------------------------

    def start(self) -> "PlaywrightCaseOpener":
        """Start Playwright and attach to (or launch) Chrome."""
        self._pw = sync_playwright().start()
        if self.cdp_endpoint:
            _log(f"Connecting to existing Chrome via CDP: {self.cdp_endpoint!r}")
            self._browser = self._pw.chromium.connect_over_cdp(self.cdp_endpoint)
            contexts = self._browser.contexts
            if contexts:
                self._context = contexts[0]
                pages = self._context.pages
                self._page = pages[0] if pages else self._context.new_page()
            else:
                self._context = self._browser.new_context()
                self._page = self._context.new_page()
        else:
            _log("Launching fresh Chromium (set CHROME_DEBUGGER_ADDRESS to reuse a session).")
            self._browser = self._pw.chromium.launch(headless=self.headless)
            self._context = self._browser.new_context()
            self._page = self._context.new_page()
        _log("Browser ready.")
        return self

    def stop(self) -> None:
        """Close browser and stop Playwright (only when we launched it ourselves)."""
        if not self.cdp_endpoint and self._browser:
            try:
                self._browser.close()
            except Exception:
                pass
        if self._pw:
            try:
                self._pw.stop()
            except Exception:
                pass
        _log("Playwright stopped.")

    def __enter__(self) -> "PlaywrightCaseOpener":
        return self.start()

    def __exit__(self, *_) -> None:
        self.stop()

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _active_frame(self) -> Frame:
        """Return the hub frame, or the main frame as fallback."""
        return self._hub_frame or self._page.main_frame

    def _frame_has_content(self, frame: Frame, markers: tuple) -> bool:
        """Return True if frame's serialised HTML contains any marker string."""
        try:
            content = frame.content().lower()
            return any(m in content for m in markers)
        except Exception:
            return False

    # ------------------------------------------------------------------
    # Step 1 — Navigation
    # ------------------------------------------------------------------

    def navigate(self, url: Optional[str] = None) -> None:
        """
        Navigate to the Help Hub browse-issue URL.
        Waits for DOM content to load before returning.
        """
        target = url or self.hub_url
        _log(f"Step 1: navigating to {target!r}")
        self._page.goto(target, wait_until="domcontentloaded", timeout=_PAGE_LOAD_TIMEOUT_MS)
        _log("Step 1 OK: page loaded.")
        _human_pause("after page load", 800, 1600)

    # ------------------------------------------------------------------
    # Step 2 — Iframe handling (DFS content-marker scan)
    # ------------------------------------------------------------------

    def _dfs_find_hub_frame(
        self,
        frames: list[Frame],
        depth: int = 0,
        max_depth: int = 6,
    ) -> Optional[Frame]:
        """
        *** IFRAME HANDLING ***
        Recursively scan a frame list for hub content markers.

        Playwright exposes Frame objects directly — no switch_to() is needed.
        Each frame's child_frames are walked recursively until the one whose
        serialised HTML contains an _HUB_CONTENT_MARKERS string is found.

        Returns the matching Frame or None.
        """
        if depth > max_depth:
            return None
        for frame in frames:
            if self._frame_has_content(frame, _HUB_CONTENT_MARKERS):
                _log(f"Hub frame at depth {depth}: name={frame.name!r} url={frame.url[:80]!r}")
                return frame
            child = self._dfs_find_hub_frame(frame.child_frames, depth + 1, max_depth)
            if child:
                return child
        return None

    def find_hub_frame(self) -> Optional[Frame]:
        """
        Locate the iframe that owns the Help Hub UI.

        Strategy (in order):
          1. Check if the main page itself already contains hub content.
          2. Prefer frames whose URL contains hub/contact/support/help keywords.
          3. DFS all top-level child frames checking content markers.
        """
        # 1. Main frame shortcut (no iframe)
        if self._frame_has_content(self._page.main_frame, _HUB_CONTENT_MARKERS):
            _log("Hub content in main frame — no iframe needed.")
            return self._page.main_frame

        # 2. Prefer by URL keyword match
        hub_url_kws = ("hub", "contact", "support", "help", "issue")
        for frame in self._page.frames:
            if any(kw in frame.url.lower() for kw in hub_url_kws):
                if self._frame_has_content(frame, _HUB_CONTENT_MARKERS):
                    _log(f"Hub frame via URL keyword: {frame.url[:80]!r}")
                    return frame

        # 3. DFS fallback across all top-level child frames
        top_frames = self._page.main_frame.child_frames
        _log(f"Top-level child frames: {len(top_frames)} — DFS scan starting.")
        return self._dfs_find_hub_frame(top_frames)

    def _wait_for_hub_frame(self, timeout_sec: float = _HUB_FRAME_TIMEOUT_SEC) -> Optional[Frame]:
        """
        Poll for the hub frame until found or timeout.
        Sets self._hub_frame and returns it (or the main frame as fallback).
        """
        _log(f"Step 2: locating hub iframe (timeout {timeout_sec}s)…")
        deadline = time.monotonic() + timeout_sec
        while time.monotonic() < deadline:
            frame = self.find_hub_frame()
            if frame:
                self._hub_frame = frame
                _log(f"Step 2 OK: hub frame set → {frame.url[:80]!r}")
                return frame
            time.sleep(_POLL_INTERVAL_SEC)
        _log("Step 2 WARN: hub frame not found — using main frame.")
        self._hub_frame = self._page.main_frame
        return self._hub_frame

    def _wait_for_hub_content_ready(self, timeout_ms: int = _HUB_READY_TIMEOUT_MS) -> bool:
        """
        Wait for the hub frame's Shadow DOM to hydrate before attempting clicks.

        Uses locator-based waiting (no hard sleep).
        Tries several selectors in priority order; succeeds on the first match.

        NOTE: #issueNotListedButton is on the wrapper <div>, not the kat-button —
        that makes it a reliable light-DOM readiness signal.
        """
        frame = self._active_frame()
        # Try selectors from most specific to most generic
        # NOTE: 'kat-button' appears in Amazon's Hub as soon as the widget hydrates;
        # it is a reasonable hydration sentinel but could theoretically match
        # other kat-buttons on the page before the Hub loads.
        for selector in (
            "#issueNotListedButton",      # wrapper div — reliable when Hub is loaded
            "kat-button",                 # any KAT button — appears early in Hub
            "[id*='issueNotListed']",     # partial ID match for future naming changes
        ):
            try:
                frame.locator(selector).first.wait_for(state="attached", timeout=timeout_ms)
                _log(f"Hub content ready — sentinel {selector!r} attached.")
                return True
            except PWTimeoutError:
                continue
            except Exception:
                continue
        _log("Hub content readiness check timed out — proceeding anyway.")
        return False

    # ------------------------------------------------------------------
    # Step 3 — Always "My issue is not listed" (never other hub issue tiles)
    # ------------------------------------------------------------------

    def _step_3_choose_help_hub_path(self, _help_text: str) -> dict:
        """
        Product requirement: on the Help Hub "common issues" grid, do not select any
        reimbursement or other tiles — only click **My issue is not listed**, then continue.
        """
        self._help_hub_path = None
        _log(
            "Step 3: Help Hub — skipping issue tiles; only clicking "
            "'My issue is not listed'…"
        )
        self._help_hub_path = "not_listed_fallback"
        _log("path selected: not_listed_fallback")
        if not self.click_not_listed():
            return {
                "ok": False,
                "step_failed": "click_issue_not_listed",
                "error": "Button not found across frames after retries",
            }
        return {"ok": True, "path": "not_listed_fallback"}

    # ------------------------------------------------------------------
    # Step 3 — Click "My issue is not listed" (implementation: click_not_listed)
    # ------------------------------------------------------------------

    def _collect_all_frames_dfs(self) -> list[Frame]:
        """Main frame first, then depth-first over child_frames (fresh each call)."""
        ordered: list[Frame] = []
        seen: set[int] = set()

        def walk(fr: Frame) -> None:
            fid = id(fr)
            if fid in seen:
                return
            seen.add(fid)
            ordered.append(fr)
            for ch in fr.child_frames:
                walk(ch)

        walk(self._page.main_frame)
        return ordered

    def _try_click_issue_not_listed_locators(self, frame: Frame) -> bool:
        """
        Locator-first strategies for one frame only, in priority order:
        role → get_by_text → button:has-text → #issueNotListedButton (and variants).
        """
        for name_pat in (
            re.compile(r"my issue is not listed", re.IGNORECASE),
            re.compile(r"my issue isn't listed", re.IGNORECASE),
        ):
            try:
                loc = frame.get_by_role("button", name=name_pat).first
                if loc.count() == 0:
                    continue
                try:
                    loc.scroll_into_view_if_needed(timeout=800)
                except Exception:
                    pass
                if self._try_click_locator(loc, f"role/{name_pat.pattern}"):
                    return True
            except Exception:
                pass

        for text_val in ("My issue is not listed", "My issue isn't listed"):
            try:
                loc = frame.get_by_text(text_val, exact=False).first
                if loc.count() == 0:
                    continue
                try:
                    loc.scroll_into_view_if_needed(timeout=800)
                except Exception:
                    pass
                if self._try_click_locator(loc, f"text={text_val!r}"):
                    return True
            except Exception:
                pass

        for sel in (
            'button:has-text("My issue is not listed")',
            "button:has-text('My issue is not listed')",
            "button:has-text(\"My issue isn't listed\")",
        ):
            try:
                loc = frame.locator(sel).first
                if loc.count() == 0:
                    continue
                try:
                    loc.scroll_into_view_if_needed(timeout=800)
                except Exception:
                    pass
                if self._try_click_locator(loc, sel):
                    return True
            except Exception:
                pass

        for sel in (
            "#issueNotListedButton",
            "[id='issueNotListedButton']",
            "[id*='issueNotListed']",
        ):
            try:
                loc = frame.locator(sel).first
                if loc.count() == 0:
                    continue
                try:
                    loc.scroll_into_view_if_needed(timeout=800)
                except Exception:
                    pass
                if self._try_click_locator(loc, sel):
                    return True
            except Exception:
                pass

        return False

    def _try_click_locator(self, loc, label: str) -> bool:
        """
        Attempt to click a Playwright Locator with three escalating strategies:
          1. Normal .click()                    — respects actionability checks
          2. scroll_into_view + .click()        — handles off-screen elements
          3. .click(force=True)                 — bypasses actionability (last resort)

        Returns True on the first strategy that succeeds without raising.
        Logs which strategy worked.
        """
        # 1 — normal click
        try:
            loc.click(timeout=2_000)
            _log(f"  clicked normally ({label}).")
            return True
        except Exception:
            pass

        # 2 — scroll into view, then retry
        try:
            loc.scroll_into_view_if_needed(timeout=1_000)
            loc.click(timeout=2_000)
            _log(f"  clicked after scroll ({label}).")
            return True
        except Exception:
            pass

        # 3 — force click (ignores visibility / overlap guards)
        try:
            loc.click(force=True, timeout=2_000)
            _log(f"  clicked with force=True ({label}).")
            return True
        except Exception:
            pass

        return False

    def click_not_listed(self, timeout_sec: float = _NOT_LISTED_TIMEOUT_SEC) -> bool:
        """
        Retry loop (~1s): each attempt re-collects ALL frames (main + DFS children),
        runs locator-first strategies per frame, then JS fallback per frame.
        Does not use a cached hub frame — DOM/iframe layout may change between tries.
        """
        _log("Step 3: clicking 'My issue is not listed' (multi-frame retry)…")
        _human_pause("before My issue is not listed", 600, 1200)
        deadline = time.monotonic() + timeout_sec
        attempt = 0

        while time.monotonic() < deadline:
            attempt += 1
            _log(f"retry attempt {attempt}")

            frames = self._collect_all_frames_dfs()
            _log(f"frames scanned: {len(frames)}")

            for fr in frames:
                url_short = (fr.url or "")[:200]
                try:
                    if self._try_click_issue_not_listed_locators(fr):
                        _log(f"found in frame: {url_short}")
                        _log("Step 3 OK: clicked (locator).")
                        _human_pause("after My issue is not listed", 600, 1200)
                        return True
                except Exception as e:
                    _log(f"  locator pass error in frame {url_short[:80]!r} — {e}")

            js_checked: list[str] = []
            for fr in frames:
                u = (fr.url or "")[:200]
                js_checked.append(u or "(empty url)")
                try:
                    result = fr.evaluate(_JS_CLICK_ISSUE_NOT_LISTED)
                    if isinstance(result, dict) and result.get("ok"):
                        _log(f"found in frame: {u}")
                        _log(
                            f"Step 3 OK: clicked via JS "
                            f"via={result.get('via')!r}."
                        )
                        _human_pause("after My issue is not listed", 600, 1200)
                        return True
                    if isinstance(result, dict) and result.get("reason"):
                        _log(
                            f"  JS miss in frame {u[:80]!r} — "
                            f"{result.get('reason')!r}"
                        )
                except Exception as e:
                    _log(f"  JS error in frame {u[:80]!r} — {e}")

            _log(f"not found in any frame (attempt {attempt}); JS checked URLs: {js_checked}")
            _log("not found in any frame")

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(_NOT_LISTED_RETRY_INTERVAL_SEC, remaining))

        _log(
            f"Step 3 FAILED: 'My issue is not listed' not clicked within {timeout_sec}s."
        )
        return False

    # ------------------------------------------------------------------
    # Step 4 — Wait for form
    # ------------------------------------------------------------------

    def wait_for_form(self, timeout_sec: float = _FORM_APPEAR_TIMEOUT_SEC) -> bool:
        """
        Wait until the 'What do you need help with?' form appears.

        Checks frame content for _FORM_CONTENT_MARKERS, then confirms at least
        one textarea / kat-textarea is present via JS shadow-DOM walk.
        Also scans sibling frames — Amazon sometimes opens the form in a new
        nested iframe context after the button click.
        Updates self._hub_frame if the form appears in a different frame.
        """
        _log(f"Step 4: waiting for form (timeout {timeout_sec}s)…")
        frame = self._active_frame()
        deadline = time.monotonic() + timeout_sec

        while time.monotonic() < deadline:
            # Check active frame first
            if self._frame_has_content(frame, _FORM_CONTENT_MARKERS):
                field_present = frame.evaluate("""
                () => {
                  function walk(root, depth) {
                    if (!root || depth < 0) return false;
                    if (root.querySelector('textarea, kat-textarea, kat-input')) return true;
                    var nodes; try { nodes = root.querySelectorAll('*'); } catch(e) { return false; }
                    for (var i = 0; i < nodes.length; i++) {
                      if (nodes[i].shadowRoot && walk(nodes[i].shadowRoot, depth - 1)) return true;
                    }
                    return false;
                  }
                  return walk(document, 12);
                }
                """)
                if field_present:
                    _log("Step 4 OK: form fields detected in active frame.")
                    return True

            # Scan all frames — form may appear in a sibling or nested frame
            for f in self._page.frames:
                if f is frame:
                    continue
                if self._frame_has_content(f, _FORM_CONTENT_MARKERS):
                    _log(f"Step 4 OK: form in different frame {f.url[:60]!r} — updating hub_frame.")
                    self._hub_frame = f
                    frame = f
                    return True

            time.sleep(_POLL_INTERVAL_SEC)

        _log("Step 4 FAILED: form not found within timeout.")
        return False

    # ------------------------------------------------------------------
    # Step 5 — Fill form fields
    # ------------------------------------------------------------------

    @staticmethod
    def _inspect_native_control(
        control: Locator | ElementHandle | None,
    ) -> dict:
        """Read value length + aria-invalid / error classes / red hints on a control."""
        if control is None:
            return {
                "valueLen": 0,
                "ariaInvalid": True,
                "invalidClass": True,
                "redHint": False,
                "looksInvalid": True,
                "summary": "no control",
            }
        try:
            raw = control.evaluate(_JS_INSPECT_NATIVE_CONTROL.strip())
            if isinstance(raw, dict):
                return raw
        except Exception:
            pass
        return {
            "valueLen": 0,
            "ariaInvalid": True,
            "invalidClass": False,
            "redHint": False,
            "looksInvalid": True,
            "summary": "inspect_failed",
        }

    def _element_handle_best_native(self, frame: Frame, kind: str) -> Optional[ElementHandle]:
        try:
            jh = frame.evaluate_handle(_JS_FIND_BEST_NATIVE, kind)
            el = jh.as_element()
            return el
        except Exception:
            return None

    def _locate_help_textarea(self, frame: Frame) -> Optional[Locator]:
        label_patterns = (
            re.compile(r"what do you need help with", re.IGNORECASE),
            re.compile(r"need help with", re.IGNORECASE),
            re.compile(r"describe your issue", re.IGNORECASE),
            re.compile(r"what do you need", re.IGNORECASE),
        )
        for pat in label_patterns:
            try:
                root = frame.get_by_label(pat).first
                if root.count() == 0:
                    continue
                ta = root.locator("textarea").first
                if ta.count() > 0 and ta.is_visible(timeout=600):
                    return ta
                if root.is_visible(timeout=600):
                    return root
            except Exception:
                continue
        for label_text in (
            "What do you need help with?",
            "What do you need help with",
        ):
            try:
                label_loc = frame.get_by_text(label_text, exact=False).first
                if label_loc.count() == 0:
                    continue
                field_loc = label_loc.locator("..").locator("textarea, input").first
                if field_loc.count() > 0 and field_loc.is_visible(timeout=500):
                    return field_loc
            except Exception:
                continue
        try:
            loc = frame.locator("textarea").first
            if loc.is_visible(timeout=400):
                return loc
        except Exception:
            pass
        return None

    def _locate_steps_textarea(self, frame: Frame) -> Optional[Locator]:
        """
        Dedicated resolution for "What steps have you taken already?" — label / text /
        positional fallbacks inside the hub frame. Used for fill + pre-submit inspection.
        """
        label_patterns = (
            re.compile(r"what steps have you taken already", re.IGNORECASE),
            re.compile(r"what steps have you taken", re.IGNORECASE),
            re.compile(r"steps (have you )?taken", re.IGNORECASE),
            re.compile(r"steps already", re.IGNORECASE),
        )
        for pat in label_patterns:
            try:
                root = frame.get_by_label(pat).first
                if root.count() == 0:
                    continue
                ta = root.locator("textarea").first
                if ta.count() > 0 and ta.is_visible(timeout=600):
                    return ta
                if root.is_visible(timeout=600):
                    return root
            except Exception:
                continue
        for label_text in (
            "What steps have you taken already?",
            "What steps have you taken?",
            "Steps taken",
            "Steps",
        ):
            try:
                label_loc = frame.get_by_text(label_text, exact=False).first
                if label_loc.count() == 0:
                    continue
                field_loc = label_loc.locator("..").locator("textarea, input").first
                if field_loc.count() > 0 and field_loc.is_visible(timeout=500):
                    return field_loc
            except Exception:
                continue
        try:
            loc = frame.locator("textarea").nth(1)
            if loc.is_visible(timeout=500):
                return loc
        except Exception:
            pass
        try:
            count = frame.locator("textarea").count()
            for i in range(1, count):
                loc = frame.locator("textarea").nth(i)
                try:
                    if loc.is_visible(timeout=300):
                        return loc
                except Exception:
                    continue
        except Exception:
            pass
        return None

    def _resolve_field_control_for_pre_submit(
        self, frame: Frame, kind: str
    ) -> Locator | ElementHandle | None:
        """
        Resolve the actual control for help or steps: prefer stored Step-5 locator,
        else dedicated locate, else shadow-aware JS best-native handle.
        kind: 'help' | 'steps'
        """
        if kind == "help":
            loc_stored = self._help_field_locator
            if loc_stored is not None:
                try:
                    if loc_stored.count() > 0:
                        return loc_stored
                except Exception:
                    pass
            loc = self._locate_help_textarea(frame)
            if loc is not None:
                return loc
            return self._element_handle_best_native(frame, "help")
        if kind == "steps":
            loc_stored = self._steps_field_locator
            if loc_stored is not None:
                try:
                    if loc_stored.count() > 0:
                        return loc_stored
                except Exception:
                    pass
            loc = self._locate_steps_textarea(frame)
            if loc is not None:
                return loc
            return self._element_handle_best_native(frame, "steps")
        return None

    @staticmethod
    def _log_pre_submit_field_line(field: str, inv: dict) -> None:
        _log(
            f"pre-submit {field}: value_len={inv.get('valueLen')} "
            f"aria-invalid={inv.get('ariaInvalid')} invalidClass={inv.get('invalidClass')} "
            f"redHint={inv.get('redHint')} looksInvalid={inv.get('looksInvalid')}"
        )

    def _pre_submit_validate_both_fields(
        self, frame: Frame, help_text: str, steps_text: str
    ) -> Optional[tuple[str, str]]:
        """
        Help is validated when help_text is non-empty. Steps are always validated
        for this flow (steps_text must be non-empty before _run_flow).

        Returns None if OK, else (step_failed, error) for _result().
        """
        ht = (help_text or "").strip()
        st = (steps_text or "").strip()

        ctrl_h: Locator | ElementHandle | None = None
        ctrl_s: Locator | ElementHandle | None = None
        inv_h: Optional[dict] = None
        inv_s: Optional[dict] = None

        if ht:
            ctrl_h = self._resolve_field_control_for_pre_submit(frame, "help")
            inv_h = self._inspect_native_control(ctrl_h)
            self._log_pre_submit_field_line("help", inv_h)
        else:
            _log("pre-submit help: (not required — empty help_text in payload)")

        ctrl_s = self._resolve_field_control_for_pre_submit(frame, "steps")
        inv_s = self._inspect_native_control(ctrl_s)
        self._log_pre_submit_field_line("steps", inv_s)

        if not st:
            _log("pre-submit validation failed (steps: empty steps_text)")
            return (
                "missing_steps_text",
                "steps_text is empty before form fill",
            )

        if ctrl_s is None:
            _log("pre-submit validation failed (steps: no control resolved)")
            return (
                "pre_submit_steps_validation",
                "Steps field not reliably validated before Continue",
            )
        assert inv_s is not None
        if inv_s.get("valueLen", 0) == 0 or inv_s.get("looksInvalid"):
            _log("pre-submit validation failed (steps: empty or invalid UI state)")
            return (
                "pre_submit_steps_validation",
                "Steps field not reliably validated before Continue",
            )

        if ht:
            if ctrl_h is None:
                _log("pre-submit validation failed (help: no control resolved)")
                return (
                    "pre_submit_validation",
                    "Required Amazon form fields still invalid before Continue",
                )
            assert inv_h is not None
            if inv_h.get("valueLen", 0) == 0 or inv_h.get("looksInvalid"):
                _log("pre-submit validation failed (help: empty or invalid UI state)")
                return (
                    "pre_submit_validation",
                    "Required Amazon form fields still invalid before Continue",
                )

        _log("pre-submit validation passed")
        return None

    def _debug_screenshot(self, tag: str) -> Optional[str]:
        """Save full-page PNG under the system temp dir; log path or failure."""
        if not self._page:
            return None
        name = f"pw-helphub-{tag}-{int(time.time() * 1000)}.png"
        path = os.path.join(tempfile.gettempdir(), name)
        try:
            self._page.screenshot(path=path, full_page=True)
            _log(f"debug screenshot saved: {path}")
            return path
        except Exception as e:
            _log(f"debug screenshot failed ({tag}): {e}")
            return None

    def _type_humanlike_locator(self, locator: Locator, text: str) -> None:
        """Type text character-by-character with a random 35–120 ms delay per keystroke."""
        for ch in text:
            delay_ms = random.randint(35, 120)
            try:
                locator.type(ch, delay=delay_ms)
            except Exception:
                break

    def _type_humanlike_handle(self, handle: ElementHandle, text: str) -> None:
        """Same as _type_humanlike_locator but for an ElementHandle."""
        for ch in text:
            delay_ms = random.randint(35, 120)
            try:
                handle.type(ch, delay=delay_ms)
            except Exception:
                break

    def _complete_required_textarea(self, field_locator: Locator, text: str, field_name: str) -> bool:
        """
        Human-like completion: click → focus → clear → type (per-char randomized delay) → blur → Tab;
        if still invalid or empty, JS value + focus/input/change/blur; re-check.
        """
        frame = self._active_frame()
        before = self._inspect_native_control(field_locator)
        _log(f"{field_name} field invalid before: {before.get('summary', '')}")

        try:
            field_locator.click(timeout=3_000)
        except Exception as e:
            _log(f"{field_name}: click failed — {e}")
        try:
            field_locator.focus(timeout=2_000)
        except Exception:
            pass
        try:
            field_locator.clear(timeout=2_000)
        except Exception:
            try:
                field_locator.fill("", timeout=2_000)
            except Exception:
                pass
        try:
            field_locator.press("Control+a")
            field_locator.press("Backspace")
        except Exception:
            pass
        try:
            self._type_humanlike_locator(field_locator, text)
        except Exception as e:
            _log(f"{field_name}: type() failed — {e}")
        try:
            field_locator.blur()
        except Exception:
            pass
        try:
            field_locator.press("Tab")
        except Exception:
            try:
                self._page.keyboard.press("Tab")
            except Exception:
                pass

        after = self._inspect_native_control(field_locator)
        _log(
            f"{field_name} field: value_len={after.get('valueLen')} "
            f"aria-invalid={after.get('ariaInvalid')} invalid_class={after.get('invalidClass')} "
            f"red_hint={after.get('redHint')}"
        )
        _log(f"{field_name} field invalid after: {after.get('summary', '')}")

        if not after.get("looksInvalid") and after.get("valueLen", 0) > 0:
            return True

        el = None
        try:
            el = field_locator.element_handle(timeout=2_000)
        except Exception:
            pass
        if el is not None:
            try:
                frame.evaluate(_JS_REQUIRED_FIELD_VALUE_EVENTS, [el, text])
            except Exception as e:
                _log(f"{field_name}: JS value/events fallback failed — {e}")
            after = self._inspect_native_control(field_locator)
            _log(f"{field_name} field invalid after: {after.get('summary', '')}")

        ok = not after.get("looksInvalid") and after.get("valueLen", 0) > 0
        return bool(ok)

    def _complete_required_element_handle(
        self,
        frame: Frame,
        element_handle: ElementHandle,
        text: str,
        field_name: str,
    ) -> bool:
        """Same completion order as _complete_required_textarea, for JS-resolved handles."""
        before = self._inspect_native_control(element_handle)
        _log(f"{field_name} field invalid before: {before.get('summary', '')}")

        try:
            element_handle.click(timeout=3_000)
        except Exception as e:
            _log(f"{field_name} (handle): click failed — {e}")
        try:
            element_handle.focus(timeout=2_000)
        except Exception:
            pass
        try:
            element_handle.fill("")
        except Exception:
            pass
        try:
            element_handle.press("Control+a")
            element_handle.press("Backspace")
        except Exception:
            pass
        try:
            self._type_humanlike_handle(element_handle, text)
        except Exception as e:
            _log(f"{field_name} (handle): type() failed — {e}")
        try:
            element_handle.blur()
        except Exception:
            pass
        try:
            element_handle.press("Tab")
        except Exception:
            pass

        after = self._inspect_native_control(element_handle)
        _log(
            f"{field_name} field: value_len={after.get('valueLen')} "
            f"aria-invalid={after.get('ariaInvalid')} invalid_class={after.get('invalidClass')} "
            f"red_hint={after.get('redHint')}"
        )
        _log(f"{field_name} field invalid after: {after.get('summary', '')}")

        if not after.get("looksInvalid") and after.get("valueLen", 0) > 0:
            return True

        try:
            frame.evaluate(_JS_REQUIRED_FIELD_VALUE_EVENTS, [element_handle, text])
        except Exception as e:
            _log(f"{field_name} (handle): JS fallback failed — {e}")
        after = self._inspect_native_control(element_handle)
        _log(f"{field_name} field invalid after: {after.get('summary', '')}")
        return bool(not after.get("looksInvalid") and after.get("valueLen", 0) > 0)

    @staticmethod
    def _post_continue_asin_chip_not_found_result() -> dict:
        return _result(
            ok=False,
            status="failed",
            amazon_case_id=None,
            step_failed="post_continue_asin_chip_not_found",
            error="Reached next page after Continue but could not find Enter ASIN chip",
        )

    @staticmethod
    def _post_continue_asin_save_failed_result() -> dict:
        return _result(
            ok=False,
            status="failed",
            amazon_case_id=None,
            step_failed="post_continue_asin_save_failed",
            error="ASIN chip editor opened but ASIN was not saved",
        )

    def _frames_ordered_post_continue(self, primary: Optional[Frame] = None) -> list[Frame]:
        ordered: list[Frame] = []
        seen: set[int] = set()

        def add(fr: Optional[Frame]) -> None:
            if not fr:
                return
            fid = id(fr)
            if fid in seen:
                return
            seen.add(fid)
            ordered.append(fr)

        add(primary)
        add(self._hub_frame)
        for fr in self._collect_all_frames_dfs():
            add(fr)
        return ordered

    def _locate_asin_chip_in_frame(self, frame: Frame) -> Optional[ElementHandle]:
        try:
            jh = frame.evaluate_handle(_JS_FIND_POST_CONTINUE_ASIN_CHIP_CLICKABLE)
            el = jh.as_element()
            return el
        except Exception:
            return None

    def _frame_with_suggested_description_and_asin_chip(self) -> tuple[Optional[Frame], Optional[ElementHandle]]:
        """
        Prefer a frame that shows **Suggested description** and a visible ASIN chip.
        """
        for fr in self._frames_ordered_post_continue():
            try:
                sd = fr.get_by_text("Suggested description", exact=False).first
                if sd.count() == 0 or not sd.is_visible(timeout=500):
                    continue
                chip = self._locate_asin_chip_in_frame(fr)
                if chip is not None:
                    return fr, chip
            except Exception:
                continue
        return None, None

    def _find_asin_chip_any_frame_after_intermediate(self) -> tuple[Optional[Frame], Optional[ElementHandle]]:
        """Fallback: any frame with a visible Enter ASIN / [Enter ASIN] chip."""
        for fr in self._frames_ordered_post_continue():
            chip = self._locate_asin_chip_in_frame(fr)
            if chip is not None:
                return fr, chip
        return None, None

    def _wait_popup_asin_input_post_continue(
        self, primary: Optional[Frame], timeout_ms: int = 10_000
    ) -> Optional[ElementHandle]:
        deadline = time.monotonic() + (timeout_ms / 1000.0)
        while time.monotonic() < deadline:
            for fr in self._frames_ordered_post_continue(primary):
                try:
                    jh = fr.evaluate_handle(_JS_FIND_POST_CONTINUE_ASIN_POPUP_INPUT)
                    el = jh.as_element()
                    if el is not None:
                        return el
                except Exception:
                    pass
            time.sleep(_POLL_INTERVAL_SEC)
        return None

    def _wait_local_asin_input(
        self,
        frame: Frame,
        container: ElementHandle,
        timeout_ms: int = 8_000,
    ) -> Optional[ElementHandle]:
        """
        Poll for the inline ASIN editor that appears near `container` after
        clicking the chip.  Scoped — will never match the top-page search bar.
        """
        deadline = time.monotonic() + (timeout_ms / 1000.0)
        while time.monotonic() < deadline:
            try:
                jh = frame.evaluate_handle(_JS_SCOPED_FIND_ASIN_INPUT, container)
                el = jh.as_element()
                if el is not None:
                    return el
            except Exception:
                pass
            time.sleep(_POLL_INTERVAL_SEC)
        return None

    def _click_asin_save_any_frame(self, primary: Optional[Frame]) -> bool:
        for fr in self._frames_ordered_post_continue(primary):
            try:
                if fr.evaluate(_JS_CLICK_SAVE_POST_CONTINUE):
                    return True
            except Exception:
                continue
        return False

    def _verify_asin_resolved_post_continue(self, asin: str) -> bool:
        """``Enter ASIN`` / ``[Enter ASIN]`` not visible anywhere, or real ASIN visible."""
        for fr in self._frames_ordered_post_continue():
            try:
                if fr.evaluate(_JS_POST_CONTINUE_ASIN_PLACEHOLDER_VISIBLE):
                    return False
            except Exception:
                continue
        for fr in self._frames_ordered_post_continue():
            try:
                if fr.evaluate(_JS_FRAME_CONTAINS_VISIBLE_TEXT, asin):
                    return True
            except Exception:
                continue
        return True

    def _run_post_continue_asin_editor(
        self,
        chip_frame: Frame,
        container: ElementHandle,
        asin: str,
        chip: ElementHandle,
    ) -> Optional[dict]:
        """
        Container-scoped ASIN chip editor.
        All input/save/verify operations are restricted to the
        'Suggested description' container — never touches the page search bar.
        """
        save_fail = self._post_continue_asin_save_failed_result

        _human_pause("before clicking ASIN chip", 500, 1000)

        # Prefer container-scoped JS click (most reliable for shadow DOM chips)
        js_clicked = False
        try:
            js_clicked = bool(chip_frame.evaluate(_JS_SCOPED_CLICK_ASIN_CHIP, container))
        except Exception:
            pass

        if js_clicked:
            _log("asin chip clicked")
        else:
            # Fallback 1: ElementHandle.click()
            try:
                chip.click(timeout=5_000)
                _log("asin chip clicked")
            except Exception:
                # Fallback 2: dispatch MouseEvent
                try:
                    chip_frame.evaluate(
                        "(el) => el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}))",
                        chip,
                    )
                    _log("asin chip clicked (dispatched)")
                except Exception:
                    _log("asin chip click failed — all methods exhausted")
                    return save_fail()

        _human_pause("after ASIN chip clicked", 1000, 2000)

        # ── DEBUG: ASIN chip post-click inspection ────────────────────────────
        try:
            _clicked_chip_html: str = chip_frame.evaluate(
                "(el) => el ? el.outerHTML.slice(0, 600) : 'null'", chip
            )
            _log(f"[ASIN-DEBUG] clicked chip outerHTML: {_clicked_chip_html}")
        except Exception as _e:
            _log(f"[ASIN-DEBUG] clicked chip outerHTML error: {_e}")

        try:
            _active_info: dict = chip_frame.evaluate("""() => {
                var ae = document.activeElement;
                if (!ae) return {tag:'none', cls:'', html:''};
                return {
                    tag: ae.tagName,
                    cls: ae.className,
                    html: ae.outerHTML ? ae.outerHTML.slice(0, 600) : ''
                };
            }""")
            _log(f"[ASIN-DEBUG] activeElement tag={_active_info.get('tag')} "
                 f"cls={_active_info.get('cls')!r} "
                 f"html={_active_info.get('html')}")
        except Exception as _e:
            _log(f"[ASIN-DEBUG] activeElement error: {_e}")

        try:
            _candidates: list = chip_frame.evaluate("""() => {
                var results = [];
                var keywords = ['regex', 'asin', 'input', 'save'];
                function scan(root) {
                    var els = root.querySelectorAll('*');
                    for (var i = 0; i < els.length; i++) {
                        var el = els[i];
                        var cls = (el.className || '').toString().toLowerCase();
                        var txt = (el.textContent || '').trim().toLowerCase().slice(0, 80);
                        var match = keywords.some(function(k) {
                            return cls.indexOf(k) !== -1 || txt.indexOf(k) !== -1;
                        });
                        if (match) {
                            results.push({
                                tag: el.tagName,
                                cls: (el.className || '').toString().slice(0, 120),
                                html: el.outerHTML ? el.outerHTML.slice(0, 300) : ''
                            });
                        }
                        if (el.shadowRoot) { scan(el.shadowRoot); }
                    }
                }
                scan(document);
                return results.slice(0, 30);
            }""")
            _log(f"[ASIN-DEBUG] candidate elements count: {len(_candidates)}")
            for _c in _candidates:
                _log(f"[ASIN-DEBUG] candidate tag={_c.get('tag')} "
                     f"cls={_c.get('cls')!r} html={_c.get('html')}")
        except Exception as _e:
            _log(f"[ASIN-DEBUG] candidate scan error: {_e}")

        _debug_ss_path = self._debug_screenshot("asin_chip_post_click")
        _log(f"[ASIN-DEBUG] screenshot path: {_debug_ss_path}")
        # ── END DEBUG ─────────────────────────────────────────────────────────

        # The ASIN placeholder lives inside the ProseMirror contenteditable editor.
        # We must click the placeholder span itself — NOT the end of the editor.
        _EDITOR_SEL      = "div.tiptap.ProseMirror[contenteditable='true']"
        _PLACEHOLDER_SEL = "span.placeholder-content"

        # Step 1: wait ~1 s for the editor to settle after the chip click
        _human_pause("after ASIN chip — wait for editor", 900, 1100)

        # Step 2: locate the editor
        editor = chip_frame.locator(_EDITOR_SEL).last
        try:
            editor.wait_for(state="visible", timeout=5_000)
            _log("asin editor found")
        except Exception as _e:
            _log(f"asin editor not found: {_e}")
            return save_fail()

        # Step 3: locate the [Enter ASIN] placeholder span inside the editor
        asin_placeholder = editor.locator(_PLACEHOLDER_SEL).filter(has_text="Enter ASIN").first
        try:
            asin_placeholder.wait_for(state="visible", timeout=3_000)
        except Exception as _e:
            _log(f"asin placeholder not found: {_e}")
            return save_fail()

        # Step 4: click the placeholder — this positions the cursor inside it
        try:
            asin_placeholder.click(timeout=3_000)
            _log("asin placeholder clicked")
        except Exception as _e:
            _log(f"asin placeholder click failed: {_e}")
            return save_fail()

        _human_pause("after placeholder click", 400, 600)

        # Step 5: type the ASIN with ~80 ms delay per character
        _log("typing asin")
        for ch in asin:
            self._page.keyboard.type(ch)
            time.sleep(0.08)

        _human_pause("after asin typed — before Save", 700, 1400)

        # Step 6: click Save near the ASIN chip/editor area
        saved = False

        # 6a. plain text button "Save" scoped inside the editor's parent container
        if not saved:
            try:
                _save_candidate = chip_frame.locator(
                    "button:has-text('Save'), [role='button']:has-text('Save')"
                ).filter(has_text="Save").first
                if _save_candidate.count() > 0:
                    _log("save candidate found: text button near editor")
                    _save_candidate.click(timeout=3_000)
                    saved = True
                    _log("save clicked")
            except Exception as _e:
                _log(f"save attempt 6a failed: {_e}")

        # 6b. kat-button containing "Save" anywhere in the frame
        if not saved:
            try:
                _kat_save = chip_frame.locator("kat-button").filter(has_text="Save").first
                if _kat_save.count() > 0:
                    _log("save candidate found: kat-button")
                    _kat_save.click(timeout=3_000)
                    saved = True
                    _log("save clicked")
            except Exception as _e:
                _log(f"save attempt 6b failed: {_e}")

        # 6c. Tab once then Enter — moves focus to Save button and activates it
        if not saved:
            try:
                _log("save candidate: Tab+Enter fallback")
                self._page.keyboard.press("Tab")
                _human_pause("after Tab", 300, 600)
                self._page.keyboard.press("Enter")
                saved = True
                _log("save clicked via Tab+Enter")
            except Exception as _e:
                _log(f"save attempt 6c failed: {_e}")

        # 6d. force-click Save via JS (shadow-piercing)
        if not saved:
            try:
                js_saved = chip_frame.evaluate("""() => {
                    function textOf(el) {
                        return (el.innerText || el.textContent || '').trim().toLowerCase();
                    }
                    function tryClick(root, depth) {
                        if (!root || depth < 0) return false;
                        var nodes = root.querySelectorAll('button, [role="button"], kat-button');
                        for (var i = 0; i < nodes.length; i++) {
                            if (textOf(nodes[i]) === 'save') {
                                nodes[i].click();
                                return true;
                            }
                        }
                        var all = root.querySelectorAll('*');
                        for (var j = 0; j < all.length; j++) {
                            if (all[j].shadowRoot && tryClick(all[j].shadowRoot, depth - 1)) return true;
                        }
                        return false;
                    }
                    return tryClick(document, 10);
                }""")
                if js_saved:
                    saved = True
                    _log("save candidate found: JS force-click")
                    _log("save clicked")
            except Exception as _e:
                _log(f"save attempt 6d failed: {_e}")

        if not saved:
            _log("save not clicked — all strategies exhausted")

        _human_pause("after Save — before verify", 700, 2200)

        # Step 7: verify [Enter ASIN] is gone and asin_value is visible
        try:
            placeholder_gone = chip_frame.evaluate("""() => {
                var els = document.querySelectorAll('span.placeholder-content');
                for (var i = 0; i < els.length; i++) {
                    if ((els[i].textContent || '').toLowerCase().indexOf('enter asin') !== -1) return false;
                }
                return true;
            }""")
        except Exception:
            placeholder_gone = True

        try:
            asin_visible = editor.locator(f"text={asin}").count() > 0
        except Exception:
            asin_visible = self._verify_asin_resolved_post_continue(asin)

        save_verify = placeholder_gone or asin_visible
        _log(f"save verify: {save_verify}")
        if not save_verify:
            return save_fail()
        return None

    def _locate_asin_candidate_in_frame(
        self, frame: Frame
    ) -> tuple[Optional[ElementHandle], str]:
        """
        Multi-strategy ASIN chip search in a single frame.
        Returns (ElementHandle_or_None, strategy_name).
        Tries Playwright visible-locator strategies first, then JS fallbacks.
        """
        # ── Locator-based strategies (visible DOM only) ──────────────────────
        locator_strategies: list[tuple[str, object]] = [
            ("get_by_text:Enter ASIN:exact",    lambda: frame.get_by_text("Enter ASIN",   exact=True).first),
            ("get_by_text:[Enter ASIN]:exact",  lambda: frame.get_by_text("[Enter ASIN]", exact=True).first),
            ("get_by_text:Enter ASIN:partial",  lambda: frame.get_by_text("Enter ASIN",   exact=False).first),
            ("get_by_text:ASIN:partial",        lambda: frame.get_by_text("ASIN",         exact=False).first),
            ("get_by_role:button:Enter ASIN",   lambda: frame.get_by_role("button", name="Enter ASIN").first),
            ("get_by_role:button:[Enter ASIN]", lambda: frame.get_by_role("button", name="[Enter ASIN]").first),
            ("css:kat-chip",                    lambda: frame.locator("kat-chip").first),
            ("css:kat-pill",                    lambda: frame.locator("kat-pill").first),
        ]
        for strategy_name, make_loc in locator_strategies:
            try:
                loc = make_loc()
                loc.wait_for(state="visible", timeout=350)
                el = loc.element_handle(timeout=1_000)
                if el:
                    return el, strategy_name
            except Exception:
                continue

        # ── JS-based strategies (shadow-DOM aware) ───────────────────────────
        for js_name, js_src in (
            ("js:find_chip_clickable", _JS_FIND_POST_CONTINUE_ASIN_CHIP_CLICKABLE),
            ("js:find_asin_broad",     _JS_FIND_ASIN_ELEMENT_BROAD),
        ):
            try:
                jh = frame.evaluate_handle(js_src)
                el = jh.as_element()
                if el is not None:
                    return el, js_name
            except Exception:
                continue

        return None, "none"

    def _post_continue_handle_asin_chip(self, asin_value: str) -> Optional[dict]:
        """
        After first Continue on intermediate_ui: Suggested description + ASIN chip.
        Fixed path only — never inspects hub issue cards.

        Search order:
          1. Find "Suggested description" container (shadow-aware, scoped)
          2. Find "Enter ASIN" chip inside that container
          3. Run container-scoped editor (no global page inputs)
        Retries up to 10 times across all frames.
        """
        _log("post-continue ASIN step detected")

        av = (asin_value or "").strip()
        if not av:
            return _result(
                ok=False,
                status="failed",
                amazon_case_id=None,
                step_failed="missing_asin",
                error="asin_value missing for post-continue ASIN step",
            )

        _human_pause("intermediate page settle", 1500, 2800)

        fr: Optional[Frame] = None
        container: Optional[ElementHandle] = None
        chip: Optional[ElementHandle] = None

        for attempt in range(1, 11):
            _log(f"post-continue ASIN search attempt {attempt}")
            for candidate_frame in self._frames_ordered_post_continue():
                # Step 1 — find the Suggested description container
                cont_el: Optional[ElementHandle] = None
                try:
                    jh = candidate_frame.evaluate_handle(
                        _JS_FIND_SUGGESTED_DESC_CONTAINER
                    )
                    cont_el = jh.as_element()
                except Exception:
                    pass

                if cont_el is None:
                    continue

                _log("suggested description container found")

                # Step 2 — find the ASIN chip inside the container
                chip_el: Optional[ElementHandle] = None
                try:
                    jh2 = candidate_frame.evaluate_handle(
                        _JS_SCOPED_FIND_ASIN_CHIP, cont_el
                    )
                    chip_el = jh2.as_element()
                except Exception:
                    pass

                if chip_el is not None:
                    fr = candidate_frame
                    container = cont_el
                    chip = chip_el
                    _log("asin chip found inside suggested description")
                    _log(f"ASIN candidate found by: scoped container search")
                    _log(f"ASIN candidate frame: {(candidate_frame.url or '')[:200]}")
                    break

            if chip is not None:
                break
            if attempt < 10:
                _human_pause(f"ASIN chip search retry {attempt}", 800, 1500)

        if fr is None or container is None or chip is None:
            _log("asin chip not found after all search attempts")
            return self._post_continue_asin_chip_not_found_result()

        return self._run_post_continue_asin_editor(fr, container, av, chip)

    def _verify_filled_values(
        self,
        frame: Frame,
        help_text: str,
        steps_text: str,
        reference_text: str,
    ) -> dict[str, bool]:
        """
        Read back values from visible text controls (shadow-aware) and require:
          * help non-empty when help_text is required
          * steps non-empty when steps_text is required (label-associated field)
          * ref present in some field when reference_text is required
        """
        raw = frame.evaluate(
            _JS_VERIFY_FORM_VALUES,
            [
                (help_text or "").strip(),
                (steps_text or "").strip(),
                (reference_text or "").strip(),
            ],
        )
        if not isinstance(raw, dict):
            return {"help": False, "steps": False, "ref": False}
        return {
            "help": bool(raw.get("helpOk")),
            "steps": bool(raw.get("stepsOk")),
            "ref": bool(raw.get("refOk")),
        }

    def _fill_steps_scan_all_with_labels(self, frame: Frame, steps_text: str) -> bool:
        """
        Try every visible textarea/input in the hub: match ancestor text containing
        'What steps have you taken already?', then set value via native setter + events.
        """
        try:
            r = frame.evaluate(_JS_FILL_STEPS_BY_LABEL_SCAN, steps_text)
        except Exception as e:
            _log(f"steps label-scan evaluate error — {e}")
            return False
        if not isinstance(r, dict):
            return False
        _log(f"steps candidate count: {int(r.get('count', 0))}")
        if r.get("matchedByLabel"):
            _log("steps matched by nearby label")
        _log(f"steps field final value length: {int(r.get('finalLen', 0))}")
        return bool(r.get("ok"))


    def _fill_steps_field(self, frame: Frame, steps_text: str) -> bool:
        """
        Dedicated locator-based filler for "What steps have you taken already?".

        The generic JS batch (_JS_FILL_FIELDS) sometimes misses this field because
        Amazon's label text varies or the ancestor-label walk scores it too low.
        This method tries several targeted Playwright-native strategies before
        falling back to a self-contained JS scan.

        Strategies (in order):
          1. get_by_label — regex patterns covering label text variants
          2. get_by_text(label text) → parent → first textarea/input
          3. locator("textarea").nth(1) — second visible textarea on the form
          4. Any visible textarea after index 0 that is currently empty
          5. Pure JS fallback — ancestor text scan + native setter + events

        Each found locator is passed through _complete_required_textarea
        (human-like typing + validation re-check).
        """
        # ── Strategy 1: get_by_label ─────────────────────────────────────────
        # Playwright's get_by_label queries aria-label, <label for=...>, and
        # aria-labelledby — the most semantically correct approach.
        label_patterns = (
            re.compile(r"what steps have you taken already", re.IGNORECASE),
            re.compile(r"what steps have you taken",         re.IGNORECASE),
            re.compile(r"steps (have you )?taken",           re.IGNORECASE),
            re.compile(r"steps already",                     re.IGNORECASE),
        )
        for pat in label_patterns:
            try:
                loc = frame.get_by_label(pat).first
                if loc.count() > 0 and loc.is_visible(timeout=600):
                    _log(f"  found steps field by label {pat.pattern!r}")
                    if self._complete_required_textarea(loc, steps_text, "steps"):
                        self._steps_field_locator = loc
                        actual_len = len(steps_text)
                        _log(f"  final verification passed (len={actual_len}).")
                        return True
            except Exception:
                pass

        # ── Strategy 2: get_by_text → parent → textarea/input ────────────────
        # Finds the visible label element, then walks up to the parent container
        # and looks for a textarea or input sibling inside it.
        label_texts = (
            "What steps have you taken already?",
            "What steps have you taken?",
            "Steps taken",
            "Steps",
        )
        for label_text in label_texts:
            try:
                label_loc = frame.get_by_text(label_text, exact=False)
                if label_loc.count() > 0:
                    _log(f"  found steps label text {label_text!r} — walking to textarea")
                    field_loc = (
                        label_loc.locator("..").locator("textarea, input").first
                    )
                    if field_loc.count() > 0 and field_loc.is_visible(timeout=500):
                        _log("  found steps field via label text → parent → textarea")
                        if self._complete_required_textarea(field_loc, steps_text, "steps"):
                            self._steps_field_locator = field_loc
                            _log(f"  final verification passed (len={len(steps_text)}).")
                            return True
            except Exception:
                pass

        # ── Strategy 2b: all visible candidates + nearby label "…taken already?" ─
        _log("  steps field: scanning all candidates for label 'What steps have you taken already'…")
        if self._fill_steps_scan_all_with_labels(frame, steps_text):
            v = self._verify_filled_values(frame, "", steps_text, "")
            if v.get("steps"):
                sl = self._locate_steps_textarea(frame)
                if sl is not None:
                    self._steps_field_locator = sl
                _log("  final verification passed after label scan (read-back OK).")
                return True

        # ── Strategy 3: textarea.nth(1) ───────────────────────────────────────
        # The help field is textarea[0]; the steps field is almost always [1].
        # NOTE: this is positional and fragile — only used when semantic
        # strategies above failed.
        try:
            loc = frame.locator("textarea").nth(1)
            if loc.is_visible(timeout=500):
                _log("  found steps field by textarea.nth(1)")
                if self._complete_required_textarea(loc, steps_text, "steps"):
                    self._steps_field_locator = loc
                    _log(f"  final verification passed (len={len(steps_text)}).")
                    return True
        except Exception:
            pass

        # ── Strategy 4: first empty visible textarea after index 0 ───────────
        # More defensive version of Strategy 3 — scans for empty textareas
        # to avoid accidentally overwriting the already-filled help field.
        try:
            count = frame.locator("textarea").count()
            for i in range(1, count):
                loc = frame.locator("textarea").nth(i)
                try:
                    if not loc.is_visible(timeout=300):
                        continue
                    current = loc.input_value(timeout=300)
                    if not current.strip():  # prefer genuinely empty field
                        _log(f"  found steps field by textarea.nth({i}) (first empty after help)")
                        if self._complete_required_textarea(loc, steps_text, "steps"):
                            self._steps_field_locator = loc
                            _log(f"  final verification passed (len={len(steps_text)}).")
                            return True
                        break  # tried; move to JS fallback
                except Exception:
                    continue
        except Exception:
            pass

        # ── Strategy 5: pure JS fallback ─────────────────────────────────────
        # Self-contained: walks the DOM for any textarea whose ancestor
        # contains "steps" or "taken" text, fills it, dispatches events.
        # Falls back to the second textarea if ancestor scan finds nothing.
        _log("  steps field: locators missed — trying JS ancestor-text fallback…")
        try:
            ok = frame.evaluate(
                """
                (stepsText) => {
                  function findStepsEl() {
                    var all = document.querySelectorAll('textarea, input:not([type="hidden"])');
                    for (var i = 0; i < all.length; i++) {
                      var n = all[i];
                      for (var j = 0; j < 6; j++) {
                        n = n && n.parentElement;
                        if (!n) break;
                        var txt = (n.innerText || n.textContent || '').toLowerCase();
                        if (txt.indexOf('steps') !== -1 || txt.indexOf('taken') !== -1) {
                          return all[i];
                        }
                      }
                    }
                    return all.length > 1 ? all[1] : null;
                  }
                  var el = findStepsEl();
                  if (!el) return false;
                  try { el.focus(); } catch(e) {}
                  var tag = (el.tagName || '').toLowerCase();
                  var proto = (tag === 'textarea')
                    ? window.HTMLTextAreaElement.prototype
                    : window.HTMLInputElement.prototype;
                  var desc = Object.getOwnPropertyDescriptor(proto, 'value');
                  if (desc && desc.set) { desc.set.call(el, stepsText); }
                  else { el.value = stepsText; }
                  ['input', 'change', 'blur'].forEach(function(t) {
                    try { el.dispatchEvent(new Event(t, { bubbles: true, cancelable: true })); }
                    catch(e) {}
                  });
                  return el.value.trim().length > 0;
                }
                """,
                steps_text,
            )
            if ok:
                v = self._verify_filled_values(frame, "", steps_text, "")
                if v.get("steps"):
                    sl = self._locate_steps_textarea(frame)
                    if sl is not None:
                        self._steps_field_locator = sl
                    _log(
                        f"  steps field filled via JS ancestor-text fallback "
                        f"(len={len(steps_text)}), read-back verified."
                    )
                    return True
        except Exception as e:
            _log(f"  steps JS fallback error — {e}")

        _log("  steps field: all strategies failed.")
        return False

    def fill_fields(
        self,
        help_text: str,
        steps_text: str = "",
        reference_text: str = "",
        timeout_sec: float = _FORM_APPEAR_TIMEOUT_SEC,
    ) -> dict:
        """
        Discover and fill up to three form fields.

        Help + steps (when required):
            Human-like completion via _complete_required_textarea (click, clear,
            .type() with delay, blur, Tab; JS value/events fallback if still invalid).
            Legacy _fill_steps_field is a last resort when no locator/handle is found.

        ASIN chip handling runs in ``_run_flow`` after the first Continue (``intermediate_ui``), not here.

        Reference:
            Deep-shadow JS batch (_JS_FILL_FIELDS) with help/steps empty so only
            the reference field is set.

        Retries until read-back verification passes or timeout_sec expires.
        Returns dict: { 'help': bool, 'steps': bool, 'ref': bool }.
        """
        _log("Step 5: filling form fields…")
        self._help_field_locator = None
        self._steps_field_locator = None
        frame = self._active_frame()
        deadline = time.monotonic() + timeout_sec
        results: dict = {"help": False, "steps": False, "ref": False}

        while time.monotonic() < deadline:
            # Required textareas: human-like interaction (not JS-only fill) so Amazon
            # validation state clears. Reference field: shadow-aware JS batch only.
            if help_text:
                _human_pause("before typing help text", 400, 900)
                h_loc = self._locate_help_textarea(frame)
                h_eh = self._element_handle_best_native(frame, "help") if not h_loc else None
                if h_loc:
                    ok_h = self._complete_required_textarea(h_loc, help_text, "help")
                    results["help"] = ok_h
                    if ok_h:
                        self._help_field_locator = h_loc
                elif h_eh:
                    ok_h = self._complete_required_element_handle(
                        frame, h_eh, help_text, "help"
                    )
                    results["help"] = ok_h
                else:
                    results["help"] = False
            else:
                results["help"] = True

            st_fill = (steps_text or "").strip()
            if not st_fill:
                results["steps"] = False
            else:
                _human_pause("before typing steps text", 400, 900)
                s_loc = self._locate_steps_textarea(frame)
                s_eh = self._element_handle_best_native(frame, "steps") if not s_loc else None
                if s_loc:
                    ok_s = self._complete_required_textarea(s_loc, st_fill, "steps")
                    results["steps"] = ok_s
                    if ok_s:
                        self._steps_field_locator = s_loc
                elif s_eh:
                    results["steps"] = self._complete_required_element_handle(
                        frame, s_eh, st_fill, "steps"
                    )
                else:
                    _log("Step 5: steps locator not found — trying legacy _fill_steps_field…")
                    results["steps"] = self._fill_steps_field(frame, st_fill)

            if reference_text:
                try:
                    batch = frame.evaluate(_JS_FILL_FIELDS, ["", "", reference_text])
                    if isinstance(batch, dict):
                        results["ref"] = bool(batch.get("ref"))
                    else:
                        results["ref"] = False
                except Exception as e:
                    _log(f"Step 5: reference-only JS batch error — {e}")
                    results["ref"] = False
            else:
                results["ref"] = True

            _log(f"Step 5 fill pass result: {results}")

            all_done = (
                (not help_text      or results.get("help"))  and
                results.get("steps") is True
                and (not reference_text or results.get("ref"))
            )
            if all_done:
                verified = self._verify_filled_values(
                    frame, help_text, steps_text, reference_text
                )
                if (
                    (not help_text or verified.get("help")) and
                    verified.get("steps")
                    and (not reference_text or verified.get("ref"))
                ):
                    _log(
                        f"Step 5 OK: filled + read-back verified — "
                        f"batch={results} verify={verified}"
                    )
                    return {
                        "help": verified["help"],
                        "steps": verified["steps"],
                        "ref": verified["ref"],
                    }
                _log(
                    f"Step 5: fill reported OK but read-back verification failed — "
                    f"batch={results} verify={verified}"
                )

            _log(f"Step 5: partial fill {results} — retrying…")
            time.sleep(_POLL_INTERVAL_SEC)

        _log(f"Step 5 WARN: timed out with partial fill — {results}")
        return results

    # ------------------------------------------------------------------
    # Step 6 — PDF upload
    # ------------------------------------------------------------------

    def upload_pdf(self, pdf_path: str) -> bool:
        """
        *** UPLOAD HANDLING ***
        Upload evidence PDF via <input type="file">.

        Strategy per frame (tried in order):
          1. evaluate_handle(_JS_FIND_FILE_INPUT) → JSHandle for the first
             <input type="file"> found anywhere in the deep shadow DOM.
             .as_element() → ElementHandle → .set_input_files(path).
             This handles shadow-DOM-hidden file inputs.
          2. Fallback: frame.locator('input[type="file"]') — light DOM only.
             NOTE: This locator does NOT pierce shadow roots. It is kept as a
             safety net for cases where Amazon moves the input to light DOM.

        Tries hub frame first, then every other page frame.
        """
        if not pdf_path or not os.path.isfile(pdf_path):
            _log(f"Step 6 SKIP: PDF not on disk — {pdf_path!r}")
            return False

        abs_path = os.path.abspath(pdf_path)
        _log(f"Step 6: uploading PDF — {abs_path!r}")

        def _try_in_frame(f: Frame) -> bool:
            # Primary: deep shadow DOM search via evaluate_handle
            try:
                handle = f.evaluate_handle(_JS_FIND_FILE_INPUT)
                el: Optional[ElementHandle] = handle.as_element()
                if el:
                    try:
                        f.evaluate(_JS_UNHIDE_INPUT, el)
                    except Exception:
                        pass
                    el.set_input_files(abs_path)
                    _log(f"Step 6 OK: uploaded via evaluate_handle in {f.url[:60]!r}.")
                    return True
            except Exception as e:
                _log(f"Step 6: evaluate_handle failed in {f.url[:60]!r} — {e}")

            # Fallback: light-DOM locator (does not pierce shadow DOM)
            try:
                loc = f.locator('input[type="file"]').first
                loc.set_input_files(abs_path, timeout=3_000)
                _log(f"Step 6 OK: uploaded via locator in {f.url[:60]!r}.")
                return True
            except Exception as e:
                _log(f"Step 6: locator upload failed in {f.url[:60]!r} — {e}")

            return False

        if _try_in_frame(self._active_frame()):
            return True
        for f in self._page.frames:
            if f is self._active_frame():
                continue
            if _try_in_frame(f):
                return True

        _log("Step 6 WARN: no file input found in any frame — upload skipped.")
        return False

    # ------------------------------------------------------------------
    # Step 7 — Click Continue
    # ------------------------------------------------------------------

    def _handle_trid_skip(self) -> tuple[bool, str, str, Optional[str]]:
        """
        Click Continue past the TRID page without filling any TRID value,
        then verify the page advanced.

        No TRID value is filled — if Continue alone does not move the flow
        forward, we stop with a clean failure (screenshot taken by caller).

        Logs: trid step detected → trid continue clicked
              → trid page advanced: True/False

        Returns (advanced, new_post_state, page_text, val_snip).
        advanced=False means the page did not leave the TRID step.
        """
        _log("trid step detected")
        _human_pause("before trid continue", 700, 1400)

        clicked = self.click_continue()
        _log("trid continue clicked" if clicked else "trid continue click failed")
        if not clicked:
            _log("trid page advanced: False")
            return False, "trid_step", "", None

        _human_pause("after trid continue", 900, 2000)

        new_state, new_text, new_snip = self.resolve_post_continue_state()
        advanced = new_state != "trid_step"
        _log(f"trid page advanced: {advanced}")
        return advanced, new_state, new_text, new_snip

    def click_continue(self, timeout_sec: float = _CONTINUE_TIMEOUT_SEC) -> bool:
        """
        Find and click the Continue / Submit button.

        Strategy A — Playwright role-based locator (fast path, light DOM):
            NOTE: get_by_role() does not pierce shadow DOM. It catches plain
            <button> elements but misses kat-button shadow internals.

        Strategy B — JS compound click (_JS_CLICK_CONTINUE):
            Prefers kat-button#meld-default-continue (most reliable Amazon ID),
            then walks all shadow roots for text-matched buttons,
            then falls back to XPath on visible plain buttons.

        Retries until timeout_sec.
        """
        _log("Step 7: clicking Continue/Submit…")
        frame = self._active_frame()
        deadline = time.monotonic() + timeout_sec

        while time.monotonic() < deadline:
            # Strategy A — Playwright locators (light DOM, fast path)
            for label in ("Continue", "Submit", "Send"):
                try:
                    loc = frame.get_by_role("button", name=label).first
                    if loc.is_visible(timeout=500):
                        loc.click(timeout=2_000)
                        _log(f"Step 7 OK: clicked via role=button name={label!r}.")
                        return True
                except Exception:
                    pass

            # Strategy B — JS deep scan + click (hub frame then main frame)
            for target_frame in (frame, self._page.main_frame):
                try:
                    ok = target_frame.evaluate(_JS_CLICK_CONTINUE)
                    if ok:
                        src = "hub frame" if target_frame is frame else "main frame"
                        _log(f"Step 7 OK: clicked via JS ({src}).")
                        return True
                except Exception as e:
                    _log(f"Step 7: JS error in {target_frame.url[:40]!r} — {e}")

            time.sleep(_POLL_INTERVAL_SEC)

        _log(f"Step 7 FAILED: Continue/Submit not clicked within {timeout_sec}s.")
        return False

    # ------------------------------------------------------------------
    # Steps 8–9 — Post-Continue state + confirmation / case ID scraping
    # ------------------------------------------------------------------

    @staticmethod
    def _blob_contains_any(blob_lower: str, markers: tuple[str, ...]) -> bool:
        return any(m in blob_lower for m in markers)

    def _classify_post_continue_state(self, blob_lower: str) -> str:
        """
        Single-state classification (priority order).
        Returns: confirmation | trid_step | same_form_validation | intermediate_ui | unknown
        """
        if self._blob_contains_any(blob_lower, _CONFIRMATION_MARKERS):
            return "confirmation"
        if self._blob_contains_any(blob_lower, _TRID_STEP_MARKERS):
            return "trid_step"
        if self._blob_contains_any(blob_lower, _SAME_FORM_VALIDATION_MARKERS) and (
            self._blob_contains_any(blob_lower, _FORM_CONTENT_MARKERS)
        ):
            return "same_form_validation"
        if self._blob_contains_any(blob_lower, _INTERMEDIATE_STEP_MARKERS):
            return "intermediate_ui"
        return "unknown"

    @staticmethod
    def _extract_validation_snippet(full_text: str, max_len: int = 350) -> str:
        low = full_text.lower()
        for marker in _SAME_FORM_VALIDATION_MARKERS:
            idx = low.find(marker)
            if idx != -1:
                chunk = full_text[idx : idx + max_len]
                return " ".join(chunk.split())
        return ""

    def _collect_frames_content_joined(self) -> str:
        parts: list[str] = []
        for f in self._page.frames:
            try:
                parts.append(f.content())
            except Exception:
                pass
        return " ".join(parts)

    def resolve_post_continue_state(
        self, timeout_sec: float = _CONFIRMATION_TIMEOUT_SEC
    ) -> tuple[str, str, Optional[str]]:
        """
        Step 8 — After Continue, poll until a definitive UI state or timeout.

        Returns (state, combined_frame_html, validation_snippet_or_none).
        state: confirmation | intermediate_ui | same_form_validation | unknown
        """
        _log(f"Step 8: post-Continue state detection (timeout {timeout_sec}s)…")
        deadline = time.monotonic() + timeout_sec
        last_text = ""
        last_class = "unknown"

        while time.monotonic() < deadline:
            last_text = self._collect_frames_content_joined()
            blob_l = last_text.lower()
            state = self._classify_post_continue_state(blob_l)
            last_class = state

            if state == "confirmation":
                _log("post-continue state: confirmation")
                return "confirmation", last_text, None
            if state == "trid_step":
                _log("post-continue state: trid_step")
                return "trid_step", last_text, None
            if state == "same_form_validation":
                _log("post-continue state: same_form_validation")
                snip = self._extract_validation_snippet(last_text)
                return "same_form_validation", last_text, snip or None
            if state == "intermediate_ui":
                _log("post-continue state: intermediate_ui (no follow-up handling)")
                return "intermediate_ui", last_text, None

            time.sleep(_POLL_INTERVAL_SEC)

        _log(f"post-continue state: unknown (last internal pass={last_class!r})")
        return "unknown", last_text, None

    @staticmethod
    def scrape_case_id(page_text: str) -> Optional[str]:
        """
        *** CASE ID SCRAPING ***
        Step 9 — Extract Amazon Case ID from confirmation page text.

        Regex matches "Case ID: 12345678901" and common variants.
        Amazon case IDs are typically 11 digits; pattern accepts 5–20
        to be resilient against future format changes.
        Returns the digit string, or None if not found.
        """
        m = _CASE_ID_RE.search(page_text)
        if m:
            return m.group(1)
        return None

    # ------------------------------------------------------------------
    # Public entrypoint
    # ------------------------------------------------------------------

    def submit_not_listed_claim(
        self,
        payload: dict,
        pdf_path: Optional[str] = None,
    ) -> dict:
        """
        Main public entrypoint for the 'My issue is not listed' case flow.

        Parameters
        ----------
        payload : dict
            Required for this flow:
              steps_text      — non-empty "What steps have you taken already?" text.
            Optional / derived:
              help_text       — "What do you need help with?" text (preferred).
              reference_text  — Reference numbers / order ID string.
              amazon_order_id — Used to build help_text when help_text is absent.
              claim_type      — Used alongside amazon_order_id for auto help_text.
              asin_value      — Required non-empty: post-Continue ASIN chip on intermediate page, fill, Save
                                (lower / active form frame only), before upload and Continue.
        pdf_path : str | None
            Path to evidence PDF to upload (optional).

        Returns
        -------
        dict:
            ok              : bool
            status          : "submitted" | "submitted_check_maybe"
                              | "mock_submit" | "failed" | "needs_flow_extension"
            amazon_case_id  : str | None
            step_failed     : str | None  — name of the step that blocked flow
            error           : str | None  — exception message if any
        """
        # Build field values from payload
        help_text = (payload.get("help_text") or "").strip()
        if not help_text:
            order_id   = (payload.get("amazon_order_id") or "").strip()
            claim_type = (payload.get("claim_type") or "").strip()
            if order_id:
                help_text = (
                    f"Filing a reimbursement claim for Order ID: {order_id}. "
                    f"Issue type: {claim_type}. "
                    "Please refer to the attached PDF evidence."
                )

        if not help_text:
            return _result(
                ok=False,
                status="failed",
                step_failed="build_payload",
                error="help_text is required, or supply amazon_order_id in payload",
            )

        steps_text = (payload.get("steps_text") or "").strip()
        if not steps_text:
            return _result(
                ok=False,
                status="failed",
                amazon_case_id=None,
                step_failed="missing_steps_text",
                error="steps_text is empty before form fill",
            )

        reference_text = (
            payload.get("reference_text")
            or payload.get("amazon_order_id")
            or ""
        ).strip()

        asin_value = (payload.get("asin_value") or "").strip()

        _log(
            f"submit_not_listed_claim: order_id={payload.get('amazon_order_id')!r} "
            f"help_len={len(help_text)} steps_len={len(steps_text)} "
            f"pdf={'yes' if pdf_path else 'no'}"
        )

        return self._run_flow(
            help_text=help_text,
            steps_text=steps_text,
            reference_text=reference_text,
            pdf_path=pdf_path,
            asin_value=asin_value,
        )

    # ------------------------------------------------------------------
    # Internal orchestration
    # ------------------------------------------------------------------

    def _run_flow(
        self,
        help_text: str,
        steps_text: str,
        reference_text: str,
        pdf_path: Optional[str],
        asin_value: str = "",
        navigate: bool = True,
    ) -> dict:
        """
        Execute all nine steps of the 'My issue is not listed' flow.

        Returns a canonical _result() dict.  Every early-exit path includes
        a step_failed label so callers can diagnose failures precisely.
        """
        _log("=== _run_flow START ===")
        fill_results: dict = {}
        self._help_hub_path = None

        try:
            if not (steps_text or "").strip():
                return _result(
                    ok=False,
                    status="failed",
                    amazon_case_id=None,
                    step_failed="missing_steps_text",
                    error="steps_text is empty before form fill",
                )

            # Step 1 — Navigate
            if navigate:
                self.navigate()

            # Step 2 — Locate hub iframe
            frame = self._wait_for_hub_frame()

            # Wait for shadow DOM to hydrate before attempting clicks
            # (locator-based, no hard sleep)
            self._wait_for_hub_content_ready()

            # Step 3 — Always "My issue is not listed" (never other hub tiles)
            hub_path_res = self._step_3_choose_help_hub_path(help_text)
            if not hub_path_res.get("ok"):
                return _result(
                    ok=False,
                    status="failed",
                    step_failed=hub_path_res.get("step_failed") or "click_issue_not_listed",
                    error=hub_path_res.get("error") or "Help Hub path selection failed",
                )

            # Step 4 — Wait for form (no extra sleep; method polls internally)
            if not self.wait_for_form():
                return _result(
                    ok=False, status="failed",
                    step_failed="wait_for_form",
                    error="form did not appear after clicking issueNotListedButton",
                )

            # Step 5 — Fill fields (read-back verification is inside fill_fields)
            fill_results = self.fill_fields(help_text, steps_text, reference_text)
            if not fill_results.get("steps"):
                return _result(
                    ok=False,
                    status="failed",
                    amazon_case_id=None,
                    step_failed="fill_steps",
                    error="Could not reliably fill 'What steps have you taken already?'",
                )
            if help_text and not fill_results.get("help"):
                return _result(
                    ok=False,
                    status="failed",
                    amazon_case_id=None,
                    step_failed="fill_help",
                    error="Could not reliably fill the help field",
                )
            if reference_text and not fill_results.get("ref"):
                return _result(
                    ok=False,
                    status="failed",
                    amazon_case_id=None,
                    step_failed="fill_reference",
                    error="Could not reliably fill the reference field",
                )

            # Step 6 — Upload PDF (non-fatal if missing or upload fails)
            if pdf_path:
                self.upload_pdf(pdf_path)
                _human_pause("after upload", 600, 1300)
            else:
                _log("Step 6 SKIP: no pdf_path provided.")

            if not self.mock_submit:
                pre_bad = self._pre_submit_validate_both_fields(
                    self._active_frame(), help_text, steps_text
                )
                if pre_bad:
                    sf, err = pre_bad
                    return _result(
                        ok=False,
                        status="failed",
                        amazon_case_id=None,
                        step_failed=sf,
                        error=err,
                    )
                self._debug_screenshot("pre_continue_form")

            # Mock-submit gate
            if self.mock_submit:
                _log("mock_submit=True — form ready, Submit skipped.")
                return _result(
                    ok=True,
                    status="mock_submit",
                    step_failed=None,
                    error=None,
                )

            # Step 7 — Click Continue
            _log("fixed path: my_issue_not_listed_only")
            _human_pause("before first Continue", 700, 1400)
            _log("first Continue: clicking")
            if not self.click_continue():
                return _result(
                    ok=False, status="failed",
                    step_failed="click_continue",
                    error="Continue/Submit button not found or not clicked",
                )
            _log("first Continue clicked")
            _human_pause("after first Continue", 900, 2000)

            # Step 8–9 — Classify post-Continue UI (confirmation vs intermediate vs errors)
            post_state, page_text, val_snip = self.resolve_post_continue_state()

            # TRID page after first Continue — click Continue without filling any value
            if post_state == "trid_step":
                advanced, post_state, page_text, val_snip = self._handle_trid_skip()
                if not advanced:
                    self._debug_screenshot("trid_skip_failed")
                    return _result(
                        ok=False, status="failed",
                        step_failed="trid_skip_failed",
                        error="TRID step did not advance after Continue",
                    )

            if post_state == "intermediate_ui":
                asin_err = self._post_continue_handle_asin_chip(asin_value)
                if asin_err is not None:
                    return asin_err
                _human_pause("before second Continue", 700, 1400)
                _log("second Continue: clicking")
                if not self.click_continue():
                    return _result(
                        ok=False,
                        status="failed",
                        amazon_case_id=None,
                        step_failed="click_continue",
                        error="Second Continue not clicked after post-continue ASIN step",
                    )
                _log("second Continue clicked")
                post_state, page_text, val_snip = self.resolve_post_continue_state()

                # TRID page after second Continue (post-ASIN) — click Continue without filling any value
                if post_state == "trid_step":
                    advanced, post_state, page_text, val_snip = self._handle_trid_skip()
                    if not advanced:
                        self._debug_screenshot("trid_skip_failed")
                        return _result(
                            ok=False, status="failed",
                            step_failed="trid_skip_failed",
                            error="TRID step did not advance after Continue",
                        )

                # After second Continue — scan for reimbursement-related choices
                # without relying on exact heading "Confirm your issue"
                time.sleep(2.0)

                _REIMBURSEMENT_CHOICES = [
                    "FBA Returns Reimbursement",
                    "Submit a reimbursement claim dispute",
                    "Inventory damaged in FBA warehouse",
                    "Inventory lost in FBA warehouse",
                ]

                def _collect_visible_texts(frame: Frame) -> list[str]:
                    """Return trimmed visible text for all button/card/clickable elements in frame."""
                    return frame.evaluate("""() => {
                        const results = [];
                        const selectors = [
                            'button', 'kat-button', '[role="button"]',
                            '[class*="card"]', '[class*="choice"]', '[class*="option"]',
                            '[class*="tile"]', '[class*="item"]',
                        ];
                        function walkShadow(root) {
                            for (const sel of selectors) {
                                for (const el of root.querySelectorAll(sel)) {
                                    try {
                                        const style = window.getComputedStyle(el);
                                        if (style.display === 'none' || style.visibility === 'hidden') continue;
                                        const rect = el.getBoundingClientRect();
                                        if (rect.width === 0 && rect.height === 0) continue;
                                        const txt = (el.innerText || el.textContent || '').trim();
                                        if (txt && !results.includes(txt)) results.push(txt);
                                    } catch(_) {}
                                }
                            }
                            for (const el of root.querySelectorAll('*')) {
                                if (el.shadowRoot) walkShadow(el.shadowRoot);
                            }
                        }
                        walkShadow(document);
                        return results;
                    }""")

                # Gather texts from active frame + all child frames
                _all_frames: list[Frame] = [self._active_frame()]
                try:
                    _all_frames += self._active_frame().child_frames
                except Exception:
                    pass

                _visible_texts: list[str] = []
                for _f in _all_frames:
                    try:
                        _visible_texts.extend(_collect_visible_texts(_f))
                    except Exception:
                        pass

                _log(f"after second Continue visible choices: {_visible_texts}")

                # Find first matching choice, preferring priority order
                _matched_choice: str | None = None
                for _pref in _REIMBURSEMENT_CHOICES:
                    for _vt in _visible_texts:
                        if _pref.lower() in _vt.lower():
                            _matched_choice = _pref
                            break
                    if _matched_choice:
                        break

                if _matched_choice is None:
                    self._debug_screenshot("post_second_continue_no_choice")
                    return _result(
                        ok=False,
                        status="failed",
                        amazon_case_id=None,
                        step_failed="post_second_continue_choice_not_found",
                        error="No visible reimbursement-related choice found after second Continue",
                    )

                # Click the matched choice in whichever frame it is visible
                _clicked_choice = False
                for _f in _all_frames:
                    try:
                        _loc = _f.locator(
                            f"button, kat-button, [role='button'], "
                            f"[class*='card'], [class*='choice'], [class*='option'], "
                            f"[class*='tile'], [class*='item']"
                        ).filter(has_text=_matched_choice).first
                        if _loc.is_visible(timeout=1_000):
                            _loc.click()
                            _clicked_choice = True
                            break
                    except Exception:
                        pass

                if not _clicked_choice:
                    # Fallback: plain text locator across active frame
                    try:
                        _ci_frame = self._active_frame()
                        _ci_frame.locator(f"text={_matched_choice}").first.click()
                        _clicked_choice = True
                    except Exception as _fb_exc:
                        _log(f"fallback click also failed: {_fb_exc}")

                _log(f"post-second-continue choice clicked: {_matched_choice}")

                time.sleep(1.0)

                if not self.click_continue():
                    return _result(
                        ok=False,
                        status="failed",
                        amazon_case_id=None,
                        step_failed="post_choice_continue_failed",
                        error="Continue not clicked after reimbursement choice selection",
                    )
                _log("post-choice continue clicked")

                post_state, page_text, val_snip = self.resolve_post_continue_state()

            if post_state == "confirmation":
                amazon_case_id = self.scrape_case_id(page_text)
                if amazon_case_id:
                    _log(f"Step 9 OK: Amazon Case ID = {amazon_case_id}")
                    _log("=== _run_flow COMPLETE ===")
                    return _result(ok=True, status="submitted", amazon_case_id=amazon_case_id)

                _log(
                    "Step 9 WARN: Case ID not found but confirmation markers were present "
                    "(uncertain outcome)."
                )
                _log("=== _run_flow COMPLETE (uncertain) ===")
                return _result(
                    ok=True,
                    status="submitted_check_maybe",
                    amazon_case_id=None,
                )

            if post_state == "same_form_validation":
                detail = (val_snip or "").strip() or "validation or error text visible"
                return _result(
                    ok=False,
                    status="failed",
                    amazon_case_id=None,
                    step_failed="same_form_validation",
                    error=f"Form still invalid after Continue: {detail}",
                )

            if post_state == "intermediate_ui":
                self._debug_screenshot("post_continue_stalled_intermediate_ui")
                return _result(
                    ok=False,
                    status="failed",
                    amazon_case_id=None,
                    step_failed="not_listed_flow_stalled",
                    error="My issue is not listed flow stalled after Continue",
                )

            if post_state == "unknown":
                self._debug_screenshot("post_continue_stalled_not_listed_flow")
                return _result(
                    ok=False,
                    status="failed",
                    amazon_case_id=None,
                    step_failed="not_listed_flow_stalled",
                    error="My issue is not listed flow stalled after Continue",
                )

            self._debug_screenshot("post_continue_unknown_state")
            return _result(
                ok=False,
                status="failed",
                amazon_case_id=None,
                step_failed="unknown_post_continue_state",
                error="Could not classify page after Continue",
            )

        except Exception as e:
            _log(f"_run_flow error: {type(e).__name__}: {e}")
            return _result(
                ok=False, status="failed",
                step_failed="exception",
                error=f"{type(e).__name__}: {e}",
            )


# ---------------------------------------------------------------------------
# Module-level convenience wrapper
# ---------------------------------------------------------------------------

def open_amazon_case(
    payload: dict,
    pdf_path: Optional[str] = None,
    cdp_endpoint: Optional[str] = None,
    mock_submit: bool = False,
) -> dict:
    """
    One-call convenience wrapper.

    Starts Playwright, runs the full 'My issue is not listed' flow, then stops.

    Example::

        result = open_amazon_case(
            payload={
                "help_text": "FBA unit missing — requesting reimbursement.",
                "steps_text": "Verified tracking delivered; inventory missing.",
                "reference_text": "114-1234567-1234567",
            },
            pdf_path=r"C:\\evidence\\report.pdf",
        )
        print(result["ok"], result["amazon_case_id"])
    """
    with PlaywrightCaseOpener(
        cdp_endpoint=cdp_endpoint,
        mock_submit=mock_submit,
    ) as opener:
        return opener.submit_not_listed_claim(payload=payload, pdf_path=pdf_path)


# ---------------------------------------------------------------------------
# __main__ usage
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    result = open_amazon_case(
        payload={
            "amazon_order_id": "114-1234567-1234567",
            "claim_type": "lost_inbound",
            "steps_text": (
                "1. Confirmed return tracking shows delivered to FBA.\n"
                "2. Verified the unit is missing from inventory.\n"
                "3. Waited 45 days — no automatic reconciliation."
            ),
        },
        pdf_path=r"C:\evidence\return_report.pdf",
    )
    print("Result:", result)
