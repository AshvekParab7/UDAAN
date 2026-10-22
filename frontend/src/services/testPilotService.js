import { apiRequest } from './apiClient.js'

const base = '/api/testpilot'

export const listRuns    = (projectId) => apiRequest(`${base}/runs/${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`)
export const createRun   = (data) => apiRequest(`${base}/runs/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
export const getRun      = (runId) => apiRequest(`${base}/runs/${encodeURIComponent(runId)}/`)
export const controlRun  = (runId, action) => apiRequest(`${base}/runs/${encodeURIComponent(runId)}/control/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })
export const previewPlan = (data) => apiRequest(`${base}/plan-preview/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
export const pollEvents  = (runId, afterSeq) => apiRequest(`${base}/runs/${encodeURIComponent(runId)}/events/poll/?after_seq=${afterSeq}`)

/**
 * Open an SSE stream for live agent events.
 * The URL uses a relative path so Vite's dev proxy forwards it to Django at :8000.
 * Falls back to polling if the SSE connection doesn't receive events within 5s.
 *
 * Returns { close: () => void } so the caller can clean up.
 */
export function openRunEventStream(runId, onEvent, onDone, onError) {
  // Use relative URL — Vite proxy forwards /api → http://127.0.0.1:8000
  // This means cookies are sent same-origin and SSE works through the proxy.
  const sseUrl = `/api/testpilot/runs/${runId}/events/`

  let closed = false
  let es = null
  let pollTimer = null
  let lastSeq = -1
  let sseActive = false
  let sseTimeout = null

  function stopAll() {
    closed = true
    if (es) { try { es.close() } catch {} }
    if (pollTimer) clearInterval(pollTimer)
    if (sseTimeout) clearTimeout(sseTimeout)
  }

  function startPolling() {
    if (closed) return
    // Stop SSE if it was running
    if (es) { try { es.close() } catch {} }

    pollTimer = setInterval(async () => {
      if (closed) { clearInterval(pollTimer); return }
      try {
        const data = await pollEvents(runId, lastSeq)
        for (const ev of data.events || []) {
          onEvent(ev)
          lastSeq = ev.seq
        }
        if (['completed', 'failed', 'cancelled'].includes(data.run_status)) {
          clearInterval(pollTimer)
          onDone({ status: data.run_status })
        }
      } catch (e) {
        // polling error — continue trying
      }
    }, 800)
  }

  // Try SSE first
  try {
    es = new EventSource(sseUrl, { withCredentials: true })

    // If we don't receive any event within 5s, fall back to polling
    sseTimeout = setTimeout(() => {
      if (!sseActive && !closed) {
        startPolling()
      }
    }, 5000)

    es.addEventListener('agent', (e) => {
      sseActive = true
      if (sseTimeout) { clearTimeout(sseTimeout); sseTimeout = null }
      try {
        const ev = JSON.parse(e.data)
        lastSeq = ev.seq
        onEvent(ev)
      } catch {}
    })

    es.addEventListener('done', (e) => {
      sseActive = true
      try { onDone(JSON.parse(e.data)) } catch { onDone({}) }
      stopAll()
    })

    es.addEventListener('timeout', () => {
      onDone({ status: 'timeout' })
      stopAll()
    })

    es.addEventListener('error', (ev) => {
      if (closed) return
      // EventSource error — fall back to polling
      if (!sseActive) {
        startPolling()
      } else {
        onError && onError(ev)
      }
    })
  } catch (e) {
    // EventSource not supported — fall back to polling
    startPolling()
  }

  return { close: stopAll }
}

export const STATUS_COLOR = {
  queued: '#9a5c00', starting: '#1d5c9b', running: '#176b45',
  paused: '#57706a', completed: '#176b45', failed: '#8b2020', cancelled: '#57706a',
}

export const STEP_COLOR = {
  pending: '#b0beb4', running: '#1d5c9b', passed: '#176b45',
  failed: '#8b2020', blocked: '#9a5c00', skipped: '#57706a', inconclusive: '#57706a',
}
