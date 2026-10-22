"""
TestPilot agent service.

Runs real Playwright browser automation in a background thread.
Emits TestEvent records so the SSE endpoint can stream them.

Screenshot strategy: JPEG after every significant action, base64-encoded
in TestEvent.data['image_b64']. The SSE view polls new events and sends them
to the frontend. This gives genuine real-time visual feedback of real browser
state with ~0.5-1s latency per action.

Cursor overlay: every action emits x/y viewport coordinates so the frontend
can animate a cursor indicator over the screenshot — showing exactly where
each click/type occurred based on real Playwright bounding boxes.
"""
from __future__ import annotations

import base64
import logging
import os
import re
import threading
import time
from typing import Any

from django.conf import settings
from django.utils import timezone

logger = logging.getLogger(__name__)

# ── Configuration ────────────────────────────────────────────────────────────
MAX_ACTIONS_PER_RUN  = int(getattr(settings, 'TESTPILOT_MAX_ACTIONS', 60))
MAX_RETRIES_PER_STEP = int(getattr(settings, 'TESTPILOT_MAX_RETRIES', 2))
ACTION_TIMEOUT_MS    = int(getattr(settings, 'TESTPILOT_ACTION_TIMEOUT_MS', 10000))
PAGE_TIMEOUT_MS      = int(getattr(settings, 'TESTPILOT_PAGE_TIMEOUT_MS', 20000))

# Domains that must never be navigated to
BLOCKED_DOMAINS = {
    '169.254.169.254',
    'metadata.google.internal',
}


def _playwright_available() -> bool:
    try:
        import playwright  # noqa: F401
        return True
    except ImportError:
        return False


# ── Event helpers ─────────────────────────────────────────────────────────────

def _emit(run, event_type: str, message: str, data: dict | None = None) -> None:
    """Persist a TestEvent row. Called from the agent thread.
    Uses select_for_update to get a reliable monotonic seq number."""
    from .models import TestEvent
    from django.db import transaction
    data = data or {}
    with transaction.atomic():
        last = TestEvent.objects.filter(run=run).select_for_update().order_by('-seq').first()
        seq = (last.seq + 1) if last else 0
        TestEvent.objects.create(
            run=run, seq=seq, event_type=event_type,
            message=message, data=data,
        )


def _screenshot_b64(page) -> str | None:
    """Take a viewport screenshot and return as base64 JPEG. Never raises."""
    try:
        raw = page.screenshot(type='jpeg', quality=72, full_page=False)
        return base64.b64encode(raw).decode()
    except Exception:
        return None


def _emit_screenshot(run, page, label: str, action_data: dict | None = None) -> None:
    b64 = _screenshot_b64(page)
    if b64:
        d = {'image_b64': b64, 'url': page.url}
        if action_data:
            d.update(action_data)
        _emit(run, 'screenshot', label, d)


def _element_coords(locator) -> dict | None:
    """Return {x, y, width, height} of a locator's bounding box, or None."""
    try:
        box = locator.bounding_box()
        if box:
            return {
                'x': int(box['x'] + box['width'] / 2),
                'y': int(box['y'] + box['height'] / 2),
                'width': int(box['width']),
                'height': int(box['height']),
            }
    except Exception:
        pass
    return None


# ── URL safety ───────────────────────────────────────────────────────────────

def _is_safe_url(url: str, allowed_origin: str) -> bool:
    try:
        from urllib.parse import urlparse
        parsed = urlparse(url)
        origin_parsed = urlparse(allowed_origin)
        if parsed.hostname in BLOCKED_DOMAINS:
            return False
        if origin_parsed.hostname and parsed.hostname:
            return parsed.hostname == origin_parsed.hostname
        return True
    except Exception:
        return False


# ── Plan builder ─────────────────────────────────────────────────────────────

