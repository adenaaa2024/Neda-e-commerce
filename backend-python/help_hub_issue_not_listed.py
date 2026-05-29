"""
help_hub_issue_not_listed.py
============================
Production-grade Selenium automation for the Amazon Seller Central
Help Hub "My issue is not listed" flow.

Flow:
  1. Scan all iframes (recursive DFS) → switch into the one that owns the Hub UI.
  2. Click "My issue is not listed" (kat-button#issueNotListedButton) via
     shadow-DOM-aware strategies.
  3. Wait for the "What do you need help with?" form to appear.
  4. Fill all three textarea / input fields using native setter + full event
     dispatch so KAT/Meld React listeners actually fire.
  5. Upload evidence file(s) via real <input type="file">, even when hidden
     inside shadow DOM.
  6. Click Continue with layered fallbacks (normal → JS → synthetic events).
  7. Wait for page state change and confirm success.

Shadow DOM reality:
  - Amazon uses open shadow roots (kat-button, kat-input, kat-textarea, …).
  - Elements exist in the DOM but inner controls are inside shadowRoot.
  - All JS helpers walk every shadowRoot recursively up to MAX_SHADOW_DEPTH.
"""

from __future__ import annotations

import os
import time
from typing import Any, Optional

from selenium import webdriver
from selenium.common.exceptions import (
    NoSuchElementException,
    StaleElementReferenceException,
    TimeoutException,
    WebDriverException,
)
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.remote.webdriver import WebDriver
from selenium.webdriver.remote.webelement import WebElement
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------
DEFAULT_DEBUGGER_ADDRESS = "127.0.0.1:9222"
MAX_SHADOW_DEPTH      = 16
IFRAME_SCAN_TIMEOUT   = 30.0
NOT_LISTED_TIMEOUT    = 30.0
FORM_APPEAR_TIMEOUT   = 30.0
FIELD_SET_TIMEOUT     = 20.0
CONTINUE_TIMEOUT      = 20.0
POST_CLICK_WAIT       = 4.0
POLL_INTERVAL         = 0.35
RETRY_PAUSE           = 0.8

# Keywords that indicate a frame is likely the Help Hub UI.
_HUB_SRC_KEYWORDS = ("contact", "issue", "support", "help", "hub")

# Text markers inside the hub iframe's serialised DOM.
_HUB_CONTENT_MARKERS = (
    "issuenotlistedbutton",
    "my issue is not listed",
    "my issue isn't listed",
    "contact us",
    "browse-issue",
    "kat-button",
)

# Text markers for the "describe your issue" form page.
_FORM_CONTENT_MARKERS = (
    "what do you need help with",
    "what steps have you taken",
    "describe your issue",
    "tell us more",
    "additional information",
)

_LOG_PREFIX = "[hub-not-listed]"

# ---------------------------------------------------------------------------
# JavaScript helpers
# ---------------------------------------------------------------------------

# --- Deep shadow DOM: find first matching element ---
_JS_DEEP_QUERY_FIRST = r"""
(function() {
  var selector  = arguments[0];
  var startRoot = arguments[1] || document;
  var maxDepth  = arguments[2] != null ? arguments[2] : 16;

  function walk(root, depth) {
    if (!root || depth < 0) return null;
    var hit = null;
    try { hit = root.querySelector(selector); } catch(e) {}
    if (hit) return hit;
    var nodes;
    try { nodes = root.querySelectorAll('*'); } catch(e) { return null; }
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.shadowRoot) {
        var f = walk(n.shadowRoot, depth - 1);
        if (f) return f;
      }
    }
    return null;
  }
  return walk(startRoot, maxDepth);
})()
"""

# --- Deep shadow DOM: find ALL matching elements ---
_JS_DEEP_QUERY_ALL = r"""
(function() {
  var selector  = arguments[0];
  var startRoot = arguments[1] || document;
  var maxDepth  = arguments[2] != null ? arguments[2] : 16;
  var acc = [];

  function walk(root, depth) {
    if (!root || depth < 0) return;
    try { root.querySelectorAll(selector).forEach(function(el){ acc.push(el); }); }
    catch(e) {}
    var nodes;
    try { nodes = root.querySelectorAll('*'); } catch(e) { return; }
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) walk(nodes[i].shadowRoot, depth - 1);
    }
  }
  walk(startRoot, maxDepth);
  return acc;
})()
"""

# --- Scroll element to center of viewport (works inside iframes too) ---
_JS_SCROLL_CENTER = r"""
(function() {
  var el = arguments[0];
  if (!el) return;
  try {
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  } catch(e) {
    try { el.scrollIntoView(true); } catch(e2) {}
  }
})()
"""

# --- Find the inner <button> inside a kat-button shadow root ---
_JS_INNER_BUTTON_IN_KAT = r"""
(function() {
  var host = arguments[0];
  var maxDepth = arguments[1] != null ? arguments[1] : 12;
  if (!host) return null;

  function walk(root, depth) {
    if (!root || depth < 0) return null;
    var btn;
    try { btn = root.querySelector('button'); } catch(e) {}
    if (btn) return btn;
    var nodes;
    try { nodes = root.querySelectorAll('*'); } catch(e) { return null; }
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) {
        var f = walk(nodes[i].shadowRoot, depth - 1);
        if (f) return f;
      }
    }
    return null;
  }
  if (host.shadowRoot) {
    var x = walk(host.shadowRoot, maxDepth);
    if (x) return x;
  }
  return walk(host, maxDepth);
})()
"""

