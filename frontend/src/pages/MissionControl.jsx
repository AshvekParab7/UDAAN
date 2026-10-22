import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Activity, ArrowRight, Bookmark, CheckCircle2, ChevronDown, ChevronRight,
  ClipboardList, Copy, ExternalLink, Globe, Info, Link2, LoaderCircle,
  Menu, RefreshCw, Share2, ShieldCheck, Sparkles, TrendingUp, X, Zap,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import Sidebar from '../layouts/Sidebar.jsx'
import { readSavedProjects } from '../services/projectStorage.js'
import {
  getHealthScore, refreshHealthScore,
  getHealthActions, getHealthHistory,
  getPassport, updatePassport, deletePassport,
  statusLabel, statusClass,
} from '../services/healthService.js'
import './MissionControl.css'

// ─── Colour maps ──────────────────────────────────────────────────────────────
const BAND_COLOR  = { green: '#176b45', blue: '#1d5c9b', amber: '#9a5c00', red: '#8b2020', grey: '#57706a' }
const BAND_BG     = { green: '#e9f5ee', blue: '#e5eef9', amber: '#fdf1d7', red: '#fde8e8', grey: '#f0f4f0' }
const BAND_TRACK  = { green: '#c8e8d4', blue: '#c2d9f2', amber: '#f5dfa0', red: '#f5c0c0', grey: '#d8e0da' }
const CONF_LABEL  = { high: 'High confidence', medium: 'Partial evidence', low: 'Not verified' }
const CONF_DOT    = { high: '#176b45', medium: '#9a5c00', low: '#8b2020' }
const PRI_COLOR   = { high: '#8b2020', medium: '#9a5c00', low: '#176b45' }
const PRI_BG      = { high: '#fde8e8', medium: '#fdf1d7', low: '#e9f5ee' }

// ─── SVG Circular Gauge ──────────────────────────────────────────────────────
function Gauge({ score, band, size = 160 }) {
  const r = 58, cx = 80, cy = 80
  const circ = 2 * Math.PI * r
  const filled = score !== null ? circ * (score / 100) : 0
  const color = BAND_COLOR[statusClass(band)] ?? '#57706a'
  return (
    <svg viewBox="0 0 160 160" width={size} height={size} aria-hidden="true" className="mc-gauge-svg">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#2a3d32" strokeWidth="12" />
      <circle
        cx={cx} cy={cy} r={r} fill="none"
        stroke={color} strokeWidth="12" strokeLinecap="round"
        strokeDasharray={circ} strokeDashoffset={circ - filled}
        transform={`rotate(-90 ${cx} ${cy})`}
        style={{ transition: 'stroke-dashoffset 1.1s cubic-bezier(.4,0,.2,1)' }}
      />
      <text x={cx} y={cy - 6} textAnchor="middle" fill="#fff" fontSize="32" fontWeight="700" fontFamily="inherit">
        {score !== null ? score : '—'}
      </text>
      <text x={cx} y={cy + 16} textAnchor="middle" fill="#8da898" fontSize="11" fontFamily="inherit">/ 100</text>
    </svg>
  )
}

