import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, ChevronRight,
  Circle, ClipboardCheck, ExternalLink, Info, LoaderCircle, Menu,
  RefreshCw, ShieldCheck, X,
} from 'lucide-react'
import { Link, NavLink } from 'react-router-dom'
import Sidebar from '../layouts/Sidebar.jsx'
import { readSavedProjects } from '../services/projectStorage.js'
import { getHealthScore, refreshHealthScore, getPassport, statusLabel, statusClass } from '../services/healthService.js'
import { listRuns } from '../services/testPilotService.js'
import './Verification.css'

// ─── Status icon ─────────────────────────────────────────────────────────────
function StatusIcon({ status, size = 16 }) {
  if (status === 'pass')
    return <CheckCircle2 size={size} className="vr-icon-pass" aria-label="Pass" />
  if (status === 'warn')
    return <AlertTriangle size={size} className="vr-icon-warn" aria-label="Warning" />
  if (status === 'fail')
    return <X size={size} className="vr-icon-fail" aria-label="Fail" />
  return <Circle size={size} className="vr-icon-na" aria-label="Not checked" />
}

// ─── Score ring ───────────────────────────────────────────────────────────────
function ScoreRing({ score, band }) {
  const colors = { green: '#176b45', blue: '#1d5c9b', amber: '#9a5c00', red: '#8b2020', grey: '#8a9a8e' }
  const r = 40, cx = 50, cy = 50, circ = 2 * Math.PI * r
  const filled = score != null ? circ * (score / 100) : 0
  const col = colors[statusClass(band)] ?? colors.grey
  return (
    <svg viewBox="0 0 100 100" width="100" height="100" aria-hidden="true">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#e2eae3" strokeWidth="9" />
      <circle
        cx={cx} cy={cy} r={r} fill="none"
        stroke={col} strokeWidth="9" strokeLinecap="round"
        strokeDasharray={circ} strokeDashoffset={circ - filled}
        transform={`rotate(-90 ${cx} ${cy})`}
        style={{ transition: 'stroke-dashoffset 1s ease' }}
      />
      <text x={cx} y={cy + 5} textAnchor="middle" fill="#1f2328" fontSize="20" fontWeight="700" fontFamily="inherit">
        {score != null ? score : '—'}
      </text>
    </svg>
  )
}

