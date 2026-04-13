"""
Amazon Seller Central Help Hub — FBA Returns Reimbursement (KAT / Meld open shadow DOM).

Attach to an existing Chrome via remote debugging; scan iframes; traverse shadow roots;
fill Order ID with native setter + events; click Continue with fallbacks.
"""

from __future__ import annotations

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

# --- Tunable timeouts (seconds) ---
DEFAULT_DEBUGGER_ADDRESS = "127.0.0.1:9222"
IFRAME_SCAN_TIMEOUT = 25.0
SHADOW_STABLE_TIMEOUT = 20.0
FIELD_READY_TIMEOUT = 25.0
BUTTON_READY_TIMEOUT = 20.0
POST_CLICK_WAIT = 3.0
POLL_INTERVAL = 0.35
RETRY_PAUSE = 0.6

# Semantic hints for Order ID field (lowercased for matching)
ORDER_ID_KEYWORDS = (
    "order",
    "order id",
    "order-id",
    "orderid",
    "amazon order",
    "merchant order",
    "order number",
)

# --- Multiline JavaScript: deep shadow tree utilities ---

JS_DEEP_QUERY_FIRST = r"""
function __deepQueryFirst(root, selector, maxDepth) {
  if (!root || maxDepth < 0) return null;
  try {
    const direct = root.querySelector(selector);
    if (direct) return direct;
  } catch (e) { return null; }
  let all;
  try { all = root.querySelectorAll('*'); } catch (e) { return null; }
  for (let i = 0; i < all.length; i++) {
    const node = all[i];
    if (node.shadowRoot) {
      const found = __deepQueryFirst(node.shadowRoot, selector, maxDepth - 1);
      if (found) return found;
    }
  }
  return null;
}
return __deepQueryFirst(arguments[0] || document, arguments[1], arguments[2]);
"""

JS_DEEP_QUERY_ALL = r"""
function __deepQueryAll(root, selector, maxDepth, acc) {
  if (!root || maxDepth < 0) return;
  try {
    root.querySelectorAll(selector).forEach(function(el) { acc.push(el); });
  } catch (e) {}
  let all;
  try { all = root.querySelectorAll('*'); } catch (e) { return; }
  for (let i = 0; i < all.length; i++) {
    const node = all[i];
    if (node.shadowRoot) __deepQueryAll(node.shadowRoot, selector, maxDepth - 1, acc);
  }
}
var acc = [];
__deepQueryAll(arguments[0] || document, arguments[1], arguments[2], acc);
return acc;
"""

JS_FIND_INNER_INPUT_IN_KAT_INPUT = r"""
var host = arguments[0];
var maxDepth = arguments[1] || 12;
function firstInput(root, depth) {
  if (!root || depth < 0) return null;
  try {
    const inp = root.querySelector('input:not([type="hidden"])');
    if (inp && inp.offsetParent !== null) return inp;
    const any = root.querySelector('input:not([type="hidden"])');
    if (any) return any;
  } catch (e) {}
  let nodes;
  try { nodes = root.querySelectorAll('*'); } catch (e) { return null; }
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.shadowRoot) {
      const f = firstInput(n.shadowRoot, depth - 1);
      if (f) return f;
    }
  }
  return null;
}
if (!host) return null;
if (host.shadowRoot) {
  const x = firstInput(host.shadowRoot, maxDepth);
  if (x) return x;
}
return firstInput(host, maxDepth);
"""

JS_SCORE_ORDER_FIELD_CANDIDATE = r"""
var el = arguments[0];
if (!el || el.tagName !== 'INPUT') return -1000;
var s = '';
function lc(x) { return (x || '').toString().toLowerCase(); }
s += lc(el.getAttribute('placeholder')) + ' ';
s += lc(el.getAttribute('aria-label')) + ' ';
s += lc(el.getAttribute('name')) + ' ';
s += lc(el.id) + ' ';
var keywords = arguments[1] || [];
var score = 0;
for (var i = 0; i < keywords.length; i++) {
  var kw = keywords[i];
  if (s.indexOf(kw) !== -1) score += 10;
}
if (s.indexOf('order') !== -1) score += 5;
var t = lc(el.type);
if (t === 'text' || t === 'search' || t === '') score += 2;
if (el.disabled) score -= 50;
var st = window.getComputedStyle(el);
if (st && st.visibility === 'hidden') score -= 30;
if (st && st.display === 'none') score -= 40;
return score;
"""