# --- Synthetic click event sequence ---
_JS_SYNTH_CLICK = r"""
(function() {
  var el = arguments[0];
  if (!el) return false;
  var r = el.getBoundingClientRect();
  var cx = r.left + r.width / 2;
  var cy = r.top + r.height / 2;
  var opts = { bubbles: true, cancelable: true, view: window,
               clientX: cx, clientY: cy };
  try { el.dispatchEvent(new PointerEvent('pointerover',  opts)); } catch(e) {}
  try { el.dispatchEvent(new PointerEvent('pointerenter', opts)); } catch(e) {}
  try { el.dispatchEvent(new PointerEvent('pointerdown',  opts)); } catch(e) {}
  try { el.dispatchEvent(new MouseEvent('mousedown',  opts)); } catch(e) {}
  try { el.dispatchEvent(new MouseEvent('mouseup',    opts)); } catch(e) {}
  try { el.dispatchEvent(new MouseEvent('click',      opts)); } catch(e) {}
  try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch(e) {}
  return true;
})()
"""

# --- Set value on input/textarea via native prototype setter + full event dispatch ---
_JS_SET_VALUE_EVENTS = r"""
(function() {
  var el  = arguments[0];
  var val = arguments[1];
  if (!el) return { ok: false, reason: 'no_element' };

  // Focus first
  try { el.focus(); } catch(e) {}

  // Use native setter to bypass React's synthetic-event deduplication
  var tag = (el.tagName || '').toLowerCase();
  var proto = (tag === 'textarea')
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  var desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) {
    desc.set.call(el, val);
  } else {
    el.value = val;
  }

  // Fire all expected events
  function ev(type, ctor) {
    try {
      el.dispatchEvent(new ctor(type, { bubbles: true, cancelable: true }));
    } catch(e) {}
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

# --- Read current value of an input/textarea ---
_JS_GET_VALUE = r"""
(function() {
  var el = arguments[0];
  if (!el) return '';
  try { return el.value || ''; } catch(e) { return ''; }
})()
"""

# --- Locate the deepest native <textarea> or <input> inside a kat-textarea / kat-input ---
_JS_INNER_FIELD_IN_KAT = r"""
(function() {
  var host = arguments[0];
  var maxDepth = arguments[1] != null ? arguments[1] : 12;
  if (!host) return null;

  function walk(root, depth) {
    if (!root || depth < 0) return null;
    // Prefer textarea, then visible input, then any input
    var ta;
    try { ta = root.querySelector('textarea'); } catch(e) {}
    if (ta) return ta;
    var inp;
    try { inp = root.querySelector('input:not([type="hidden"])'); } catch(e) {}
    if (inp) return inp;
    var nodes;
    try { nodes = root.querySelectorAll('*'); } catch(e) { return null; }
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) {
        var f = walk(nodes[i].shadowRoot, depth - 1);
        if (f) return f;
      }
    }
    return null;
  }
  if (host.shadowRoot) {
    var x = walk(host.shadowRoot, maxDepth);
    if (x) return x;
  }
  return walk(host, maxDepth);
})()
"""

# --- Find all <input type="file"> anywhere in deep shadow DOM ---
_JS_FILE_INPUTS_DEEP = r"""
(function() {
  var maxDepth = arguments[0] != null ? arguments[0] : 16;
  var acc = [];

  function walk(root, depth) {
    if (!root || depth < 0) return;
    try {
      root.querySelectorAll('input[type="file"]').forEach(function(el) { acc.push(el); });
    } catch(e) {}
    var nodes;
    try { nodes = root.querySelectorAll('*'); } catch(e) { return; }
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) walk(nodes[i].shadowRoot, depth - 1);
    }
  }
  walk(document, maxDepth);
  return acc;
})()
"""

# --- Make a hidden file input interactable ---
_JS_MAKE_FILE_INPUT_VISIBLE = r"""
(function() {
  var el = arguments[0];
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
})()
"""

# --- Find Continue button candidates across entire deep shadow tree ---
_JS_FIND_CONTINUE = r"""
(function() {
  var maxDepth = arguments[0] != null ? arguments[0] : 16;
  var results  = [];

  function textOf(el) {
    return ((el.innerText || el.textContent || '')).replace(/\s+/g, ' ').trim().toLowerCase();
  }
  function visible(el) {
    try {
      var st = window.getComputedStyle(el);
      if (!st || st.visibility === 'hidden' || st.display === 'none') return false;
      var r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    } catch(e) { return false; }
  }
  function walk(root, depth) {
    if (!root || depth < 0) return;
    try {
      var sels = root.querySelectorAll('kat-button, button, [role="button"]');
      sels.forEach(function(el) {
        var t = textOf(el);
        if (t.indexOf('continue') !== -1 || t === 'submit' || t === 'send') {
          var tag = (el.tagName || '').toLowerCase();
          results.push({ el: el, text: t, isKat: tag === 'kat-button',
                         vis: visible(el) });
        }
      });
    } catch(e) {}
    var nodes;
    try { nodes = root.querySelectorAll('*'); } catch(e) { return; }
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].shadowRoot) walk(nodes[i].shadowRoot, depth - 1);
    }
  }
  walk(document, maxDepth);
  return results;
})()
"""

# --- Score + pick best Continue candidate ---
_JS_PICK_CONTINUE = r"""
(function() {
  var cands = arguments[0] || [];
  var best = null, bestScore = -999;
  for (var i = 0; i < cands.length; i++) {
    var c = cands[i];
    if (!c || !c.el) continue;
    var sc = 0;
    var t = (c.text || '').toLowerCase();
    if (t === 'continue') sc += 100;
    else if (t.indexOf('continue') !== -1) sc += 70;
    else if (t === 'submit' || t === 'send') sc += 50;
    if (c.isKat) sc += 5;
    if (c.vis) sc += 10;
    if (sc > bestScore) { bestScore = sc; best = c.el; }
  }
  return best;
})()
"""

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def _log(msg: str) -> None:
    print(f"{_LOG_PREFIX} {msg}", flush=True)


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def build_driver(
    debugger_address: str = DEFAULT_DEBUGGER_ADDRESS,
    chromedriver_path: Optional[str] = None,
) -> WebDriver:
    """Attach to an existing Chrome instance via remote debugging port."""
    _log(f"Attaching Chrome at debugger_address={debugger_address!r}")
    opts = Options()
    opts.add_experimental_option("debuggerAddress", debugger_address)
    svc = Service(chromedriver_path) if chromedriver_path else Service()
    driver = webdriver.Chrome(service=svc, options=opts)
    driver.set_page_load_timeout(120)
    _log("Chrome attached successfully.")
    return driver


# ---------------------------------------------------------------------------
# JS execution helpers
# ---------------------------------------------------------------------------

def _js(driver: WebDriver, script: str, *args: Any) -> Any:
    return driver.execute_script(script, *args)


def deep_query(
    driver: WebDriver,
    selector: str,
    root: Optional[WebElement] = None,
    max_depth: int = MAX_SHADOW_DEPTH,
) -> Optional[WebElement]:
    """Find first element matching *selector* across all open shadow roots."""
    return _js(driver, _JS_DEEP_QUERY_FIRST, selector, root, max_depth)


def deep_query_all(
    driver: WebDriver,
    selector: str,
    root: Optional[WebElement] = None,
    max_depth: int = MAX_SHADOW_DEPTH,
) -> list[WebElement]:
    """Find ALL elements matching *selector* across all open shadow roots."""
    return _js(driver, _JS_DEEP_QUERY_ALL, selector, root, max_depth) or []


# ---------------------------------------------------------------------------
# Iframe navigation
# ---------------------------------------------------------------------------

def _page_source_lower(driver: WebDriver) -> str:
    try:
        return (driver.page_source or "").lower()
    except WebDriverException:
        return ""


def _frame_matches_src(frame: WebElement) -> bool:
    """Return True if the frame's id / name / src looks like a Hub frame."""
    try:
        attrs = " ".join(filter(None, [
            frame.get_attribute("id") or "",
            frame.get_attribute("name") or "",
            frame.get_attribute("src") or "",
        ])).lower()
        return any(kw in attrs for kw in _HUB_SRC_KEYWORDS)
    except WebDriverException:
        return False


