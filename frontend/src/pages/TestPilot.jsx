import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Activity, AlertTriangle, ArrowRight, Check, CheckCircle2, ChevronDown,
  ChevronRight, Circle, Clock3, ExternalLink, Flame, Globe, Info,
  LoaderCircle, Menu, MousePointer2, Pause, Play, RefreshCw, Send, Shield,
  Square, Terminal, Wifi, WifiOff, X, Zap,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import Sidebar from '../layouts/Sidebar.jsx'
import { readSavedProjects } from '../services/projectStorage.js'
import {
  listRuns, createRun, getRun, controlRun, previewPlan,
  openRunEventStream, STATUS_COLOR, STEP_COLOR,
} from '../services/testPilotService.js'
import './TestPilot.css'

// ─── Status helpers ────────────────────────────────────────────────────────
const STATUS_LABEL = {
  queued: 'Queued', starting: 'Starting browser…', running: 'Running',
  paused: 'Paused', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
}
const ACTIVE = new Set(['queued', 'starting', 'running', 'paused'])
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

// ─── Elapsed time ─────────────────────────────────────────────────────────
function useElapsed(startedAt, active) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!active || !startedAt) { setElapsed(0); return }
    const t0 = new Date(startedAt).getTime()
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 500)
    return () => clearInterval(id)
  }, [active, startedAt])
  return elapsed
}

// ─── Step icon ────────────────────────────────────────────────────────────
function StepIcon({ status, size = 14 }) {
  const color = STEP_COLOR[status] || '#b0beb4'
  if (status === 'passed')   return <CheckCircle2 size={size} color={color} />
  if (status === 'failed')   return <X size={size} color={color} />
  if (status === 'running')  return <LoaderCircle size={size} color={color} className="tp-spin" />
  if (status === 'blocked')  return <AlertTriangle size={size} color={color} />
  if (status === 'skipped')  return <ChevronRight size={size} color={color} />
  return <Circle size={size} color={color} />
}

// ─── Cursor overlay ───────────────────────────────────────────────────────
// Shows a real cursor dot animated to the last action coordinates.
// Coordinates are actual Playwright bounding_box centroids — not invented.
function CursorOverlay({ coords, viewportW = 1280, viewportH = 800, containerW, containerH }) {
  const [pos, setPos] = useState(null)
  const [visible, setVisible] = useState(false)
  const hideTimer = useRef(null)

  useEffect(() => {
    if (!coords || !coords.x || !coords.y || !containerW || !containerH) return
    // Scale from Playwright viewport (1280×800) to container pixels
    const scaleX = containerW / viewportW
    const scaleY = containerH / viewportH
    setPos({ x: Math.round(coords.x * scaleX), y: Math.round(coords.y * scaleY) })
    setVisible(true)
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setVisible(false), 3000)
  }, [coords, containerW, containerH])

  if (!visible || !pos) return null
  return (
    <div
      className="tp-cursor-overlay"
      style={{ left: pos.x, top: pos.y }}
      aria-hidden="true"
    >
      <MousePointer2 size={20} className="tp-cursor-icon" />
      {coords?.width && coords?.height && (
        <div
          className="tp-cursor-highlight"
          style={{
            width: Math.round(coords.width * (containerW / viewportW)),
            height: Math.round(coords.height * (containerH / viewportH)),
            marginLeft: -Math.round(coords.width * (containerW / viewportW) / 2),
            marginTop: -Math.round(coords.height * (containerH / viewportH) / 2),
          }}
        />
      )}
    </div>
  )
}