// ─── SVG History Sparkline ────────────────────────────────────────────────────
function Sparkline({ history }) {
  if (!history?.length) return <div className="mc-sparkline-empty">No history yet</div>
  const scores = history.map(h => h.score)
  const min = Math.max(0, Math.min(...scores) - 5)
  const max = Math.min(100, Math.max(...scores) + 5)
  const W = 320, H = 72, PAD = 8
  const xs = scores.map((_, i) => PAD + (i / Math.max(scores.length - 1, 1)) * (W - PAD * 2))
  const ys = scores.map(s => H - PAD - ((s - min) / Math.max(max - min, 1)) * (H - PAD * 2))
  const pts = xs.map((x, i) => `${x},${ys[i]}`).join(' ')
  const area = `M${xs[0]},${ys[0]} ${xs.map((x, i) => `L${x},${ys[i]}`).slice(1).join(' ')} L${xs[xs.length - 1]},${H} L${xs[0]},${H} Z`
  const line = `M${xs[0]},${ys[0]} ${xs.map((x, i) => `L${x},${ys[i]}`).slice(1).join(' ')}`
  const last = scores[scores.length - 1]
  const prev = scores.length > 1 ? scores[scores.length - 2] : null
  const delta = prev !== null ? last - prev : 0
  return (
    <div className="mc-sparkline-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
        <defs>
          <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#176b45" stopOpacity=".28" />
            <stop offset="100%" stopColor="#176b45" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#sparkGrad)" />
        <polyline points={pts} fill="none" stroke="#176b45" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r="4" fill="#176b45" />
      </svg>
      <div className="mc-sparkline-meta">
        <span className="mc-sparkline-label">Score over time ({scores.length} snapshot{scores.length !== 1 ? 's' : ''})</span>
        {delta !== 0 && <span className={`mc-sparkline-delta ${delta > 0 ? 'up' : 'down'}`}>{delta > 0 ? '+' : ''}{delta} pts</span>}
      </div>
    </div>
  )
}