JS_SET_INPUT_VALUE_AND_EVENTS = r"""
var el = arguments[0];
var value = arguments[1];
if (!el) return { ok: false, reason: 'no element' };
try { el.focus(); } catch (e) {}
var desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
if (desc && desc.set) desc.set.call(el, value);
else el.value = value;
function ev(type) {
  try {
    el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  } catch (e) {}
}
ev('keydown');
ev('keyup');
ev('input');
ev('change');
try { el.blur(); } catch (e) {}
return { ok: true, value: el.value };
"""

JS_GET_INPUT_VALUE = r"""
var el = arguments[0];
if (!el) return '';
try { return el.value || ''; } catch (e) { return ''; }
"""

JS_FIND_CONTINUE_TARGETS = r"""
var root = arguments[0] || document;
var maxDepth = arguments[1] || 14;
var out = [];
function visible(el) {
  if (!el) return false;
  var st = window.getComputedStyle(el);
  if (!st || st.visibility === 'hidden' || st.display === 'none') return false;
  var r = el.getBoundingClientRect();
  return r.width > 2 && r.height > 2;
}
function textOf(el) {
  if (!el) return '';
  var t = (el.innerText || el.textContent || '').trim();
  return t.toLowerCase();
}
function walk(r, depth) {
  if (!r || depth < 0) return;
  try {
    var buttons = r.querySelectorAll('button, [role="button"], kat-button');
    buttons.forEach(function(b) {
      var tag = (b.tagName || '').toLowerCase();
      var txt = textOf(b);
      if (txt.indexOf('continue') !== -1) {
        out.push({ el: b, depth: maxDepth - depth, isKat: tag === 'kat-button', text: txt });
      }
    });
  } catch (e) {}
  var nodes;
  try { nodes = r.querySelectorAll('*'); } catch (e) { return; }
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (n.shadowRoot) walk(n.shadowRoot, depth - 1);
  }
}
walk(root, maxDepth);
return out;
"""

JS_PICK_BEST_CONTINUE = r"""
var candidates = arguments[0] || [];
var best = null;
var bestScore = -1;
function score(txt) {
  txt = (txt || '').toLowerCase();
  if (txt === 'continue') return 100;
  if (txt.indexOf('continue') !== -1) return 80;
  return 0;
}
for (var i = 0; i < candidates.length; i++) {
  var c = candidates[i];
  var el = c.el;
  if (!el) continue;
  var st = window.getComputedStyle(el);
  if (st && st.visibility === 'hidden') continue;
  var r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) continue;
  var sc = score(c.text);
  if (sc < 1) continue;
  if (c.isKat) sc += 5;
  sc -= c.depth * 0.5;
  if (sc > bestScore) { bestScore = sc; best = el; }
}
return best;
"""

JS_FIND_DEEPEST_CLICKABLE_IN_HOST = r"""
var host = arguments[0];
var wantText = (arguments[1] || 'continue').toLowerCase();
function textOf(el) {
  return ((el.innerText || el.textContent || '').trim()).toLowerCase();
}
function walk(r, depth, acc) {
  if (!r || depth < 0) return;
  try {
    r.querySelectorAll('button, [role="button"]').forEach(function(b) {
      var t = textOf(b);
      if (t.indexOf(wantText) !== -1) acc.push(b);
    });
  } catch (e) {}
  var nodes;
  try { nodes = r.querySelectorAll('*'); } catch (e) { return; }
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].shadowRoot) walk(nodes[i].shadowRoot, depth - 1, acc);
  }
}
var acc = [];
if (host.shadowRoot) walk(host.shadowRoot, 12, acc);
if (acc.length) return acc[acc.length - 1];
return host;
"""

JS_ELEMENT_CLICK_SYNTH = r"""
var el = arguments[0];
if (!el) return false;
var r = el.getBoundingClientRect();
var x = r.left + r.width / 2;
var y = r.top + r.height / 2;
function fire(type, ctor) {
  try {
    var e = new ctor(type, { bubbles: true, cancelable: true, view: window });
    el.dispatchEvent(e);
    return true;
  } catch (e2) { return false; }
}
fire('pointerdown', PointerEvent);
fire('mousedown', MouseEvent);
fire('mouseup', MouseEvent);
fire('click', MouseEvent);
return true;
"""


def _log(msg: str) -> None:
    print(f"[kat-reimb] {msg}", flush=True)


def build_driver(
    debugger_address: str = DEFAULT_DEBUGGER_ADDRESS,
    *,
    chromedriver_path: Optional[str] = None,
) -> WebDriver:
    _log(f"Attaching Chrome via debugger_address={debugger_address!r}")
    opts = Options()
    opts.add_experimental_option("debuggerAddress", debugger_address)
    service = Service(chromedriver_path) if chromedriver_path else Service()
    driver = webdriver.Chrome(service=service, options=opts)
    driver.set_page_load_timeout(120)
    return driver