// ─── Checklist item ───────────────────────────────────────────────────────────
function CheckItem({ item, expanded, onToggle }) {
  return (
    <div className={`vr-check-item vr-check-${item.status}`}>
      <button className="vr-check-header" onClick={() => onToggle(item.key)} aria-expanded={expanded}>
        <StatusIcon status={item.status} />
        <span className="vr-check-label">{item.label}</span>
        <span className="vr-check-badge vr-badge-${item.status}">{item.badgeText}</span>
        {item.detail ? (expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span style={{ width: 14 }} />}
      </button>
      {expanded && item.detail && (
        <div className="vr-check-body">
          <p className="vr-check-detail">{item.detail}</p>
          {item.fixLink && (
            <Link to={item.fixLink} className="vr-fix-link">
              <ArrowRight size={13} /> Fix this <ExternalLink size={12} />
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Build checklist from API data ──────────────────────────────────────────
function buildChecklist(health, passport, runs) {
  const signals = health?.signals?.signals ?? health?.signals ?? {}
  const score = health?.score ?? null
  const band = health?.signals?.status ?? health?.status ?? ''

  const checklist = {
    project: {
      label: 'Project Foundation',
      icon: ClipboardCheck,
      items: [],
    },
    code: {
      label: 'Code & Implementation',
      icon: ShieldCheck,
      items: [],
    },
    team: {
      label: 'Team & Collaboration',
      icon: ShieldCheck,
      items: [],
    },
    delivery: {
      label: 'Delivery & Submission',
      icon: CheckCircle2,
      items: [],
    },
  }

  // ── Project Foundation ────────────────────────────────────────────────────
  const ic = signals.idea_clarity ?? {}
  const rc = signals.roadmap_coverage ?? {}

  checklist.project.items.push({
    key: 'idea_clarity',
    label: 'Idea & problem statement filled',
    status: ic.raw_score >= 75 ? 'pass' : ic.raw_score >= 50 ? 'warn' : 'fail',
    badgeText: ic.raw_score != null ? `${ic.raw_score}/100` : 'No data',
    detail: ic.explanation || 'Complete your project understanding fields in Project Setup.',
    fixLink: ic.fix_link ?? '/projects/new/setup',
  })

  checklist.project.items.push({
    key: 'flight_plan',
    label: 'Flight plan with milestones',
    status: rc.milestone_count >= 3 ? 'pass' : rc.milestone_count >= 1 ? 'warn' : 'fail',
    badgeText: rc.milestone_count != null ? `${rc.milestone_count} milestone(s)` : 'No data',
    detail: rc.explanation || 'Generate a flight plan with at least 3 milestones.',
    fixLink: rc.fix_link ?? '/flight-plan',
  })

  checklist.project.items.push({
    key: 'roadmap_tasks',
    label: 'Tasks with deadlines and effort',
    status: rc.tasks_with_deadline >= 3 ? 'pass' : rc.task_count >= 1 ? 'warn' : 'fail',
    badgeText: rc.task_count != null ? `${rc.tasks_with_deadline ?? 0}/${rc.task_count} with deadline` : 'No data',
    detail: rc.task_count
      ? `${rc.tasks_with_deadline ?? 0} of ${rc.task_count} tasks have deadlines; ${rc.tasks_with_effort ?? 0} have effort estimates.`
      : 'No tasks in the flight plan yet.',
    fixLink: '/flight-plan',
  })

  // ── Code & Implementation ─────────────────────────────────────────────────
  const ra = signals.repository_activity ?? {}
  const cp = signals.code_to_plan_match ?? {}
  const ts = signals.testing_stability ?? {}

  checklist.code.items.push({
    key: 'repo_connected',
    label: 'GitHub repository connected',
    status: ra.connection_status === 'connected' ? 'pass' : ra.raw_score > 0 ? 'warn' : 'fail',
    badgeText: ra.repo_full_name ? ra.repo_full_name : (ra.connection_status ?? 'Not connected'),
    detail: ra.explanation || 'Connect your GitHub repository to enable code analysis.',
    fixLink: '/repository',
  })

  checklist.code.items.push({
    key: 'code_to_plan',
    label: 'Code matches roadmap tasks',
    status: cp.raw_score >= 60 ? 'pass' : cp.raw_score >= 30 ? 'warn' : 'fail',
    badgeText: cp.evidence_percentage != null ? `${cp.evidence_percentage}% evidence` : 'Not run',
    detail: cp.explanation || 'Run a roadmap vs. repository comparison to verify implementation.',
    fixLink: '/repository',
  })

  checklist.code.items.push({
    key: 'testing',
    label: 'No critical stability issues',
    status: ts.critical_findings === 0 && ts.raw_score > 0 ? 'pass'
      : ts.raw_score > 0 ? 'warn' : 'fail',
    badgeText: ts.critical_findings != null
      ? (ts.critical_findings === 0 ? 'Clean' : `${ts.critical_findings} critical`)
      : 'Unknown',
    detail: ts.explanation || 'Run repository analysis to check for stability issues.',
    fixLink: '/repository',
  })

  // TestPilot
  const latestRun = runs?.[0]
  const tpPassed = latestRun?.status === 'complete' && (latestRun?.passed_count ?? 0) > 0
  const tpWarn = latestRun && latestRun.status !== 'complete'
  checklist.code.items.push({
    key: 'testpilot',
    label: 'TestPilot automated run passed',
    status: tpPassed ? 'pass' : latestRun ? 'warn' : 'fail',
    badgeText: latestRun
      ? `${latestRun.passed_count ?? 0} passed, ${latestRun.failed_count ?? 0} failed`
      : 'No runs yet',
    detail: latestRun
      ? `Last run: ${latestRun.status}. ${latestRun.passed_count ?? 0} step(s) passed, ${latestRun.failed_count ?? 0} failed.`
      : 'No TestPilot run found. Run automated browser tests to validate your app.',
    fixLink: '/testpilot',
  })

  // ── Team & Collaboration ──────────────────────────────────────────────────
  const ta = signals.team_alignment ?? {}

  checklist.team.items.push({
    key: 'team_members',
    label: 'Team members invited',
    status: ta.member_count >= 2 ? 'pass' : ta.member_count === 1 ? 'warn' : 'fail',
    badgeText: ta.member_count != null ? `${ta.member_count} member(s)` : 'No data',
    detail: ta.member_count > 1
      ? `${ta.joined_member_count ?? 0} of ${ta.member_count} member(s) have joined.`
      : ta.member_count === 1
        ? 'Only 1 member (you). Consider inviting collaborators.'
        : 'No team members added. Add collaborators from Team Workspace.',
    fixLink: '/team',
  })

  checklist.team.items.push({
    key: 'task_assignment',
    label: 'All tasks assigned to team members',
    status: ta.member_count <= 1
      ? 'na'
      : ta.assigned_task_count >= ta.total_task_count && ta.total_task_count > 0
        ? 'pass' : ta.assigned_task_count > 0 ? 'warn' : 'fail',
    badgeText: ta.total_task_count > 0
      ? `${ta.assigned_task_count ?? 0}/${ta.total_task_count} assigned`
      : 'No tasks',
    detail: ta.member_count <= 1
      ? 'Solo project — task assignment not required.'
      : `${ta.assigned_task_count ?? 0} of ${ta.total_task_count ?? 0} tasks assigned.`,
    fixLink: '/team',
  })

  // ── Delivery & Submission ─────────────────────────────────────────────────
  const dr = signals.delivery_readiness ?? {}

  checklist.delivery.items.push({
    key: 'deadline',
    label: 'Project deadline set',
    status: dr.deadline ? 'pass' : 'fail',
    badgeText: dr.deadline ? new Date(dr.deadline).toLocaleDateString() : 'Not set',
    detail: dr.deadline
      ? `Deadline: ${new Date(dr.deadline).toLocaleDateString()}`
      : 'Set a project deadline to track delivery readiness.',
    fixLink: '/projects',
  })

  checklist.delivery.items.push({
    key: 'marketing',
    label: 'Launch marketing content created',
    status: (dr.marketing_item_count ?? 0) >= 1 ? 'pass' : 'warn',
    badgeText: dr.marketing_item_count != null ? `${dr.marketing_item_count} draft(s)` : '0 drafts',
    detail: (dr.marketing_item_count ?? 0) >= 1
      ? `${dr.marketing_item_count} marketing content item(s) created.`
      : 'Create pitch, social posts, or demo scripts in Marketing Studio.',
    fixLink: '/marketing-studio',
  })

  checklist.delivery.items.push({
    key: 'passport',
    label: 'Project Passport published',
    status: passport?.is_published ? 'pass' : 'warn',
    badgeText: passport?.is_published ? 'Published' : 'Draft',
    detail: passport?.is_published
      ? `Published at: ${passport.public_url}`
      : 'Publish your Project Passport so judges can view your verified score.',
    fixLink: '/issues',
  })

  // Overall score item
  const overallStatus = score != null
    ? score >= 70 ? 'pass' : score >= 45 ? 'warn' : 'fail'
    : 'fail'

  return { checklist, score, band, overallStatus }
}

// ─── Category score helper ────────────────────────────────────────────────────
function categoryScore(items) {
  const valid = items.filter(i => i.status !== 'na')
  if (!valid.length) return null
  const pts = valid.filter(i => i.status === 'pass').length
  return Math.round((pts / valid.length) * 100)
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function Verification() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()
  const projectId = searchParams.get('project')

  const [projects, setProjects] = useState([])
  const [health, setHealth] = useState(null)
  const [passport, setPassport] = useState(null)
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [expanded, setExpanded] = useState({})

  useEffect(() => {
    const saved = readSavedProjects()
    setProjects(saved)
    if (!projectId && saved.length) setSearchParams({ project: saved[0].id }, { replace: true })
  }, [])

  const loadData = useCallback(async (pid) => {
    if (!pid) return
    setLoading(true)
    setError('')
    try {
      const [h, pp, rr] = await Promise.all([
        getHealthScore(pid).catch(() => null),
        getPassport(pid).catch(() => null),
        listRuns(pid).catch(() => ({ runs: [] })),
      ])
      setHealth(h)
      setPassport(pp)
      setRuns(rr?.runs ?? [])
    } catch (e) {
      setError(e.message || 'Failed to load verification data.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadData(projectId) }, [projectId, loadData])

  const handleRefresh = async () => {
    if (!projectId) return
    setRefreshing(true)
    try {
      await refreshHealthScore(projectId)
      await loadData(projectId)
    } catch {}
    finally { setRefreshing(false) }
  }

  const toggleExpand = (key) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }))

  const { checklist, score, band, overallStatus } = buildChecklist(health, passport, runs)

  const allItems = Object.values(checklist).flatMap(c => c.items)
  const passCount = allItems.filter(i => i.status === 'pass').length
  const warnCount = allItems.filter(i => i.status === 'warn').length
  const failCount = allItems.filter(i => i.status === 'fail').length
  const totalValid = allItems.filter(i => i.status !== 'na').length

  return (
    <div className="vr-root">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="vr-body">
        {/* ── Topbar ── */}
        <header className="vr-topbar">
          <button className="vr-menu-btn" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}>
            <Menu size={20} />
          </button>
          <div className="vr-topbar-title">
            <ShieldCheck size={18} className="vr-topbar-icon" />
            <span>Verification &amp; Readiness</span>
          </div>
          <div className="vr-topbar-actions">
            {projects.length > 1 && (
              <select
                className="vr-project-picker"
                value={projectId || ''}
                onChange={e => setSearchParams({ project: e.target.value })}
                aria-label="Select project"
              >
                {projects.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.understanding?.project_name || p.name || 'Untitled'}
                  </option>
                ))}
              </select>
            )}
            <button
              className="vr-refresh-btn"
              onClick={handleRefresh}
              disabled={refreshing || !projectId}
              aria-label="Refresh health score"
            >
              <RefreshCw size={14} className={refreshing ? 'vr-spin' : ''} />
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </header>

        <main className="vr-main">
          {/* ── Summary hero ── */}
          <section className="vr-hero">
            <div className="vr-hero-ring">
              <ScoreRing score={score} band={band} />
              <div className="vr-hero-ring-label">
                <span className="vr-hero-status-label">{statusLabel(band)}</span>
                <span className="vr-hero-sub">Health Score</span>
              </div>
            </div>
            <div className="vr-hero-stats">
              <div className="vr-stat vr-stat-pass">
                <span className="vr-stat-num">{passCount}</span>
                <span className="vr-stat-lbl">Passing</span>
              </div>
              <div className="vr-stat vr-stat-warn">
                <span className="vr-stat-num">{warnCount}</span>
                <span className="vr-stat-lbl">Warnings</span>
              </div>
              <div className="vr-stat vr-stat-fail">
                <span className="vr-stat-num">{failCount}</span>
                <span className="vr-stat-lbl">Failing</span>
              </div>
              <div className="vr-stat vr-stat-total">
                <span className="vr-stat-num">{totalValid}</span>
                <span className="vr-stat-lbl">Total checks</span>
              </div>
            </div>
            <div className="vr-hero-verdict">
              {overallStatus === 'pass' && (
                <div className="vr-verdict vr-verdict-pass">
                  <CheckCircle2 size={16} /> <strong>Ready for submission.</strong> Your project meets the key readiness criteria.
                </div>
              )}
              {overallStatus === 'warn' && (
                <div className="vr-verdict vr-verdict-warn">
                  <AlertTriangle size={16} /> <strong>Almost there.</strong> Address the warnings below before submitting.
                </div>
              )}
              {overallStatus === 'fail' && (
                <div className="vr-verdict vr-verdict-fail">
                  <X size={16} /> <strong>Not ready.</strong> Several critical checks are failing — fix them to improve your score.
                </div>
              )}
            </div>
          </section>

          {error && (
            <div className="vr-error">
              <Info size={14} /> {error}
            </div>
          )}

          {loading ? (
            <div className="vr-loading">
              <LoaderCircle size={22} className="vr-spin" /> Loading verification data…
            </div>
          ) : !projectId ? (
            <div className="vr-empty">
              <ShieldCheck size={32} />
              <p>No project selected. <Link to="/projects">Open a project</Link> to run verification checks.</p>
            </div>
          ) : (
            <div className="vr-categories">
              {Object.entries(checklist).map(([catKey, cat]) => {
                const catScore = categoryScore(cat.items)
                const catFail = cat.items.filter(i => i.status === 'fail').length
                const catWarn = cat.items.filter(i => i.status === 'warn').length
                return (
                  <section key={catKey} className="vr-category">
                    <div className="vr-category-header">
                      <span className="vr-category-label">{cat.label}</span>
                      <div className="vr-category-meta">
                        {catFail > 0 && <span className="vr-cat-badge vr-cat-badge-fail">{catFail} failing</span>}
                        {catWarn > 0 && <span className="vr-cat-badge vr-cat-badge-warn">{catWarn} warning</span>}
                        {catScore != null && (
                          <span className={`vr-cat-score ${catScore >= 75 ? 'vr-cat-score-pass' : catScore >= 50 ? 'vr-cat-score-warn' : 'vr-cat-score-fail'}`}>
                            {catScore}%
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="vr-check-list">
                      {cat.items.map(item => (
                        <CheckItem
                          key={item.key}
                          item={item}
                          expanded={!!expanded[item.key]}
                          onToggle={toggleExpand}
                        />
                      ))}
                    </div>
                  </section>
                )
              })}
            </div>
          )}

          {/* ── Passport CTA ── */}
          {passport && !passport.is_published && !loading && projectId && (
            <section className="vr-passport-cta">
              <div className="vr-passport-cta-content">
                <ShieldCheck size={20} className="vr-passport-cta-icon" />
                <div>
                  <strong>Publish your Project Passport</strong>
                  <p>Share a verified, tamper-proof snapshot of your project with judges and stakeholders.</p>
                </div>
              </div>
              <Link to="/issues" className="vr-passport-cta-btn">
                Go to Mission Control <ArrowRight size={14} />
              </Link>
            </section>
          )}
        </main>
      </div>
    </div>
  )
}