def _frame_has_content(driver: WebDriver, markers: tuple[str, ...]) -> bool:
    ps = _page_source_lower(driver)
    return any(m in ps for m in markers)


def _dfs_find_frame(
    driver: WebDriver,
    markers: tuple[str, ...],
    path: list[str],
    depth: int = 0,
    max_depth: int = 8,
) -> bool:
    """
    Depth-first scan of nested iframes.
    Leaves *driver* switched into the matching frame and returns True.
    """
    if _frame_has_content(driver, markers):
        _log(f"Frame match at path {path!r} (content markers).")
        return True
    if depth >= max_depth:
        return False
    try:
        frames = driver.find_elements(By.CSS_SELECTOR, "iframe, frame")
    except WebDriverException:
        return False
    _log(f"Depth {depth}: {len(frames)} iframe(s) to scan.")
    for idx, fr in enumerate(frames):
        label = "<unknown>"
        try:
            label = (
                fr.get_attribute("id") or
                fr.get_attribute("name") or
                (fr.get_attribute("src") or "")[:60] or
                f"idx={idx}"
            )
        except WebDriverException:
            pass
        try:
            driver.switch_to.frame(fr)
        except (StaleElementReferenceException, NoSuchElementException, WebDriverException) as e:
            _log(f"Could not enter iframe {label!r}: {e}")
            continue
        new_path = path + [label]
        if _dfs_find_frame(driver, markers, new_path, depth + 1, max_depth):
            return True
        try:
            driver.switch_to.parent_frame()
        except WebDriverException:
            driver.switch_to.default_content()
    return False