def _exec(driver: WebDriver, script: str, *args: Any) -> Any:
    return driver.execute_script(script, *args)


def deep_query_first(
    driver: WebDriver,
    selector: str,
    root: Optional[Any] = None,
    max_depth: int = 14,
) -> Optional[WebElement]:
    el = _exec(driver, JS_DEEP_QUERY_FIRST, root, selector, max_depth)
    return el


def deep_query_all(
    driver: WebDriver,
    selector: str,
    root: Optional[Any] = None,
    max_depth: int = 14,
) -> list:
    return _exec(driver, JS_DEEP_QUERY_ALL, root, selector, max_depth) or []


def enumerate_deep_matches(
    driver: WebDriver,
    selector: str,
    root: Optional[Any] = None,
    max_depth: int = 14,
) -> list:
    """Collect every element matching `selector` across open shadow roots (deepest tree walk)."""
    return deep_query_all(driver, selector, root, max_depth)


JS_FIND_KAT_INPUT_HOST = r"""
var n = arguments[0];
while (n) {
  try {
    if (n.tagName && n.tagName.toLowerCase() === 'kat-input') return n;
  } catch (e) { break; }
  var p = n.parentElement;
  if (p) { n = p; continue; }
  var r = null;
  try { r = n.getRootNode(); } catch (e2) { r = null; }
  if (r && r.host) { n = r.host; continue; }
  break;
}
return null;
"""


def switch_to_default_content(driver: WebDriver) -> None:
    driver.switch_to.default_content()


def _frame_has_kat_form(driver: WebDriver) -> bool:
    try:
        kat = deep_query_first(driver, "kat-input", None, 14)
        if kat:
            return True
        inp = deep_query_first(driver, "input", None, 10)
        return inp is not None
    except WebDriverException:
        return False


def _dfs_into_iframes_for_kat(driver: WebDriver, path: list[int]) -> bool:
    iframes = driver.find_elements(By.CSS_SELECTOR, "iframe")
    if path:
        _log(f"At iframe path {path}: {len(iframes)} nested iframe(s)")
    for i, fr in enumerate(iframes):
        try:
            driver.switch_to.frame(fr)
        except (StaleElementReferenceException, NoSuchElementException, WebDriverException) as e:
            _log(f"Could not switch to iframe index {i} at path {path!r}: {e}")
            continue
        path.append(i)
        if _frame_has_kat_form(driver):
            _log(f"Switched to iframe path={list(path)} (KAT / form detected).")
            return True
        if _dfs_into_iframes_for_kat(driver, path):
            return True
        path.pop()
        try:
            driver.switch_to.parent_frame()
        except WebDriverException:
            pass
    return False


def switch_to_frame_containing_kat_form(
    driver: WebDriver,
    timeout: float = IFRAME_SCAN_TIMEOUT,
) -> None:
    _log("Scanning iframes (recursive) for KAT / form content…")
    end = time.monotonic() + timeout
    last_err: Optional[Exception] = None
    while time.monotonic() < end:
        try:
            switch_to_default_content(driver)
            if _frame_has_kat_form(driver):
                _log("KAT/form found in default content.")
                return
            top = driver.find_elements(By.CSS_SELECTOR, "iframe")
            _log(f"Top-level iframe count={len(top)}; depth-first search…")
            path: list[int] = []
            if _dfs_into_iframes_for_kat(driver, path):
                return
        except WebDriverException as e:
            last_err = e
            switch_to_default_content(driver)
        time.sleep(POLL_INTERVAL)
    switch_to_default_content(driver)
    raise TimeoutException(
        f"No iframe or default content contained KAT form within {timeout}s. Last issue: {last_err!r}"
    )


def wait_for_inner_input_in_kat_host(
    driver: WebDriver,
    host: WebElement,
    timeout: float = FIELD_READY_TIMEOUT,
) -> WebElement:
    _log("Waiting for inner native <input> inside kat-input host…")
    end = time.monotonic() + timeout
    last_exc: Optional[Exception] = None
    while time.monotonic() < end:
        try:
            el = _exec(driver, JS_FIND_INNER_INPUT_IN_KAT_INPUT, host, 14)
            if el:
                try:
                    if el.is_displayed():
                        return el
                except StaleElementReferenceException:
                    last_exc = None
                except WebDriverException as e:
                    last_exc = e
        except WebDriverException as e:
            last_exc = e
        time.sleep(POLL_INTERVAL)
    raise TimeoutException(
        f"Inner input inside kat-input not ready within {timeout}s: {last_exc!r}"
    )