// ─── Signal Bar Row ──────────────────────────────────────────────────────────
function SignalBar({ signal }) {
  const cls = statusClass(
    signal.raw_score >= 80 ? 'strong' : signal.raw_score >= 60 ? 'on_track' : signal.raw_score >= 40 ? 'at_risk' : 'needs_attention'
  )
  const color  = BAND_COLOR[cls]
  const track  = BAND_TRACK[cls]
  const conf   = signal.confidence ?? 'low'
  const [open, setOpen] = useState(false)
  return (
    <div className="mc-signal-row">
      <div className="mc-signal-head" onClick={() => setOpen(v => !v)} role="button" tabIndex={0}
        onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setOpen(v => !v)}
        aria-expanded={open}>
        <span className="mc-signal-name">{signal.label}</span>
        <div className="mc-signal-bar-wrap">
          <div className="mc-signal-track" style={{ background: track }}>
            <div className="mc-signal-fill"
              style={{ width: `${signal.raw_score ?? 0}%`, background: color,
                transition: 'width 1.1s cubic-bezier(.4,0,.2,1)' }} />
          </div>
        </div>
        <span className="mc-signal-pct" style={{ color }}>{signal.raw_score ?? 0}%</span>
        <span className="mc-signal-conf-dot" style={{ background: CONF_DOT[conf] }} title={CONF_LABEL[conf]} />
        <ChevronRight size={13} className={`mc-signal-chevron ${open ? 'open' : ''}`} />
      </div>
      {open && (
        <div className="mc-signal-detail">
          <p className="mc-signal-explanation">{signal.explanation}</p>
          <div className="mc-signal-footer">
            <span className="mc-conf-tag" style={{ background: CONF_DOT[conf] + '22', color: CONF_DOT[conf] }}>
              {CONF_LABEL[conf]}
            </span>
            {signal.fix_link && (
              <Link to={signal.fix_link} className="mc-fix-link">
                Improve <ArrowRight size={11} />
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Action Card ─────────────────────────────────────────────────────────────
function ActionCard({ action, index }) {
  const pri = action.priority ?? 'medium'
  return (
    <div className="mc-action-card">
      <div className="mc-action-head">
        <span className="mc-action-num">{index + 1}</span>
        <span className="mc-action-title">{action.title}</span>
        <span className="mc-action-pri" style={{ background: PRI_BG[pri], color: PRI_COLOR[pri] }}>{pri}</span>
      </div>
      <p className="mc-action-why">{action.why}</p>
      <div className="mc-action-footer">
        <span className="mc-action-meta">
          <Zap size={11} /> {action.effort ?? '—'}
        </span>
        {action.impact_estimate > 0 && (
          <span className="mc-action-impact">
            <TrendingUp size={11} /> ~+{action.impact_estimate} pts
          </span>
        )}
        {action.link && (
          <Link to={action.link} className="mc-action-link">
            Go fix it <ArrowRight size={11} />
          </Link>
        )}
      </div>
    </div>
  )
}

// ─── Passport Panel ──────────────────────────────────────────────────────────
const ALL_FIELDS = [
  { key: 'score',              label: 'Health score & status' },
  { key: 'signals',            label: 'Signal breakdown' },
  { key: 'evidence_coverage',  label: 'Evidence coverage %' },
  { key: 'problem_statement',  label: 'Problem statement' },
  { key: 'tech_stack',         label: 'Technology stack' },
  { key: 'team_size',          label: 'Team size' },
]

function PassportPanel({ projectId }) {
  const [passport, setPassport] = useState(null)
  const [loading, setLoading]   = useState(false)
  const [notice,  setNotice]    = useState('')
  const [copied,  setCopied]    = useState(false)

  useEffect(() => {
    if (!projectId) return
    getPassport(projectId).then(setPassport).catch(() => {})
  }, [projectId])

  const toggle = async (key, val) => {
    if (!passport) return
    setLoading(true); setNotice('')
    try {
      const updated = await updatePassport(projectId, { [key]: val })
      setPassport(updated)
      setNotice(key === 'is_published' ? (val ? 'Passport published.' : 'Passport unpublished.') : 'Settings saved.')
    } catch (e) { setNotice(e.message || 'Could not update passport.') }
    finally { setLoading(false) }
  }

  const toggleField = async (fieldKey) => {
    if (!passport) return
    const current = passport.disclosed_fields ?? []
    const next = current.includes(fieldKey) ? current.filter(f => f !== fieldKey) : [...current, fieldKey]
    await toggle('disclosed_fields', next)
  }

  const copyLink = async () => {
    if (!passport?.public_url) return
    try { await navigator.clipboard.writeText(passport.public_url); setCopied(true); setTimeout(() => setCopied(false), 2000) }
    catch { setNotice(passport.public_url) }
  }

  if (!passport) return <div className="mc-passport-empty"><LoaderCircle size={15} className="mc-spin" /> Loading passport settings…</div>

  return (
    <div className="mc-passport">
      <div className="mc-passport-head">
        <Globe size={15} />
        <div>
          <strong>Project Passport</strong>
          <small>Share a public read-only health summary for this project.</small>
        </div>
        <span className={`mc-passport-badge ${passport.is_published ? 'published' : 'draft'}`}>
          {passport.is_published ? 'Published' : 'Unpublished'}
        </span>
      </div>

      {notice && <p className="mc-passport-notice" role="status">{notice}</p>}

      <div className="mc-passport-fields">
        <p className="mc-passport-fields-label">Choose what to disclose:</p>
        {ALL_FIELDS.map(f => (
          <label key={f.key} className="mc-passport-field-row">
            <input type="checkbox"
              checked={passport.disclosed_fields?.includes(f.key) ?? false}
              onChange={() => void toggleField(f.key)}
              disabled={loading}
            />
            {f.label}
          </label>
        ))}
      </div>

      <div className="mc-passport-actions">
        <button className={`mc-passport-btn ${passport.is_published ? 'unpublish' : 'publish'}`}
          onClick={() => void toggle('is_published', !passport.is_published)}
          disabled={loading}>
          {passport.is_published ? 'Unpublish' : <><Share2 size={13} /> Publish passport</>}
        </button>
        {passport.is_published && (
          <button className="mc-passport-copy" onClick={copyLink} disabled={loading}>
            {copied ? <><CheckCircle2 size={13} /> Copied!</> : <><Copy size={13} /> Copy link</>}
          </button>
        )}
      </div>
      {passport.is_published && passport.public_url && (
        <a href={passport.public_url} target="_blank" rel="noreferrer" className="mc-passport-preview">
          Preview public page <ExternalLink size={11} />
        </a>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function MissionControl() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [menuOpen, setMenuOpen]   = useState(false)
  const projects = readSavedProjects()
  const [projectId, setProjectId] = useState(
    () => searchParams.get('project') || localStorage.getItem('udaan:selected-project') || projects[0]?.id || ''
  )
  const project = projects.find(p => String(p.id) === String(projectId)) || projects[0] || null

  const [health,   setHealth]   = useState(null)
  const [actions,  setActions]  = useState([])
  const [history,  setHistory]  = useState([])
  const [loading,  setLoading]  = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error,    setError]    = useState('')

  const load = useCallback(async (id) => {
    if (!id) { setHealth(null); setActions([]); setHistory([]); return }
    setLoading(true); setError('')
    try {
      const [h, a, hist] = await Promise.allSettled([
        getHealthScore(id),
        getHealthActions(id),
        getHealthHistory(id, 12),
      ])
      if (h.status === 'fulfilled')    setHealth(h.value)
      if (a.status === 'fulfilled')    setActions(a.value.actions ?? [])
      if (hist.status === 'fulfilled') setHistory(hist.value.history ?? [])
      if (h.status === 'rejected') setError(h.reason?.message || 'Could not load health score.')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load(projectId) }, [projectId, load])

  const changeProject = id => {
    setProjectId(id)
    localStorage.setItem('udaan:selected-project', id)
    setSearchParams({ project: id }, { replace: true })
  }

  const doRefresh = async () => {
    if (!projectId || refreshing) return
    setRefreshing(true); setError('')
    try {
      const h = await refreshHealthScore(projectId)
      setHealth(h)
      const [a, hist] = await Promise.allSettled([getHealthActions(projectId), getHealthHistory(projectId, 12)])
      if (a.status === 'fulfilled')    setActions(a.value.actions ?? [])
      if (hist.status === 'fulfilled') setHistory(hist.value.history ?? [])
    } catch (e) { setError(e.message || 'Refresh failed.') }
    finally { setRefreshing(false) }
  }

  // Resolve signals from the nested structure the backend returns
  const signals = useMemo(() => {
    if (!health) return []
    const raw = health.signals?.signals ?? health.signals ?? {}
    return Object.values(raw).filter(Boolean)
  }, [health])

  const score  = health?.score ?? null
  const band   = health?.signals?.status ?? health?.status ?? 'needs_attention'
  const cls    = statusClass(band)
  const label  = statusLabel(band)
  const evCov  = health?.evidence_coverage ?? null
  const compAt = health?.computed_at ? new Date(health.computed_at).toLocaleString() : null

  return (
    <div className="ud-dashboard mc-page">
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="ud-work-area">
        <header className="ud-topbar">
          <div className="ud-topbar-left">
            <button className="ud-mobile-menu ud-icon-button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}>
              <Menu size={20} />
            </button>
            <span className="ud-topbar-title">Mission Control</span>
          </div>
          <div className="mc-topbar-right">
            <Activity size={14} />
            <span>Project health</span>
          </div>
        </header>

        <main className="ud-main mc-main">
          <div className="mc-content">

            {/* ── Toolbar ── */}
            <div className="mc-toolbar">
              <label className="mc-project-select">
                <span>Project</span>
                <select value={projectId} onChange={e => changeProject(e.target.value)} aria-label="Select project">
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name || 'Untitled'}</option>)}
                </select>
                <ChevronDown size={14} />
              </label>
              <button className="mc-refresh-btn" onClick={doRefresh} disabled={refreshing || loading} aria-label="Refresh score">
                <RefreshCw size={14} className={refreshing ? 'mc-spin' : ''} />
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            {error && <div className="mc-error" role="alert">{error}<button onClick={() => setError('')}><X size={14} /></button></div>}

            {!project ? (
              <div className="mc-empty-state">
                <Activity size={32} />
                <h2>No project selected</h2>
                <p>Create or select a project to view its health score.</p>
                <Link to="/" className="mc-cta">Start a project <ArrowRight size={14} /></Link>
              </div>
            ) : (
              <>
                {/* ── Hero: Gauge + Score ── */}
                <section className="mc-hero" aria-label="Project health score">
                  <div className="mc-gauge-area">
                    {loading
                      ? <div className="mc-gauge-loading"><LoaderCircle size={40} className="mc-spin mc-spin-lg" /></div>
                      : <Gauge score={score} band={band} size={160} />
                    }
                  </div>
                  <div className="mc-hero-copy">
                    <p className="mc-eyebrow">PROJECT HEALTH SCORE</p>
                    <h1 className="mc-hero-title">
                      {score !== null ? score : '—'}
                      <span className="mc-hero-denom">/100</span>
                    </h1>
                    <span className="mc-status-badge" style={{ background: BAND_COLOR[cls] + '22', color: BAND_COLOR[cls] }}>
                      {label}
                    </span>
                    <div className="mc-hero-meta">
                      {evCov !== null && (
                        <span><ShieldCheck size={12} /> {evCov}% evidence coverage</span>
                      )}
                      {compAt && (
                        <span><Info size={12} /> Last assessed {compAt}</span>
                      )}
                    </div>
                    <p className="mc-hero-note">
                      Score is computed from real project data across 7 signals.
                      Missing evidence lowers confidence — not artificially inflated.
                    </p>
                  </div>
                </section>

                {/* ── Signal Bars ── */}
                <section className="mc-section">
                  <div className="mc-section-heading">
                    <p className="mc-eyebrow">SEVEN SIGNALS</p>
                    <h2>Score breakdown</h2>
                    <p>Click any signal to see what evidence was used and how to improve it.</p>
                  </div>
                  {loading ? (
                    <div className="mc-loading-rows">
                      {[1,2,3,4,5,6,7].map(i => <div key={i} className="mc-skeleton-bar" />)}
                    </div>
                  ) : signals.length ? (
                    <div className="mc-signals-list">
                      {signals.map(sig => <SignalBar key={sig.key} signal={sig} />)}
                    </div>
                  ) : (
                    <div className="mc-inline-empty">No signal data yet. Select a project and refresh.</div>
                  )}
                </section>

                {/* ── Two-column: Actions + History ── */}
                <div className="mc-bottom-grid">
                  {/* Actions */}
                  <section className="mc-section mc-actions-col">
                    <div className="mc-section-heading">
                      <p className="mc-eyebrow">RECOMMENDED ACTIONS</p>
                      <h2>Top priorities</h2>
                      <p>Deterministic recommendations from real project gaps — never invented.</p>
                    </div>
                    {loading ? (
                      <div className="mc-loading-rows">{[1,2,3].map(i => <div key={i} className="mc-skeleton-card" />)}</div>
                    ) : actions.length ? (
                      <div className="mc-actions-list">
                        {actions.slice(0, 3).map((a, i) => <ActionCard key={i} action={a} index={i} />)}
                      </div>
                    ) : (
                      <div className="mc-inline-empty">No recommended actions — your project looks healthy!</div>
                    )}
                  </section>

                  {/* History + Passport */}
                  <div className="mc-right-col">
                    <section className="mc-section mc-history-col">
                      <div className="mc-section-heading">
                        <p className="mc-eyebrow">SCORE HISTORY</p>
                        <h2>Trend</h2>
                      </div>
                      <Sparkline history={[...history].reverse()} />
                    </section>

                    <section className="mc-section mc-passport-col">
                      <div className="mc-section-heading">
                        <p className="mc-eyebrow">SHARING</p>
                        <h2>Project Passport</h2>
                      </div>
                      <PassportPanel projectId={projectId} />
                    </section>
                  </div>
                </div>

                {/* ── Methodology note ── */}
                <aside className="mc-methodology">
                  <Sparkles size={13} />
                  <p>
                    <strong>How the score works:</strong> Seven signals are weighted —
                    Code-to-Plan Match (25%), Testing &amp; Stability (20%), Roadmap Coverage (15%),
                    Idea Clarity (10%), Team Alignment (10%), Repository Activity (10%),
                    Delivery Readiness (10%). Signals without evidence are marked <em>Not Verified</em> and
                    contribute a reduced score rather than zero or perfect. A high score reflects observed
                    evidence, not a guarantee of working software.
                  </p>
                </aside>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