def build_smoke_plan(target_url: str, objective: str) -> list[dict]:
    """Deterministic smoke test plan — always runnable without Gemini."""
    steps = [
        {
            'id': 'smoke_load',
            'description': f'Navigate to {target_url} and verify it responds',
            'action': 'navigate', 'args': {'url': target_url},
            'expect': 'Page loads with HTTP 2xx and visible content',
            'risk': 'low', 'safe': True,
        },
        {
            'id': 'smoke_title',
            'description': 'Verify the page has a non-empty <title>',
            'action': 'assert_title_nonempty', 'args': {},
            'expect': 'Page title is not empty',
            'risk': 'low', 'safe': True,
        },
        {
            'id': 'smoke_body',
            'description': 'Verify visible body text is present',
            'action': 'assert_body_nonempty', 'args': {},
            'expect': 'Page body contains visible text',
            'risk': 'low', 'safe': True,
        },
        {
            'id': 'smoke_links',
            'description': 'Count navigable links on the page',
            'action': 'count_links', 'args': {},
            'expect': 'At least one clickable link found',
            'risk': 'low', 'safe': True,
        },
        {
            'id': 'smoke_console',
            'description': 'Check for critical browser console errors',
            'action': 'check_console_errors', 'args': {},
            'expect': 'No critical JS errors in the console',
            'risk': 'low', 'safe': True,
        },
    ]
    return steps


def build_full_plan(target_url: str, objective: str) -> list[dict]:
    """Full workflow plan — smoke + navigation + forms + responsive."""
    plan = build_smoke_plan(target_url, objective)
    plan += [
        {
            'id': 'full_nav_links',
            'description': 'Navigate to each top-level internal link',
            'action': 'navigate_internal_links', 'args': {'max_links': 4},
            'expect': 'Each internal page loads without a 404 or server error',
            'risk': 'low', 'safe': True,
        },
        {
            'id': 'full_forms',
            'description': 'Detect and inspect visible forms',
            'action': 'inspect_forms', 'args': {},
            'expect': 'Forms are identified and their fields enumerated',
            'risk': 'low', 'safe': True,
        },
        {
            'id': 'full_viewport',
            'description': 'Check responsive layout at mobile viewport (375px)',
            'action': 'check_viewport', 'args': {'width': 375, 'height': 812},
            'expect': 'Page renders without horizontal overflow at mobile width',
            'risk': 'low', 'safe': True,
        },
    ]
    return plan


def build_gemini_plan(target_url: str, objective: str, page_title: str, page_text: str) -> list[dict]:
    """Use Gemini to generate a custom test plan from page content."""
    try:
        from apps.core.gemini_service import call_gemini
        prompt = f"""You are a QA engineer. Generate a structured browser test plan for:
URL: {target_url}
Objective: {objective or 'Verify the core user journey works correctly'}
Page title: {page_title}
Page content (first 800 chars): {page_text[:800]}

Return a JSON array of test steps. Each step must have:
- id: unique snake_case string
- description: one sentence describing what this step does
- action: one of: navigate, assert_title_nonempty, assert_body_nonempty, count_links, check_console_errors, assert_text_visible, click, inspect_forms
- args: object with action-specific arguments (url for navigate, text for assert_text_visible/click, selector for click if needed)
- expect: one sentence describing the expected outcome
- risk: low|medium|high

Keep it to 5-8 steps max. Focus on the most important user-visible functionality.
Return ONLY the JSON array, no other text."""

        result = call_gemini(prompt)
        # Extract JSON array from result
        text = result.strip()
        # Find JSON array
        match = re.search(r'\[.*\]', text, re.DOTALL)
        if match:
            import json
            steps = json.loads(match.group())
            # Validate and sanitize
            valid = []
            allowed_actions = {
                'navigate', 'assert_title_nonempty', 'assert_body_nonempty',
                'count_links', 'check_console_errors', 'assert_text_visible',
                'click', 'inspect_forms', 'check_viewport',
            }
            for step in steps:
                if isinstance(step, dict) and step.get('action') in allowed_actions:
                    valid.append({
                        'id': str(step.get('id', f'step_{len(valid)}')),
                        'description': str(step.get('description', ''))[:200],
                        'action': step['action'],
                        'args': step.get('args', {}) if isinstance(step.get('args'), dict) else {},
                        'expect': str(step.get('expect', ''))[:200],
                        'risk': step.get('risk', 'low'),
                        'safe': True,
                    })
            if valid:
                return valid
    except Exception as e:
        logger.warning('Gemini plan generation failed: %s', e)
    return None


# ── Core executor ─────────────────────────────────────────────────────────────