// ─── Browser panel ────────────────────────────────────────────────────────
function BrowserPanel({ latestScreenshot, currentUrl, runStatus, lastEventMsg,
                        lastFrameAt, connStatus, lastCoords }) {
  const containerRef = useRef(null)
  const [dims, setDims] = useState({ w: 0, h: 0 })

  useEffect(() => {
    if (!containerRef.current) return
    const obs = new ResizeObserver(([entry]) => {
      setDims({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [])

  const isActive = ACTIVE.has(runStatus)
  const now = Date.now()
  const frameAge = lastFrameAt ? Math.floor((now - lastFrameAt) / 1000) : null
  const frameStale = frameAge != null && frameAge > 10 && isActive

  return (
    <div className="tp-browser">
      <div className="tp-browser-chrome">
        <div className="tp-browser-dots"><span /><span /><span /></div>
        <div className="tp-browser-url">
          <Globe size={11} />
          <span>{currentUrl || '—'}</span>
        </div>
        <div className="tp-browser-right-badges">
          {/* Connection status */}
          <div className={`tp-conn-badge ${connStatus}`} title={`Transport: ${connStatus}`}>
            {connStatus === 'sse' ? <Wifi size={10} /> : connStatus === 'polling' ? <Activity size={10} /> : <WifiOff size={10} />}
            <span>{connStatus === 'sse' ? 'SSE' : connStatus === 'polling' ? 'Poll' : 'Idle'}</span>
          </div>
          <div className={`tp-browser-live ${isActive ? 'active' : ''}`}>
            {isActive ? <><span className="tp-live-dot" />LIVE</> : runStatus ? runStatus.toUpperCase() : 'IDLE'}
          </div>
        </div>
      </div>
      <div className="tp-browser-viewport" ref={containerRef}>
        {latestScreenshot ? (
          <>
            <img
              src={`data:image/jpeg;base64,${latestScreenshot}`}
              alt="Latest browser screenshot"
              className="tp-screenshot"
            />
            <CursorOverlay
              coords={lastCoords}
              containerW={dims.w}
              containerH={dims.h}
            />
            {frameStale && (
              <div className="tp-frame-stale">
                <AlertTriangle size={11} /> Last frame {frameAge}s ago
              </div>
            )}
          </>
        ) : (
          <div className="tp-browser-empty">
            {isActive
              ? <><LoaderCircle size={28} className="tp-spin tp-spin-lg" /><p>Waiting for first screenshot…</p><small>Browser is starting up</small></>
              : <><Globe size={28} /><p>No browser session active.<br />Enter a URL below and click Run test.</p></>
            }
          </div>
        )}
        {lastEventMsg && isActive && (
          <div className="tp-action-overlay">{lastEventMsg}</div>
        )}
      </div>
      {frameAge != null && latestScreenshot && (
        <div className="tp-frame-meta">
          <Clock3 size={10} /> Frame {frameAge}s ago
        </div>
      )}
    </div>
  )
}

// ─── Activity timeline ────────────────────────────────────────────────────
const TYPE_ICON = {
  navigate: <Globe size={11} />,
  click: <MousePointer2 size={11} />,
  type: <Zap size={11} />,
  scroll: <ArrowRight size={11} style={{ transform: 'rotate(90deg)' }} />,
  screenshot: <Activity size={11} />,
  agent_start: <Play size={11} />,
  browser_ready: <CheckCircle2 size={11} />,
  step_passed: <Check size={11} />,
  step_failed: <X size={11} />,
  step_start: <ChevronRight size={11} />,
  run_complete: <CheckCircle2 size={11} />,
  run_cancelled: <Square size={11} />,
  error: <AlertTriangle size={11} />,
  retry: <RefreshCw size={11} />,
  browser_error: <AlertTriangle size={11} />,
  assert: <Shield size={11} />,
  budget_exceeded: <AlertTriangle size={11} />,
}
const TYPE_COLOR = {
  step_passed: '#176b45', step_failed: '#8b2020', error: '#8b2020',
  browser_error: '#8b2020', run_complete: '#176b45', retry: '#9a5c00',
  run_cancelled: '#57706a', budget_exceeded: '#9a5c00', assert: '#1d5c9b',
}

function ActivityPanel({ events, connStatus }) {
  const bottomRef = useRef(null)
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [events.length])

  if (!events.length) return (
    <div className="tp-activity-empty">
      <Terminal size={22} />
      <p>Agent activity will stream here in real time.</p>
      {connStatus === 'polling' && <small className="tp-poll-note">Using polling mode (SSE unavailable)</small>}
    </div>
  )

  return (
    <div className="tp-activity-list">
      {events.map((ev, i) => (
        <div key={`${ev.seq}-${i}`} className={`tp-event tp-event-${(ev.event_type || '').replace(/_/g, '-')}`}>
          <span className="tp-event-icon" style={{ color: TYPE_COLOR[ev.event_type] || '#668272' }}>
            {TYPE_ICON[ev.event_type] || <Circle size={9} />}
          </span>
          <span className="tp-event-msg" style={{ color: TYPE_COLOR[ev.event_type] }}>
            {ev.message}
          </span>
          <span className="tp-event-time">{(ev.timestamp || '').slice(11, 19)}</span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}

// ─── Test plan panel ──────────────────────────────────────────────────────
function PlanPanel({ plan, steps }) {
  const stepByIndex = {}
  ;(steps || []).forEach(s => { stepByIndex[s.index] = s })

  return (
    <div className="tp-plan-list">
      {(plan || []).map((step, i) => {
        const dbStep = stepByIndex[i]
        const st = dbStep?.status || 'pending'
        return (
          <div key={step.id || i} className={`tp-plan-step ${st === 'running' ? 'is-running' : ''}`}>
            <StepIcon status={st} size={13} />
            <div className="tp-plan-step-body">
              <span className="tp-plan-step-desc">{step.description}</span>
              {step.expect && <small className="tp-plan-step-expect">Expect: {step.expect}</small>}
              {dbStep?.error_message && <small className="tp-plan-step-error">{dbStep.error_message}</small>}
              {dbStep?.actual && st !== 'pending' && <small className="tp-plan-step-actual">Actual: {dbStep.actual}</small>}
            </div>
            {dbStep?.duration_ms != null && (
              <span className="tp-step-ms"><Clock3 size={9} />{dbStep.duration_ms}ms</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Results summary ──────────────────────────────────────────────────────
function ResultsBadge({ summary }) {
  if (!summary || !Object.keys(summary).length) return null
  const display = ['passed', 'failed', 'blocked', 'skipped']
    .filter(k => summary[k] !== undefined)
  return (
    <div className="tp-results">
      {display.map(k => (
        <span key={k} className={`tp-result-pill tp-result-${k}`}>{summary[k]} {k}</span>
      ))}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────
export default function TestPilot() {
  const [searchParams] = useSearchParams()
  const [menuOpen, setMenuOpen] = useState(false)
  const projects = readSavedProjects()
  const [projectId, setProjectId] = useState(
    () => searchParams.get('project') || localStorage.getItem('udaan:selected-project') || projects[0]?.id || ''
  )

  // Form state
  const [targetUrl,   setTargetUrl]   = useState('')
  const [objective,   setObjective]   = useState('')
  const [mode,        setMode]        = useState('smoke')
  const [planPreview, setPlanPreview] = useState(null)
  const [showPlan,    setShowPlan]    = useState(false)
  const [formError,   setFormError]   = useState('')
  const [launching,   setLaunching]   = useState(false)

  // Current run state
  const [run,        setRun]        = useState(null)
  const [events,     setEvents]     = useState([])
  const [steps,      setSteps]      = useState([])
  const [latestShot, setLatestShot] = useState(null)
  const [lastMsg,    setLastMsg]    = useState('')
  const [lastCoords, setLastCoords] = useState(null)
  const [lastFrameAt, setLastFrameAt] = useState(null)
  const [connStatus, setConnStatus] = useState('idle') // idle | sse | polling

  // Past runs
  const [pastRuns, setPastRuns] = useState([])

  const streamRef = useRef(null)  // { close: () => void }

  // Elapsed timer
  const runStatus = run?.status || ''
  const isActive  = ACTIVE.has(runStatus)
  const elapsed   = useElapsed(run?.started_at, isActive)

  // Close stream on unmount
  useEffect(() => () => streamRef.current?.close(), [])

  // Load past runs
  useEffect(() => {
    listRuns(projectId || undefined).then(r => setPastRuns(r.runs || [])).catch(() => {})
  }, [projectId])

  // Poll run status while active (handles the queued→starting gap)
  useEffect(() => {
    if (!run || TERMINAL.has(run.status)) return
    const id = setInterval(async () => {
      try {
        const fresh = await getRun(run.id)
        setRun(fresh)
        setSteps(fresh.steps || [])
        if (TERMINAL.has(fresh.status)) {
          clearInterval(id)
          listRuns(projectId || undefined).then(r => setPastRuns(r.runs || [])).catch(() => {})
        }
      } catch {}
    }, 3000)
    return () => clearInterval(id)
  }, [run?.id, run?.status])

  const previewTestPlan = async () => {
    if (!targetUrl.trim()) { setFormError('Enter a URL first.'); return }
    setFormError('')
    try {
      const res = await previewPlan({ target_url: targetUrl, objective, mode })
      setPlanPreview(res.plan)
      setShowPlan(true)
    } catch (e) { setFormError(e.message) }
  }

  const startRun = async () => {
    if (!targetUrl.trim()) { setFormError('Enter a URL to test.'); return }
    if (!targetUrl.startsWith('http')) { setFormError('URL must start with http:// or https://.'); return }
    setFormError(''); setLaunching(true)
    try {
      // Reset previous run state
      streamRef.current?.close()
      setRun(null); setEvents([]); setSteps([])
      setLatestShot(null); setLastMsg(''); setLastCoords(null)
      setLastFrameAt(null); setConnStatus('idle')

      const newRun = await createRun({
        target_url: targetUrl, objective, mode,
        project_id: projectId || undefined,
      })
      setRun(newRun)
      setPlanPreview(newRun.test_plan)
      setShowPlan(true)

      // Open SSE stream (with polling fallback)
      const stream = openRunEventStream(
        newRun.id,
        // onEvent
        (ev) => {
          setEvents(prev => {
            // Deduplicate by seq
            if (prev.some(e => e.seq === ev.seq)) return prev
            return [...prev, ev]
          })
          setLastMsg(ev.message || '')

          // Update connection status
          setConnStatus(prev => prev === 'idle' ? 'sse' : prev)

          if (ev.data?.image_b64) {
            setLatestShot(ev.data.image_b64)
            setLastFrameAt(Date.now())
          }
          if (ev.data?.coords) {
            setLastCoords(ev.data.coords)
          }

          // Refresh run + steps on significant events
          if (['step_passed', 'step_failed', 'run_complete', 'browser_ready'].includes(ev.event_type)) {
            getRun(newRun.id).then(r => { setRun(r); setSteps(r.steps || []) }).catch(() => {})
          }
        },
        // onDone
        (d) => {
          getRun(newRun.id).then(r => { setRun(r); setSteps(r.steps || []) }).catch(() => {})
          listRuns(projectId || undefined).then(r => setPastRuns(r.runs || [])).catch(() => {})
          setConnStatus('idle')
        },
        // onError
        (err) => {
          setFormError('Connection lost. Results may be incomplete.')
          setConnStatus('idle')
        }
      )

      // Detect polling fallback
      setTimeout(() => {
        setConnStatus(prev => {
          if (prev === 'idle') return 'polling'
          return prev
        })
      }, 6000)

      streamRef.current = stream
    } catch (e) {
      setFormError(e.message || 'Could not start run.')
    } finally {
      setLaunching(false)
    }
  }

  const doControl = async (action) => {
    if (!run) return
    try {
      const updated = await controlRun(run.id, action)
      setRun(updated)
      if (action === 'cancel') {
        streamRef.current?.close()
        setConnStatus('idle')
      }
    } catch (e) { setFormError(e.message) }
  }

  const loadPastRun = async (r) => {
    streamRef.current?.close()
    setConnStatus('idle')
    setRun(r)
    setEvents([])
    setSteps([])
    setLatestShot(null)
    setLastMsg('')
    setLastCoords(null)
    setLastFrameAt(null)
    setPlanPreview(r.test_plan)
    setShowPlan(true)
    try {
      const full = await getRun(r.id)
      setRun(full)
      setSteps(full.steps || [])
    } catch {}
  }

  const formatElapsed = (s) => s < 60 ? `${s}s` : `${Math.floor(s/60)}m ${s%60}s`

  return (
    <div className="ud-dashboard tp-page">
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="ud-work-area">
        <header className="ud-topbar">
          <div className="ud-topbar-left">
            <button className="ud-mobile-menu ud-icon-button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}>
              <Menu size={20} />
            </button>
            <span className="ud-topbar-title">TestPilot</span>
          </div>
          <div className="tp-topbar-right">
            <Flame size={14} />
            <span>AI browser testing</span>
            {isActive && elapsed > 0 && (
              <span className="tp-elapsed"><Clock3 size={11} />{formatElapsed(elapsed)}</span>
            )}
          </div>
        </header>

        <main className="ud-main tp-main">
          <div className="tp-content">

            {/* ── Setup form ── */}
            <section className="tp-setup-card">
              <div className="tp-setup-head">
                <Globe size={16} />
                <div>
                  <p className="tp-eyebrow">AI BROWSER AGENT</p>
                  <strong>Configure your test</strong>
                </div>
              </div>

              <div className="tp-form-row">
                <label className="tp-label" htmlFor="tp-url">
                  Website URL <span className="tp-required">*</span>
                </label>
                <input
                  id="tp-url" className="tp-input" type="url"
                  placeholder="https://your-deployed-app.com"
                  value={targetUrl} onChange={e => setTargetUrl(e.target.value)}
                  disabled={isActive}
                />
              </div>

              <div className="tp-form-row">
                <label className="tp-label" htmlFor="tp-objective">Testing objective (optional)</label>
                <input
                  id="tp-objective" className="tp-input" type="text"
                  placeholder="Verify the homepage loads and navigation works"
                  value={objective} onChange={e => setObjective(e.target.value)}
                  disabled={isActive}
                />
              </div>

              <div className="tp-form-row">
                <span className="tp-label">Test depth</span>
                <div className="tp-mode-group">
                  {[['smoke', 'Quick Smoke', '~30s'], ['full', 'Full Workflow', '~90s']].map(([id, label, time]) => (
                    <button key={id}
                      className={`tp-mode-btn ${mode === id ? 'active' : ''}`}
                      onClick={() => setMode(id)} disabled={isActive}>
                      {label} <small>{time}</small>
                    </button>
                  ))}
                </div>
              </div>

              {formError && <p className="tp-form-error" role="alert"><AlertTriangle size={13} />{formError}</p>}

              <div className="tp-form-actions">
                <button className="tp-preview-btn" onClick={previewTestPlan} disabled={isActive || !targetUrl}>
                  <ChevronRight size={13} /> Preview plan
                </button>
                {!isActive ? (
                  <button className="tp-run-btn" onClick={startRun} disabled={launching || !targetUrl}>
                    {launching
                      ? <><LoaderCircle size={14} className="tp-spin" /> Starting…</>
                      : <><Play size={14} fill="currentColor" /> Run test</>
                    }
                  </button>
                ) : (
                  <div className="tp-run-controls">
                    {runStatus === 'running' && (
                      <button className="tp-ctrl-btn pause" onClick={() => doControl('pause')}><Pause size={13} /> Pause</button>
                    )}
                    {runStatus === 'paused' && (
                      <button className="tp-ctrl-btn resume" onClick={() => doControl('resume')}><Play size={13} /> Resume</button>
                    )}
                    <button className="tp-ctrl-btn stop" onClick={() => doControl('cancel')}><Square size={13} /> Stop</button>
                  </div>
                )}
              </div>

              {run && (
                <div className="tp-run-status-bar">
                  <span className="tp-run-status-dot" style={{ background: STATUS_COLOR[runStatus] || '#57706a' }} />
                  <span style={{ color: STATUS_COLOR[runStatus] || '#57706a', fontWeight: 640, fontSize: 11 }}>
                    {STATUS_LABEL[runStatus] || runStatus}
                  </span>
                  {run.results_summary && Object.keys(run.results_summary).length > 0 && (
                    <ResultsBadge summary={run.results_summary} />
                  )}
                </div>
              )}
            </section>

            {/* ── Three-panel view ── */}
            {(run || planPreview) && (
              <div className="tp-panels">
                {/* Left: Browser + Activity */}
                <div className="tp-left-panels">
                  <BrowserPanel
                    latestScreenshot={latestShot}
                    currentUrl={run?.target_url || targetUrl}
                    runStatus={runStatus}
                    lastEventMsg={lastMsg}
                    lastFrameAt={lastFrameAt}
                    connStatus={connStatus}
                    lastCoords={lastCoords}
                  />
                  <div className="tp-activity-card">
                    <div className="tp-card-head">
                      <Terminal size={13} />
                      <strong>Agent activity</strong>
                      <span className="tp-event-count">{events.length} events</span>
                      {connStatus !== 'idle' && (
                        <span className={`tp-conn-pill ${connStatus}`}>
                          {connStatus === 'sse' ? <><Wifi size={9} />SSE</> : <><Activity size={9} />Polling</>}
                        </span>
                      )}
                    </div>
                    <ActivityPanel events={events} connStatus={connStatus} />
                  </div>
                </div>

                {/* Right: Plan + Results */}
                <div className="tp-right-panels">
                  <div className="tp-plan-card">
                    <div className="tp-card-head">
                      <Shield size={13} />
                      <strong>Test plan &amp; results</strong>
                      <button className="tp-collapse-btn" onClick={() => setShowPlan(v => !v)}>
                        <ChevronDown size={13} className={showPlan ? 'open' : ''} />
                      </button>
                    </div>
                    {showPlan && (
                      <PlanPanel
                        plan={run?.test_plan || planPreview}
                        steps={steps}
                      />
                    )}
                  </div>

                  {TERMINAL.has(runStatus) && run?.results_summary && (
                    <div className="tp-summary-card">
                      <div className="tp-card-head"><CheckCircle2 size={13} color="#176b45" /><strong>Run summary</strong></div>
                      <div className="tp-summary-grid">
                        {['passed', 'failed', 'blocked', 'skipped', 'total'].map(k => {
                          const v = run.results_summary[k]
                          if (v == null) return null
                          return (
                            <div key={k} className="tp-summary-item">
                              <span className={`tp-summary-num tp-result-${k}`}>{v}</span>
                              <span className="tp-summary-key">{k}</span>
                            </div>
                          )
                        })}
                      </div>
                      <p className="tp-summary-note">
                        <Info size={11} /> Passed = assertion explicitly verified by Playwright.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Past runs ── */}
            {pastRuns.length > 0 && (
              <section className="tp-past-runs">
                <p className="tp-eyebrow">PREVIOUS RUNS</p>
                <div className="tp-runs-list">
                  {pastRuns.slice(0, 8).map(r => (
                    <div key={r.id} className="tp-run-row" onClick={() => loadPastRun(r)}>
                      <span className="tp-run-dot" style={{ background: STATUS_COLOR[r.status] || '#57706a' }} />
                      <span className="tp-run-url">{r.target_url}</span>
                      <span className="tp-run-mode">{r.mode}</span>
                      <span className="tp-run-time">{r.created_at?.slice(0, 10)}</span>
                      <span className="tp-run-status" style={{ color: STATUS_COLOR[r.status] }}>{r.status}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ── Info note ── */}
            <aside className="tp-arch-note">
              <div className="tp-arch-head"><Info size={13} />How TestPilot works</div>
              <ul>
                <li><strong>Real browser:</strong> Playwright Chromium runs headless on the Django server. Real HTTP requests, real DOM, real assertions.</li>
                <li><strong>Live screenshots:</strong> Every action captures a JPEG screenshot streamed via SSE (or polling fallback). This is real browser state — not animation or simulation.</li>
                <li><strong>Cursor overlay:</strong> The cursor dot on screenshots corresponds to real Playwright bounding box coordinates. It shows exactly where each click/type occurred.</li>
                <li><strong>Connection:</strong> Uses SSE for lowest latency. Automatically falls back to 800ms polling if SSE is unavailable (e.g. behind a buffering proxy).</li>
                <li><strong>Safe targets only:</strong> Only the approved origin is navigated. Cloud metadata endpoints and private services are blocked.</li>
              </ul>
            </aside>

          </div>
        </main>
      </div>
    </div>
  )
}