def switch_to_deepest_relevant_iframe(
    driver: WebDriver,
    timeout: float = IFRAME_SCAN_TIMEOUT,
) -> str:
    """
    Scan all iframes recursively and switch into the one that owns the Help Hub UI.

    Strategy (in order):
      1. Check if default content already has the content.
      2. Prefer frames whose id/name/src match Hub keywords.
      3. Fall back to DFS content-marker scan (finds kat-button or hub text).

    Returns the iframe path label selected (for logging).
    Raises TimeoutException if nothing found within *timeout* seconds.
    """
    _log("Starting recursive iframe scan for Help Hub UI…")
    deadline = time.monotonic() + timeout
    last_exc: Optional[Exception] = None

    while time.monotonic() < deadline:
        try:
            # Always reset to clean state
            driver.switch_to.default_content()

            # 1. Check default content
            if _frame_has_content(driver, _HUB_CONTENT_MARKERS):
                _log("Help Hub UI found in default content.")
                return "default_content"

            # 2. Preferred: src/id/name keyword match (shallow pass first)
            try:
                frames = driver.find_elements(By.CSS_SELECTOR, "iframe, frame")
            except WebDriverException as e:
                last_exc = e
                time.sleep(POLL_INTERVAL)
                continue
            _log(f"Top-level frames: {len(frames)}")

            for fr in frames:
                if not _frame_matches_src(fr):
                    continue
                try:
                    label = (
                        fr.get_attribute("id") or
                        fr.get_attribute("name") or
                        (fr.get_attribute("src") or "")[:60]
                    )
                    driver.switch_to.frame(fr)
                    _log(f"Entered preferred iframe {label!r}; checking content…")
                    if _frame_has_content(driver, _HUB_CONTENT_MARKERS):
                        _log(f"Hub UI confirmed in preferred iframe {label!r}.")
                        return label
                    # Try nested inside this preferred frame
                    if _dfs_find_frame(driver, _HUB_CONTENT_MARKERS, [label], depth=1):
                        return label + "/nested"
                    driver.switch_to.default_content()
                except WebDriverException as e:
                    _log(f"Error checking preferred frame: {e}")
                    try:
                        driver.switch_to.default_content()
                    except WebDriverException:
                        pass

            # 3. Fallback: full DFS
            driver.switch_to.default_content()
            if _dfs_find_frame(driver, _HUB_CONTENT_MARKERS, [], depth=0):
                _log("Hub UI found via DFS fallback.")
                return "dfs_fallback"

        except WebDriverException as e:
            last_exc = e
            _log(f"Iframe scan error: {e}")
            try:
                driver.switch_to.default_content()
            except WebDriverException:
                pass

        time.sleep(POLL_INTERVAL)

    raise TimeoutException(
        f"Help Hub UI not found in any iframe within {timeout}s. Last error: {last_exc!r}"
    )


# ---------------------------------------------------------------------------
# "My issue is not listed" button
# ---------------------------------------------------------------------------

# Precise JS: ID-first, shadow-piercing inner button click
_JS_ISSUE_NOT_LISTED_CLICK = r"""
(function() {
  // Strategy 1: direct ID on kat-button host
  var host = document.querySelector('kat-button#issueNotListedButton');
  if (!host) {
    // Strategy 2: deep-scan all kat-buttons for matching text or id
    function walk(root, depth) {
      if (!root || depth < 0) return null;
      var kbs;
      try { kbs = root.querySelectorAll('kat-button, button, [role="button"]'); }
      catch(e) { kbs = []; }
      for (var i = 0; i < kbs.length; i++) {
        var b = kbs[i];
        var id = (b.id || '').toLowerCase();
        var txt = ((b.innerText || b.textContent || '')).trim().toLowerCase();
        if (id.indexOf('issuenotlisted') !== -1 ||
            txt.indexOf('my issue is not listed') !== -1 ||
            txt.indexOf("my issue isn't listed") !== -1) {
          return b;
        }
      }
      var nodes;
      try { nodes = root.querySelectorAll('*'); } catch(e) { return null; }
      for (var j = 0; j < nodes.length; j++) {
        if (nodes[j].shadowRoot) {
          var f = walk(nodes[j].shadowRoot, depth - 1);
          if (f) return f;
        }
      }
      return null;
    }
    host = walk(document, 16);
  }
  if (!host) return { ok: false, reason: 'host_not_found' };

  // Scroll host into view
  try { host.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch(e) {}

  // Try inner button inside shadow root first
  var tag = (host.tagName || '').toLowerCase();
  if (tag === 'kat-button' && host.shadowRoot) {
    var inner = host.shadowRoot.querySelector('button');
    if (inner) {
      try { inner.click(); return { ok: true, via: 'inner_shadow_button' }; } catch(e) {}
      try {
        inner.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return { ok: true, via: 'inner_shadow_synth' };
      } catch(e2) {}
    }
  }

  // Click the host itself
  try { host.click(); return { ok: true, via: 'host_click' }; } catch(e) {}

  // Synthetic event on host
  try {
    host.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return { ok: true, via: 'host_synth' };
  } catch(e) {}

  return { ok: false, reason: 'all_click_strategies_failed' };
})()
"""