class TestPilotAgent:
    """
    Executes a test plan against a real browser.
    Call run() from a background thread — it is blocking.
    """

    def __init__(self, run_id: str):
        from .models import TestRun
        self.run = TestRun.objects.get(pk=run_id)
        self._console_errors: list[str] = []
        self._network_failures: list[str] = []
        self._action_count   = 0
        self._cancelled      = False

    def _check_cancel(self) -> bool:
        try:
            self.run.refresh_from_db(fields=['status'])
        except Exception:
            return self._cancelled
        if self.run.status == 'cancelled':
            self._cancelled = True
        return self._cancelled

    def execute(self) -> None:
        # This runs in a daemon thread. Tell Django's async safety guard that
        # synchronous ORM usage is intentional here (not in a coroutine).
        import os as _os
        _os.environ.setdefault('DJANGO_ALLOW_ASYNC_UNSAFE', 'true')
        # Close any stale DB connections inherited from the main thread
        from django.db import close_old_connections
        close_old_connections()

        if not _playwright_available():
            self.run.status = 'failed'
            self.run.results_summary = {
                'error': 'Playwright not installed.',
                'install': 'pip install playwright && python -m playwright install chromium',
            }
            self.run.finished_at = timezone.now()
            self.run.save(update_fields=['status', 'results_summary', 'finished_at', 'updated_at'])
            _emit(self.run, 'error',
                  '❌ Playwright is not installed on this server.',
                  {'install': 'pip install playwright && python -m playwright install chromium'})
            return

        from playwright.sync_api import sync_playwright, Error as PWError, TimeoutError as PWTimeout

        self.run.status = 'starting'
        self.run.started_at = timezone.now()
        self.run.save(update_fields=['status', 'started_at', 'updated_at'])
        _emit(self.run, 'agent_start',
              f'🚀 Starting browser for {self.run.target_url}',
              {'url': self.run.target_url})

        plan = self.run.test_plan or build_smoke_plan(self.run.target_url, self.run.objective)
        totals = {'total': len(plan), 'passed': 0, 'failed': 0, 'blocked': 0, 'skipped': 0, 'inconclusive': 0}

        try:
            with sync_playwright() as pw:
                browser = pw.chromium.launch(
                    headless=True,
                    args=[
                        '--no-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-setuid-sandbox',
                        '--disable-gpu',
                    ],
                )
                context = browser.new_context(
                    viewport={'width': 1280, 'height': 800},
                    ignore_https_errors=True,
                    java_script_enabled=True,
                    user_agent=(
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                        'AppleWebKit/537.36 (KHTML, like Gecko) '
                        'Chrome/124.0.0.0 Safari/537.36'
                    ),
                )
                context.set_default_timeout(ACTION_TIMEOUT_MS)
                page = context.new_page()

                # Collect console errors
                page.on('console', lambda msg: (
                    self._console_errors.append(msg.text)
                    if msg.type == 'error' else None
                ))
                # Collect network failures
                page.on('requestfailed', lambda req: (
                    self._network_failures.append(f'{req.method} {req.url[:80]}')
                ))

                self.run.status = 'running'
                self.run.save(update_fields=['status', 'updated_at'])
                _emit(self.run, 'browser_ready',
                      '🌐 Browser launched — beginning test execution',
                      {'viewport': '1280x800'})

                # Optionally upgrade to a Gemini-generated plan after first load
                # This happens during the navigate step — see _dispatch
                self._page_loaded = False
                self._gemini_plan_attempted = False

                for step_idx, step in enumerate(plan):
                    if self._check_cancel():
                        totals['skipped'] += (len(plan) - step_idx)
                        _emit(self.run, 'run_cancelled',
                              f'⛔ Run cancelled — {totals["skipped"]} step(s) skipped')
                        break
                    if self._action_count >= MAX_ACTIONS_PER_RUN:
                        _emit(self.run, 'budget_exceeded',
                              f'⚠️ Action budget of {MAX_ACTIONS_PER_RUN} reached — stopping.',
                              {'budget': MAX_ACTIONS_PER_RUN})
                        totals['skipped'] += (len(plan) - step_idx)
                        break

                    step_result = self._execute_step(page, step, step_idx)
                    totals[step_result] = totals.get(step_result, 0) + 1

                # Final screenshot
                _emit_screenshot(self.run, page, '📷 Final browser state')
                context.close()
                browser.close()

        except PWError as e:
            totals['failed'] += 1
            _emit(self.run, 'browser_error',
                  f'❌ Browser error: {e}', {'error': str(e)})
            logger.error('TestPilot PWError for run %s: %s', self.run.pk, e)
        except Exception as e:
            totals['failed'] += 1
            _emit(self.run, 'unexpected_error',
                  f'❌ Unexpected error: {e}', {'error': str(e)})
            logger.exception('TestPilot unexpected error for run %s', self.run.pk)
        finally:
            # Always close DB connections from this thread
            from django.db import close_old_connections
            close_old_connections()

        final_status = 'completed' if not self._cancelled else 'cancelled'
        self.run.status = final_status
        self.run.finished_at = timezone.now()
        self.run.results_summary = totals
        self.run.save(update_fields=['status', 'finished_at', 'results_summary', 'updated_at'])
        icon = '✅' if final_status == 'completed' else '⛔'
        _emit(self.run, 'run_complete',
              f'{icon} Run {final_status} — '
              f'{totals["passed"]} passed, {totals["failed"]} failed',
              totals)

    def _execute_step(self, page, step: dict, idx: int) -> str:
        """Execute one step with bounded retries. Returns result key."""
        from .models import TestStep
        db_step, _ = TestStep.objects.get_or_create(
            run=self.run, index=idx,
            defaults={
                'description': step.get('description', ''),
                'action_type': step.get('action', ''),
                'action_args': step.get('args', {}),
                'expected': step.get('expect', ''),
            }
        )
        db_step.status = 'running'
        db_step.started_at = timezone.now()
        db_step.save(update_fields=['status', 'started_at'])

        _emit(self.run, 'step_start',
              f'▶ Step {idx + 1}/{len(self.run.test_plan or [])}: {step["description"]}',
              {'step_id': step.get('id'), 'action': step.get('action'), 'step_index': idx})

        action = step.get('action', '')
        args   = step.get('args', {})
        result = 'inconclusive'
        error  = ''
        outcome = {}

        for attempt in range(MAX_RETRIES_PER_STEP + 1):
            self._action_count += 1
            if self._action_count > MAX_ACTIONS_PER_RUN:
                result = 'blocked'
                error  = 'Action budget exceeded.'
                break
            try:
                t0 = time.monotonic()
                outcome = self._dispatch(page, action, args, step)
                elapsed = int((time.monotonic() - t0) * 1000)
                db_step.actual      = str(outcome.get('actual', ''))
                db_step.duration_ms = elapsed
                result = 'passed' if outcome.get('passed') else 'failed'
                if result == 'failed':
                    error = outcome.get('error', 'Assertion failed')
                # Screenshot after every step
                coords = outcome.get('coords')
                _emit_screenshot(
                    self.run, page,
                    f'📸 After step {idx + 1}: {step["description"][:60]}',
                    {'coords': coords} if coords else None,
                )
                break
            except Exception as exc:
                error = str(exc)
                if attempt < MAX_RETRIES_PER_STEP:
                    _emit(self.run, 'retry',
                          f'🔄 Retrying step {idx + 1} (attempt {attempt + 2}/{MAX_RETRIES_PER_STEP + 1}): {str(exc)[:120]}',
                          {'attempt': attempt + 2, 'error': str(exc)[:200]})
                    time.sleep(1.0)
                    # Take a diagnostic screenshot on failure
                    b64 = _screenshot_b64(page)
                    if b64:
                        _emit(self.run, 'screenshot',
                              f'🔍 Diagnostic: before retry {attempt + 2}',
                              {'image_b64': b64, 'url': page.url, 'diagnostic': True})
                else:
                    result = 'failed'

        db_step.status        = result
        db_step.error_message = error
        db_step.finished_at   = timezone.now()
        db_step.save(update_fields=['status', 'error_message', 'actual', 'duration_ms', 'finished_at'])

        icon = {'passed': '✅', 'failed': '❌', 'blocked': '⊘', 'inconclusive': '❓'}.get(result, '·')
        _emit(self.run, f'step_{result}',
              f'{icon} Step {idx + 1} {result.upper()}: {step["description"]}',
              {'step_id': step.get('id'), 'result': result, 'error': error,
               'actual': str(outcome.get('actual', ''))[:200]})
        return result

    def _dispatch(self, page, action: str, args: dict, step: dict) -> dict:
        """Route action to Playwright call. Returns {passed, actual, error, coords?}."""

        if action == 'navigate':
            url = args.get('url', self.run.target_url)
            if not _is_safe_url(url, self.run.target_url):
                return {'passed': False, 'error': f'Navigation to {url} is not permitted.'}
            _emit(self.run, 'navigate',
                  f'🌐 Navigating to {url}',
                  {'url': url})
            resp = page.goto(url, wait_until='domcontentloaded', timeout=PAGE_TIMEOUT_MS)
            http_status = resp.status if resp else 0
            passed = 200 <= http_status < 400
            self._page_loaded = True
            return {
                'passed': passed, 'actual': f'HTTP {http_status}',
                'error': '' if passed else f'HTTP {http_status} — expected 2xx/3xx',
            }

        elif action == 'assert_title_nonempty':
            title = page.title()
            passed = bool(title and title.strip())
            _emit(self.run, 'assert',
                  f'🔎 Title: "{title[:80]}"',
                  {'assertion': 'title_nonempty', 'value': title, 'passed': passed})
            return {'passed': passed, 'actual': title,
                    'error': '' if passed else 'Page title is empty'}

        elif action == 'assert_body_nonempty':
            text = page.evaluate('document.body?.innerText || ""')
            stripped = (text or '').strip()
            passed = len(stripped) > 20
            _emit(self.run, 'assert',
                  f'🔎 Body text: {len(stripped)} characters',
                  {'assertion': 'body_nonempty', 'length': len(stripped), 'passed': passed})
            return {'passed': passed, 'actual': stripped[:120],
                    'error': '' if passed else 'Body text appears empty'}

        elif action == 'count_links':
            count = page.locator('a[href]').count()
            passed = count > 0
            _emit(self.run, 'assert',
                  f'🔗 Found {count} link(s)',
                  {'assertion': 'count_links', 'count': count, 'passed': passed})
            return {'passed': passed, 'actual': f'{count} links',
                    'error': '' if passed else 'No links found on page'}

        elif action == 'check_console_errors':
            errors = [e for e in self._console_errors if e]
            critical = [e for e in errors if any(
                k in e.lower() for k in ('uncaught', 'error:', 'typeerror', 'referenceerror')
            )]
            passed = len(critical) == 0
            _emit(self.run, 'assert',
                  f'🖥️ Console: {len(critical)} critical error(s)',
                  {'assertion': 'console_errors', 'critical_count': len(critical),
                   'errors': critical[:3], 'passed': passed})
            return {'passed': passed, 'actual': f'{len(critical)} critical error(s)',
                    'error': '; '.join(critical[:3]) if critical else ''}

        elif action == 'navigate_internal_links':
            max_links = int(args.get('max_links', 3))
            origin = page.url
            locators = page.locator('a[href]').all()
            visited, failures = [], []
            for link in locators[:max_links * 2]:
                if len(visited) >= max_links:
                    break
                try:
                    href = link.get_attribute('href') or ''
                    if not href or href.startswith('#') or href.startswith('mailto') or href.startswith('tel'):
                        continue
                    full = href if href.startswith('http') else f'{origin.rstrip("/")}{href}'
                    if not _is_safe_url(full, self.run.target_url):
                        continue
                    _emit(self.run, 'navigate', f'🔗 Visiting {full[:80]}', {'url': full})
                    resp = page.goto(full, wait_until='domcontentloaded', timeout=PAGE_TIMEOUT_MS)
                    sc = resp.status if resp else 0
                    visited.append(full)
                    if not (200 <= sc < 400):
                        failures.append(f'{full} → {sc}')
                    page.go_back(wait_until='domcontentloaded', timeout=PAGE_TIMEOUT_MS)
                except Exception as e:
                    failures.append(str(e)[:80])
            return {'passed': len(failures) == 0, 'actual': f'Visited {len(visited)} link(s)',
                    'error': '; '.join(failures[:3]) if failures else ''}

        elif action == 'inspect_forms':
            forms = page.locator('form').all()
            summary = []
            for i, form in enumerate(forms[:4]):
                inputs = form.locator('input, textarea, select').count()
                summary.append(f'Form {i+1}: {inputs} field(s)')
            actual = '; '.join(summary) if summary else 'No forms found'
            _emit(self.run, 'assert',
                  f'📋 Forms: {actual}',
                  {'assertion': 'inspect_forms', 'form_count': len(forms), 'passed': True})
            return {'passed': True, 'actual': actual}

        elif action == 'check_viewport':
            w = int(args.get('width', 375))
            h = int(args.get('height', 812))
            _emit(self.run, 'navigate',
                  f'📱 Resizing viewport to {w}×{h}',
                  {'width': w, 'height': h})
            page.set_viewport_size({'width': w, 'height': h})
            overflow = page.evaluate(
                'document.documentElement.scrollWidth > document.documentElement.clientWidth'
            )
            passed = not overflow
            _emit(self.run, 'assert',
                  f'📐 Viewport {w}×{h}: {"no overflow" if passed else "OVERFLOW DETECTED"}',
                  {'assertion': 'viewport', 'width': w, 'height': h,
                   'overflow': overflow, 'passed': passed})
            return {'passed': passed, 'actual': f'Viewport {w}×{h}, overflow={overflow}',
                    'error': 'Horizontal overflow detected' if overflow else ''}

        elif action == 'click':
            selector = args.get('selector', '') or args.get('text', '')
            if not selector:
                return {'passed': False, 'error': 'No selector or text provided for click'}
            # Try text selector first, then CSS selector
            if args.get('text') and not args.get('selector'):
                loc = page.get_by_text(args['text'], exact=False).first
            else:
                loc = page.locator(selector).first
            coords = _element_coords(loc)
            _emit(self.run, 'click',
                  f'🖱️ Clicking: {selector[:60]}',
                  {'selector': selector, 'coords': coords})
            loc.click(timeout=ACTION_TIMEOUT_MS)
            return {'passed': True, 'actual': f'Clicked {selector[:60]}', 'coords': coords}

        elif action == 'type':
            selector = args.get('selector', '')
            text = args.get('text', '')
            if not selector:
                return {'passed': False, 'error': 'No selector provided for type action'}
            loc = page.locator(selector).first
            coords = _element_coords(loc)
            _emit(self.run, 'type',
                  f'⌨️ Typing into {selector[:60]}',
                  {'selector': selector, 'text_length': len(text), 'coords': coords})
            loc.fill(text, timeout=ACTION_TIMEOUT_MS)
            return {'passed': True, 'actual': f'Typed {len(text)} chars into {selector[:60]}',
                    'coords': coords}

        elif action == 'assert_text_visible':
            text = args.get('text', '')
            if not text:
                return {'passed': False, 'error': 'No text provided for assert_text_visible'}
            loc = page.get_by_text(text, exact=False).first
            try:
                loc.wait_for(state='visible', timeout=ACTION_TIMEOUT_MS)
                visible = True
            except Exception:
                visible = False
            coords = _element_coords(loc) if visible else None
            _emit(self.run, 'assert',
                  f'👁️ Text "{text[:40]}" is {"visible" if visible else "NOT visible"}',
                  {'assertion': 'text_visible', 'text': text, 'visible': visible,
                   'coords': coords, 'passed': visible})
            return {'passed': visible, 'actual': f'visible={visible}', 'coords': coords,
                    'error': '' if visible else f'Text "{text}" not found on page'}

        elif action == 'scroll':
            direction = args.get('direction', 'down')
            amount = int(args.get('amount', 300))
            dy = amount if direction == 'down' else -amount
            page.evaluate(f'window.scrollBy(0, {dy})')
            _emit(self.run, 'scroll',
                  f'📜 Scrolled {direction} {amount}px',
                  {'direction': direction, 'amount': amount})
            return {'passed': True, 'actual': f'Scrolled {direction} {amount}px'}

        elif action == 'wait_for_text':
            text = args.get('text', '')
            loc = page.get_by_text(text, exact=False).first
            loc.wait_for(state='visible', timeout=ACTION_TIMEOUT_MS)
            return {'passed': True, 'actual': f'Text "{text}" appeared'}

        else:
            return {'passed': False, 'actual': '', 'error': f'Unknown action: {action}'}


# ── Thread launcher ───────────────────────────────────────────────────────────

def launch_run(run_id: str) -> None:
    """Start the agent in a daemon thread. Returns immediately."""
    def _target():
        # Small delay to ensure the HTTP response has been sent and committed
        time.sleep(0.1)
        try:
            agent = TestPilotAgent(run_id)
            agent.execute()
        except Exception as e:
            logger.exception('TestPilot launch_run failed for %s: %s', run_id, e)
        finally:
            from django.db import close_old_connections
            close_old_connections()

    t = threading.Thread(target=_target, daemon=True, name=f'testpilot-{run_id[:8]}')
    t.start()