def _collect_order_id_candidates(driver: WebDriver) -> list[tuple[WebElement, float]]:
    keywords = list(ORDER_ID_KEYWORDS)
    scored: list[tuple[WebElement, float]] = []

    kat_hosts = deep_query_all(driver, "kat-input", None, 14)
    _log(f"Deep-scan found {len(kat_hosts)} kat-input host(s).")
    for host in kat_hosts:
        try:
            inner = _exec(driver, JS_FIND_INNER_INPUT_IN_KAT_INPUT, host, 14)
            if inner:
                sc = float(_exec(driver, JS_SCORE_ORDER_FIELD_CANDIDATE, inner, keywords))
                scored.append((inner, sc))
        except WebDriverException:
            continue

    plain_inputs = deep_query_all(driver, "input:not([type='hidden'])", None, 14)
    for inp in plain_inputs:
        try:
            tag = (inp.tag_name or "").lower()
            if tag != "input":
                continue
            sc = float(_exec(driver, JS_SCORE_ORDER_FIELD_CANDIDATE, inp, keywords))
            if sc > -500:
                scored.append((inp, sc))
        except WebDriverException:
            continue

    scored.sort(key=lambda x: -x[1])
    return scored


def find_best_order_id_input(
    driver: WebDriver,
    timeout: float = SHADOW_STABLE_TIMEOUT,
) -> WebElement:
    end = time.monotonic() + timeout
    best: Optional[tuple[WebElement, float]] = None
    while time.monotonic() < end:
        candidates = _collect_order_id_candidates(driver)
        if candidates:
            best = candidates[0]
            if best[1] >= 5:
                _log(f"Chosen Order ID field with semantic score={best[1]:.1f}")
                return best[0]
            _log(f"Top candidate score low ({best[1]:.1f}); retrying…")
        time.sleep(POLL_INTERVAL)
    if best:
        _log(f"Using best-effort field score={best[1]:.1f}")
        return best[0]
    raise TimeoutException(
        f"No Order ID input found (semantic match) within {timeout}s"
    )


def set_input_value_with_events(driver: WebDriver, el: WebElement, value: str) -> dict:
    return _exec(driver, JS_SET_INPUT_VALUE_AND_EVENTS, el, value) or {"ok": False}


def verify_input_value(driver: WebDriver, el: WebElement, expected: str) -> bool:
    actual = (_exec(driver, JS_GET_INPUT_VALUE, el) or "").strip()
    ok = actual.strip() == expected.strip()
    if not ok:
        _log(f"Value verify mismatch: expected={expected!r} actual={actual!r}")
    return ok


def _send_keys_fallback(driver: WebDriver, el: WebElement, value: str) -> None:
    try:
        el.clear()
    except WebDriverException:
        pass
    el.send_keys(value)


def fill_order_id_robust(
    driver: WebDriver,
    el: WebElement,
    order_id: str,
    attempts: int = 4,
) -> None:
    order_id = order_id.strip()
    for attempt in range(1, attempts + 1):
        _log(f"Fill attempt {attempt}/{attempts} (native setter + events)…")
        set_input_value_with_events(driver, el, order_id)
        if verify_input_value(driver, el, order_id):
            _log("Order ID verified after native setter + events.")
            return
        _log("Value did not stick; trying send_keys fallback…")
        try:
            _send_keys_fallback(driver, el, order_id)
        except WebDriverException as e:
            _log(f"send_keys failed: {e}")
        if verify_input_value(driver, el, order_id):
            _log("Order ID verified after send_keys.")
            return
        time.sleep(RETRY_PAUSE)
    raise RuntimeError(
        f"Could not set Order ID to {order_id!r} after {attempts} attempts"
    )


def _element_scroll_center(driver: WebDriver, el: WebElement) -> None:
    try:
        driver.execute_script(
            "arguments[0].scrollIntoView({block:'center', inline:'nearest'});", el
        )
    except WebDriverException:
        pass


def robust_click_element(driver: WebDriver, el: WebElement) -> None:
    _element_scroll_center(driver, el)
    try:
        WebDriverWait(driver, 5, POLL_INTERVAL).until(EC.element_to_be_clickable(el))
    except TimeoutException:
        _log("element_to_be_clickable timed out; proceeding with fallbacks.")
    try:
        el.click()
        _log("Clicked via WebElement.click().")
        return
    except WebDriverException as e:
        _log(f"WebElement.click failed: {e}; trying JS click…")
    try:
        driver.execute_script("arguments[0].click();", el)
        _log("Clicked via JS element.click().")
        return
    except WebDriverException as e:
        _log(f"JS click failed: {e}; synthesizing pointer/mouse…")
    if not _exec(driver, JS_ELEMENT_CLICK_SYNTH, el):
        raise WebDriverException("All click strategies failed")