def find_issue_not_listed_button(driver: WebDriver) -> Optional[WebElement]:
    """
    Find the 'My issue is not listed' kat-button (or plain button/role=button).
    Returns the element or None.
    """
    # 1. Direct ID on kat-button
    el = deep_query(driver, "kat-button#issueNotListedButton")
    if el:
        _log("Found issueNotListedButton by #id selector.")
        return el

    # 2. Any kat-button whose text matches
    candidates = deep_query_all(driver, "kat-button, button, [role='button']")
    for cand in candidates:
        try:
            txt = (
                _js(driver, "return (arguments[0].innerText || arguments[0].textContent || '').trim().toLowerCase();", cand)
                or ""
            )
            eid = (cand.get_attribute("id") or "").lower()
            if "my issue is not listed" in txt or "my issue isn't listed" in txt or "issuenotlisted" in eid:
                _log(f"Found issueNotListed button via text/id match: {txt!r} id={eid!r}")
                return cand
        except (StaleElementReferenceException, WebDriverException):
            continue

    _log("issueNotListedButton not found in current frame context.")
    return None


def _robust_click(driver: WebDriver, el: WebElement, label: str = "element") -> bool:
    """Click with three fallback strategies. Returns True on apparent success."""
    # Scroll into view first
    try:
        _js(driver, _JS_SCROLL_CENTER, el)
    except WebDriverException:
        pass

    # Strategy 1: native WebElement.click()
    try:
        el.click()
        _log(f"Clicked {label} via WebElement.click().")
        return True
    except WebDriverException as e:
        _log(f"WebElement.click() failed on {label}: {e}")

    # Strategy 2: JS .click()
    try:
        _js(driver, "arguments[0].click();", el)
        _log(f"Clicked {label} via JS .click().")
        return True
    except WebDriverException as e:
        _log(f"JS .click() failed on {label}: {e}")

    # Strategy 3: synthetic pointer + mouse events
    try:
        result = _js(driver, _JS_SYNTH_CLICK, el)
        if result:
            _log(f"Clicked {label} via synthetic pointer/mouse events.")
            return True
    except WebDriverException as e:
        _log(f"Synthetic click failed on {label}: {e}")

    return False


def click_issue_not_listed(driver: WebDriver, timeout: float = NOT_LISTED_TIMEOUT) -> None:
    """
    Wait for and click 'My issue is not listed' button.
    Tries JS compound strategy first, then element-level fallbacks.
    """
    _log("Attempting to click 'My issue is not listed'…")
    deadline = time.monotonic() + timeout
    last_exc: Optional[Exception] = None

    while time.monotonic() < deadline:
        # Scroll the iframe to the bottom so lazy footer elements render
        try:
            _js(driver, "try { window.scrollTo(0, document.body.scrollHeight); } catch(e) {}")
        except WebDriverException:
            pass

        # Strategy A: all-in-one JS compound click
        try:
            result = _js(driver, _JS_ISSUE_NOT_LISTED_CLICK)
            if isinstance(result, dict) and result.get("ok"):
                _log(f"issueNotListed clicked via JS compound: via={result.get('via')!r}")
                return
            elif isinstance(result, dict):
                _log(f"JS compound click: {result}")
        except WebDriverException as e:
            last_exc = e
            _log(f"JS compound error: {e}")

        # Strategy B: find element, then robust_click
        try:
            btn = find_issue_not_listed_button(driver)
            if btn:
                tag = (btn.tag_name or "").lower()
                if tag == "kat-button":
                    # Prefer inner button inside shadowRoot
                    inner = _js(driver, _JS_INNER_BUTTON_IN_KAT, btn)
                    if inner:
                        _log("Clicking inner <button> inside kat-button shadow root.")
                        if _robust_click(driver, inner, "inner-button"):
                            return
                if _robust_click(driver, btn, "issueNotListedButton"):
                    return
        except (StaleElementReferenceException, WebDriverException) as e:
            last_exc = e
            _log(f"Element-level click error: {e}")

        time.sleep(POLL_INTERVAL)

    raise TimeoutException(
        f"Could not click 'My issue is not listed' within {timeout}s. Last error: {last_exc!r}"
    )


# ---------------------------------------------------------------------------
# Wait for the form to appear
# ---------------------------------------------------------------------------

def _form_visible(driver: WebDriver) -> bool:
    ps = _page_source_lower(driver)
    return any(m in ps for m in _FORM_CONTENT_MARKERS)


def wait_for_form(driver: WebDriver, timeout: float = FORM_APPEAR_TIMEOUT) -> None:
    """
    Wait until the 'What do you need help with?' form fields appear.
    Also confirms via actual element presence.
    """
    _log("Waiting for help form to appear…")
    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline:
        if _form_visible(driver):
            # Double-check: actual textarea or kat-textarea
            ta = deep_query(driver, "kat-textarea, textarea, kat-input, input")
            if ta:
                _log("Form fields detected — form is ready.")
                return
        time.sleep(POLL_INTERVAL)

    raise TimeoutException(f"Form fields did not appear within {timeout}s")


# ---------------------------------------------------------------------------
# Form field discovery
# ---------------------------------------------------------------------------

_FIELD_HELP_KEYWORDS = (
    "what do you need help with",
    "help with",
    "describe your issue",
    "issue description",
    "message",
)
_FIELD_STEPS_KEYWORDS = (
    "what steps have you taken",
    "steps taken",
    "steps already taken",
    "steps you have taken",
)
_FIELD_REF_KEYWORDS = (
    "reference number",
    "reference numbers",
    "relevant reference",
    "order number",
    "case number",
    "optional",
)


def _score_field(driver: WebDriver, el: WebElement, keywords: tuple[str, ...]) -> float:
    """
    Score an input/textarea against keyword hints using its visible attributes.
    """
    score = 0.0
    try:
        attrs_raw = " ".join(filter(None, [
            el.get_attribute("placeholder") or "",
            el.get_attribute("aria-label") or "",
            el.get_attribute("name") or "",
            el.get_attribute("id") or "",
            el.get_attribute("label") or "",
        ])).lower()
    except (StaleElementReferenceException, WebDriverException):
        return -999.0

    for kw in keywords:
        if kw in attrs_raw:
            score += 20.0

    # Also check nearby label text via JS (walk up to 3 ancestors)
    try:
        label_text = _js(driver, r"""
(function() {
  var el = arguments[0];
  var n = el;
  for (var i = 0; i < 5; i++) {
    if (!n) break;
    n = n.parentElement;
    if (!n) break;
    var labels = n.querySelectorAll('label, kat-label, [class*="label"]');
    for (var j = 0; j < labels.length; j++) {
      var t = (labels[j].innerText || labels[j].textContent || '').trim().toLowerCase();
      if (t) return t;
    }
  }
  return '';
})()
""", el) or ""
        for kw in keywords:
            if kw in label_text:
                score += 30.0
    except WebDriverException:
        pass

    return score


def _collect_text_fields(driver: WebDriver) -> list[WebElement]:
    """Collect all textarea/input candidates from the current frame (deep shadow walk)."""
    fields: list[WebElement] = []
    for sel in ("kat-textarea", "kat-input", "textarea", "input:not([type='hidden'])"):
        fields.extend(deep_query_all(driver, sel))
    return fields


def _resolve_to_native(driver: WebDriver, el: WebElement) -> Optional[WebElement]:
    """
    If *el* is a kat-textarea or kat-input host, resolve to its inner native
    <textarea>/<input>. Otherwise return *el* unchanged.
    """
    try:
        tag = (el.tag_name or "").lower()
    except WebDriverException:
        return None
    if tag in ("kat-textarea", "kat-input"):
        inner = _js(driver, _JS_INNER_FIELD_IN_KAT, el)
        if inner:
            return inner
    return el


def find_form_fields(
    driver: WebDriver,
) -> tuple[Optional[WebElement], Optional[WebElement], Optional[WebElement]]:
    """
    Discover (help_field, steps_field, reference_field) via semantic scoring.
    Each is the NATIVE <textarea> or <input> (not the kat-* host).
    Returns None for any field that cannot be found.
    """
    _log("Discovering form fields semantically…")
    all_fields = _collect_text_fields(driver)
    _log(f"Total field candidates found: {len(all_fields)}")

    def best_match(keywords: tuple[str, ...]) -> Optional[WebElement]:
        scored: list[tuple[float, WebElement]] = []
        for el in all_fields:
            sc = _score_field(driver, el, keywords)
            if sc > 0:
                native = _resolve_to_native(driver, el)
                if native:
                    scored.append((sc, native))
        if not scored:
            return None
        scored.sort(key=lambda x: -x[0])
        best = scored[0]
        _log(f"Field match: score={best[0]:.1f} for keywords={keywords[0]!r}")
        return best[1]

    help_field = best_match(_FIELD_HELP_KEYWORDS)
    steps_field = best_match(_FIELD_STEPS_KEYWORDS)
    ref_field   = best_match(_FIELD_REF_KEYWORDS)

    # Last-resort positional assignment if semantic scoring found nothing
    native_fields: list[WebElement] = []
    for el in all_fields:
        native = _resolve_to_native(driver, el)
        if native and native not in native_fields:
            native_fields.append(native)

    if help_field is None and len(native_fields) >= 1:
        help_field = native_fields[0]
        _log("Help field assigned by position (first native field).")
    if steps_field is None and len(native_fields) >= 2:
        steps_field = native_fields[1]
        _log("Steps field assigned by position (second native field).")
    if ref_field is None and len(native_fields) >= 3:
        ref_field = native_fields[2]
        _log("Reference field assigned by position (third native field).")

    _log(
        f"Fields resolved — help: {'yes' if help_field else 'no'}, "
        f"steps: {'yes' if steps_field else 'no'}, "
        f"ref: {'yes' if ref_field else 'no'}"
    )
    return help_field, steps_field, ref_field


# ---------------------------------------------------------------------------
# Setting field values
# ---------------------------------------------------------------------------

def set_input_value(
    driver: WebDriver,
    element: WebElement,
    value: str,
    attempts: int = 4,
) -> bool:
    """
    Robustly set *value* on *element* (native input or textarea).

    Attempt order per retry:
      1. Native prototype setter + full event dispatch (JS).
      2. send_keys fallback (clears first).

    Returns True when value is verified.
    """
    value = str(value)
    for attempt in range(1, attempts + 1):
        _log(f"set_input_value attempt {attempt}/{attempts}…")

        # Method 1: native setter + events
        try:
            result = _js(driver, _JS_SET_VALUE_EVENTS, element, value)
            if isinstance(result, dict) and result.get("ok"):
                actual = (_js(driver, _JS_GET_VALUE, element) or "").strip()
                if actual == value.strip():
                    _log(f"Value set and verified via native setter (len={len(value)}).")
                    return True
                _log(f"Native setter: value mismatch actual={actual[:40]!r}")
        except WebDriverException as e:
            _log(f"Native setter JS error: {e}")

        # Method 2: send_keys
        try:
            try:
                element.clear()
            except WebDriverException:
                pass
            element.send_keys(value)
            actual = (_js(driver, _JS_GET_VALUE, element) or "").strip()
            if actual == value.strip():
                _log("Value set and verified via send_keys.")
                return True
            _log(f"send_keys mismatch actual={actual[:40]!r}")
        except WebDriverException as e:
            _log(f"send_keys error: {e}")

        time.sleep(RETRY_PAUSE)

    _log(f"WARNING: Could not reliably set value after {attempts} attempts.")
    return False