def find_and_click_continue(driver: WebDriver, timeout: float = BUTTON_READY_TIMEOUT) -> None:
    end = time.monotonic() + timeout
    last_exc: Optional[Exception] = None
    while time.monotonic() < end:
        try:
            cands = _exec(driver, JS_FIND_CONTINUE_TARGETS, None, 14) or []
            _log(f"Continue-related candidates (pre-filter): {len(cands)}")
            target = _exec(driver, JS_PICK_BEST_CONTINUE, cands)
            if target:
                tag = (target.tag_name or "").lower()
                if tag == "kat-button":
                    inner = _exec(driver, JS_FIND_DEEPEST_CLICKABLE_IN_HOST, target, "continue")
                    if inner and (inner.tag_name or "").lower() != "kat-button":
                        _log("Preferring inner button inside kat-button host.")
                        target = inner
                robust_click_element(driver, target)
                return
        except WebDriverException as e:
            last_exc = e
            _log(f"Continue find/click error: {e}")
        time.sleep(POLL_INTERVAL)
    raise TimeoutException(
        f"Could not find/click Continue within {timeout}s. Last error: {last_exc!r}"
    )


def _post_continue_state_change(driver: WebDriver) -> tuple[bool, str]:
    time.sleep(POST_CLICK_WAIT)
    try:
        url = driver.current_url
    except WebDriverException:
        url = ""
    errors = deep_query_all(driver, ".error, [class*='error'], kat-alert", None, 8)
    if errors:
        return False, f"Possible error UI after click; url={url!r}"
    inputs = deep_query_all(driver, "kat-input", None, 6)
    if not inputs:
        return True, f"No kat-input in view (may have advanced); url={url!r}"
    return True, f"Post-click wait done; url={url!r}"


def submit_reimbursement_order_id(driver: WebDriver, order_id: str) -> None:
    oid = order_id.strip()
    if not oid:
        raise ValueError("order_id is empty")

    switch_to_default_content(driver)
    switch_to_frame_containing_kat_form(driver)

    _log("Locating Order ID field (semantic)…")
    raw = find_best_order_id_input(driver)
    host_kat = None
    try:
        host_kat = _exec(driver, JS_FIND_KAT_INPUT_HOST, raw)
    except WebDriverException:
        host_kat = None

    if host_kat is not None:
        el = wait_for_inner_input_in_kat_host(driver, host_kat)
    else:
        el = raw
        WebDriverWait(driver, FIELD_READY_TIMEOUT, POLL_INTERVAL).until(
            lambda d: el.is_displayed()
        )

    fill_order_id_robust(driver, el, oid)
    if not verify_input_value(driver, el, oid):
        raise RuntimeError("Final verification failed for Order ID")

    _log("Finding and clicking Continue…")
    find_and_click_continue(driver)

    ok, msg = _post_continue_state_change(driver)
    _log(f"Post-Continue: ok={ok} — {msg}")
    if not ok:
        raise RuntimeError(msg)


def safe_submit_reimbursement_order_id(
    driver: WebDriver,
    order_id: str,
    retries: int = 3,
) -> None:
    last: Optional[Exception] = None
    for attempt in range(1, retries + 1):
        try:
            _log(f"safe_submit attempt {attempt}/{retries}")
            submit_reimbursement_order_id(driver, order_id)
            _log("safe_submit succeeded.")
            return
        except Exception as e:
            last = e
            _log(f"Attempt {attempt} failed: {type(e).__name__}: {e}")
            switch_to_default_content(driver)
            time.sleep(RETRY_PAUSE * attempt)
    assert last is not None
    raise last


if __name__ == "__main__":
    import os
    import sys

    addr = os.environ.get("CHROME_DEBUGGER_ADDRESS", DEFAULT_DEBUGGER_ADDRESS)
    oid = (sys.argv[1] if len(sys.argv) > 1 else "").strip() or "YOUR-ORDER-ID"
    drv = build_driver(addr)
    try:
        safe_submit_reimbursement_order_id(drv, oid, retries=3)
    finally:
        _log("Not closing Chrome (attached session); quitting WebDriver only.")
        try:
            drv.quit()
        except WebDriverException:
            pass