def fill_form(
    driver: WebDriver,
    help_text: str,
    steps_text: str,
    reference_text: str,
    timeout: float = FIELD_SET_TIMEOUT,
) -> None:
    """
    Discover and fill the three form fields.
    Retries discovery + setting within *timeout* seconds.
    """
    _log("Filling form fields…")
    deadline = time.monotonic() + timeout
    success = {"help": False, "steps": False, "ref": False}

    while time.monotonic() < deadline:
        help_f, steps_f, ref_f = find_form_fields(driver)

        if help_text and help_f and not success["help"]:
            ok = set_input_value(driver, help_f, help_text)
            success["help"] = ok
            if not ok:
                _log("WARNING: help field value may not have been set.")

        if steps_text and steps_f and not success["steps"]:
            ok = set_input_value(driver, steps_f, steps_text)
            success["steps"] = ok
            if not ok:
                _log("WARNING: steps field value may not have been set.")

        if reference_text and ref_f and not success["ref"]:
            ok = set_input_value(driver, ref_f, reference_text)
            success["ref"] = ok
            if not ok:
                _log("WARNING: reference field value may not have been set.")

        all_done = (
            (not help_text or success["help"]) and
            (not steps_text or success["steps"]) and
            (not reference_text or success["ref"])
        )
        if all_done:
            _log("All form fields filled successfully.")
            return

        time.sleep(POLL_INTERVAL)

    # Report partial success — do not hard-fail; let caller decide
    _log(
        f"fill_form partial: help={success['help']}, "
        f"steps={success['steps']}, ref={success['ref']}"
    )


# ---------------------------------------------------------------------------
# File upload
# ---------------------------------------------------------------------------

def upload_files(driver: WebDriver, file_paths: list[str]) -> bool:
    """
    Find real <input type="file"> (even hidden, even inside shadow DOM)
    and send each file path.  Unhides the input if necessary.

    Returns True if upload input was found and paths were sent.
    """
    if not file_paths:
        _log("No file paths provided; skipping upload.")
        return True

    _log(f"Scanning for file input (deep shadow walk)… files={file_paths}")
    inputs: list[WebElement] = _js(driver, _JS_FILE_INPUTS_DEEP, MAX_SHADOW_DEPTH) or []
    _log(f"Found {len(inputs)} <input type='file'> element(s).")

    if not inputs:
        _log("ERROR: No file input found — upload skipped.")
        return False

    file_input = inputs[0]

    # Unhide if needed (Selenium send_keys works even on display:none in Chrome)
    try:
        _js(driver, _JS_MAKE_FILE_INPUT_VISIBLE, file_input)
    except WebDriverException as e:
        _log(f"Could not unhide file input (non-fatal): {e}")

    for path in file_paths:
        abs_path = os.path.abspath(path)
        if not os.path.isfile(abs_path):
            _log(f"WARNING: file not found at {abs_path!r} — skipping.")
            continue
        try:
            file_input.send_keys(abs_path)
            _log(f"File sent to input: {abs_path!r}")
        except WebDriverException as e:
            _log(f"send_keys for file failed: {e}")
            return False

    _log("File upload completed.")
    return True


# ---------------------------------------------------------------------------
# Click Continue
# ---------------------------------------------------------------------------

def click_continue(driver: WebDriver, timeout: float = CONTINUE_TIMEOUT) -> None:
    """
    Find and click the Continue button (kat-button / button / role=button).
    Prefers inner shadow button for kat-button hosts.
    Uses three click strategies with fallback.
    """
    _log("Searching for Continue button…")
    deadline = time.monotonic() + timeout
    last_exc: Optional[Exception] = None

    while time.monotonic() < deadline:
        try:
            # Gather all Continue candidates across deep shadow DOM
            cands = _js(driver, _JS_FIND_CONTINUE, MAX_SHADOW_DEPTH) or []
            _log(f"Continue candidates: {len(cands)}")

            target = _js(driver, _JS_PICK_CONTINUE, cands)
            if target:
                tag = (target.tag_name or "").lower()
                _log(f"Selected Continue target: tag={tag!r}")

                if tag == "kat-button":
                    inner = _js(driver, _JS_INNER_BUTTON_IN_KAT, target)
                    if inner:
                        _log("Using inner <button> inside kat-button shadow root.")
                        target = inner

                if _robust_click(driver, target, "Continue"):
                    _log("Continue button clicked successfully.")
                    return
        except (StaleElementReferenceException, WebDriverException) as e:
            last_exc = e
            _log(f"Continue click error: {e}")

        time.sleep(POLL_INTERVAL)

    raise TimeoutException(
        f"Could not find/click Continue within {timeout}s. Last error: {last_exc!r}"
    )


def _wait_post_continue(driver: WebDriver, wait_sec: float = POST_CLICK_WAIT) -> tuple[bool, str]:
    """Brief pause then heuristic check that state changed after Continue click."""
    time.sleep(wait_sec)
    try:
        url = driver.current_url
    except WebDriverException:
        url = "<unknown>"
    # Look for error indicators
    errors = deep_query_all(driver, ".error, [class*='error'], kat-alert", max_depth=8)
    if errors:
        return False, f"Error UI detected after Continue; url={url!r}"
    # If the help-text form is gone → good
    if not _form_visible(driver):
        return True, f"Form no longer visible after Continue; url={url!r}"
    return True, f"Post-click wait complete; url={url!r}"


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def submit_not_listed_issue(
    driver: WebDriver,
    help_text: str,
    steps_text: str,
    reference_text: str,
    file_paths: Optional[list[str]] = None,
    *,
    iframe_timeout: float = IFRAME_SCAN_TIMEOUT,
    not_listed_timeout: float = NOT_LISTED_TIMEOUT,
    form_appear_timeout: float = FORM_APPEAR_TIMEOUT,
    field_set_timeout: float = FIELD_SET_TIMEOUT,
    continue_timeout: float = CONTINUE_TIMEOUT,
) -> None:
    """
    Execute the complete 'My issue is not listed' flow:
      1. Scan iframes and switch into the correct one.
      2. Click 'My issue is not listed'.
      3. Wait for form.
      4. Fill form fields.
      5. Upload file(s).
      6. Click Continue.
      7. Confirm state change.
    """
    file_paths = file_paths or []

    _log("=== submit_not_listed_issue: START ===")

    # 1. Switch to hub iframe
    frame_label = switch_to_deepest_relevant_iframe(driver, timeout=iframe_timeout)
    _log(f"Active iframe path: {frame_label!r}")

    # 2. Click "My issue is not listed"
    click_issue_not_listed(driver, timeout=not_listed_timeout)
    _log("'My issue is not listed' clicked; waiting for form…")
    time.sleep(0.8)

    # 3. Wait for form — may need to re-scan iframes (form might open in new frame context)
    try:
        wait_for_form(driver, timeout=form_appear_timeout)
    except TimeoutException:
        _log("Form not found in current iframe; re-scanning iframes…")
        switch_to_deepest_relevant_iframe(driver, timeout=iframe_timeout)
        wait_for_form(driver, timeout=form_appear_timeout)

    # 4. Fill fields
    fill_form(driver, help_text, steps_text, reference_text, timeout=field_set_timeout)

    # 5. Upload files
    if file_paths:
        ok = upload_files(driver, file_paths)
        if not ok:
            _log("WARNING: File upload failed — continuing without attachment.")
        time.sleep(0.5)

    # 6. Click Continue
    click_continue(driver, timeout=continue_timeout)

    # 7. Confirm
    ok, msg = _wait_post_continue(driver)
    _log(f"Post-Continue: ok={ok} — {msg}")
    if not ok:
        raise RuntimeError(f"Form submission may have failed: {msg}")

    _log("=== submit_not_listed_issue: COMPLETE ===")


def safe_submit_not_listed_issue(
    driver: WebDriver,
    help_text: str,
    steps_text: str,
    reference_text: str,
    file_paths: Optional[list[str]] = None,
    retries: int = 3,
    **kwargs: Any,
) -> None:
    """
    Retry wrapper around submit_not_listed_issue.
    On each failure, resets driver to default content before retrying.
    """
    file_paths = file_paths or []
    last: Optional[Exception] = None

    for attempt in range(1, retries + 1):
        _log(f"safe_submit attempt {attempt}/{retries}")
        try:
            submit_not_listed_issue(
                driver,
                help_text,
                steps_text,
                reference_text,
                file_paths,
                **kwargs,
            )
            _log(f"safe_submit succeeded on attempt {attempt}.")
            return
        except Exception as exc:
            last = exc
            _log(f"Attempt {attempt} failed: {type(exc).__name__}: {exc}")
            try:
                driver.switch_to.default_content()
            except WebDriverException:
                pass
            if attempt < retries:
                pause = RETRY_PAUSE * (attempt + 1)
                _log(f"Waiting {pause:.1f}s before retry…")
                time.sleep(pause)

    assert last is not None
    raise last


# ---------------------------------------------------------------------------
# __main__ usage example
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    driver = build_driver("127.0.0.1:9222")

    help_text = (
        "I have a lost FBA shipment that was returned by the customer but never "
        "restocked. The unit is missing from my inventory and I need reimbursement."
    )
    steps_text = (
        "1. Confirmed the return tracking shows delivered to FBA.\n"
        "2. Checked my inventory — unit is not present.\n"
        "3. Waited 45 days for automatic reconciliation — no reimbursement issued."
    )
    reference_text = "Order: 114-1234567-1234567 / Shipment: FBA15XXXXXXX"
    file_paths = [r"C:\evidence\return_report.pdf"]

    safe_submit_not_listed_issue(
        driver,
        help_text,
        steps_text,
        reference_text,
        file_paths,
        retries=3,
    )
