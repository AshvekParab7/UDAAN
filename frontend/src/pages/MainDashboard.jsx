import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, Bell, BriefcaseBusiness, GraduationCap, Github, Lightbulb, Menu, Paperclip, Rocket, Search, Send, Sparkles, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router-dom'
import Sidebar from '../layouts/Sidebar.jsx'
import { saveProjectDraft } from '../services/ideaWorkflowService.js'
import { useAuth } from '../app/AuthContext.jsx'
import { getHealthScore, statusClass, statusLabel } from '../services/healthService.js'
import { readSavedProjects } from '../services/projectStorage.js'

const draftKey = 'udaan:idea-draft'
function newUuid() {
  return globalThis.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const random = Math.random() * 16 | 0
    return (char === 'x' ? random : (random & 3 | 8)).toString(16)
  })
}
const ideas = [
  ['\u2197', 'A smarter way to share rides', 'Connect people heading in the same direction.'],
  ['\u2723', 'A study companion that adapts', 'Turn class notes into a personal learning plan.'],
  ['\u2302', 'Less waste, better groceries', 'Plan meals around what you already have.'],
]

function readDraft() {
  try { return JSON.parse(sessionStorage.getItem(draftKey) || localStorage.getItem(draftKey) || 'null') } catch { return null }
}

function flightGeometry(origin, width, height) {
  const destination = { x: width * 0.86, y: Math.max(48, height * 0.12) }
  const dx = destination.x - origin.x
  const dy = destination.y - origin.y
  const control1 = { x: origin.x + dx * 0.28, y: origin.y + dy * 0.12 - 52 }
  const control2 = { x: origin.x + dx * 0.72, y: destination.y + (origin.y - destination.y) * 0.18 - 35 }
  const pointAt = t => {
    const u = 1 - t
    return {
      x: u ** 3 * origin.x + 3 * u ** 2 * t * control1.x + 3 * u * t ** 2 * control2.x + t ** 3 * destination.x,
      y: u ** 3 * origin.y + 3 * u ** 2 * t * control1.y + 3 * u * t ** 2 * control2.y + t ** 3 * destination.y,
    }
  }
  const points = [0, 0.32, 0.68, 1].map(pointAt)
  const rotations = points.map((point, index) => {
    const next = points[Math.min(index + 1, points.length - 1)]
    const previous = points[Math.max(index - 1, 0)]
    return Math.atan2(next.y - previous.y, next.x - previous.x) * 180 / Math.PI + 45
  })
  return {
    width, height, origin, destination,
    path: `M ${origin.x} ${origin.y} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${destination.x} ${destination.y}`,
    x: points.map(point => point.x - origin.x),
    y: points.map(point => point.y - origin.y),
    rotate: rotations,
  }
}

function HealthWidget() {
  const projects = readSavedProjects()
  const projectId = localStorage.getItem('udaan:selected-project') || projects[0]?.id || ''
  const project = projects.find(p => p.id === projectId)
  const [health, setHealth] = useState(null)

  useEffect(() => {
    if (!projectId) return
    getHealthScore(projectId).then(setHealth).catch(() => {})
  }, [projectId])

  if (!projectId || !project) return null

  const score = health?.score ?? null
  const band = health?.signals?.status ?? health?.status ?? 'needs_attention'
  const cls = statusClass(band)
  const label = statusLabel(band)

  const bandColor = { green: '#176b45', blue: '#1d5c9b', amber: '#9a5c00', red: '#8b2020', grey: '#57706a' }[cls] || '#57706a'
  const bandBg = { green: '#e9f5ee', blue: '#e5eef9', amber: '#fdf1d7', red: '#fde8e8', grey: '#f0f4f0' }[cls] || '#f0f4f0'

  return (
    <section className="ud-health-widget" aria-label="Project health score">
      <div className="ud-simple-section-heading">
        <h2>Project health</h2>
        <Link to="/issues">View full report <ArrowRight size={14} /></Link>
      </div>
      <div className="ud-health-card">
        <div className="ud-health-score-ring" aria-hidden="true">
          <svg viewBox="0 0 48 48" width="48" height="48">
            <circle cx="24" cy="24" r="18" fill="none" stroke="#e2eae3" strokeWidth="5" />
            {score !== null && (
              <circle
                cx="24" cy="24" r="18" fill="none"
                stroke={bandColor} strokeWidth="5" strokeLinecap="round"
                strokeDasharray={`${2 * Math.PI * 18}`}
                strokeDashoffset={`${2 * Math.PI * 18 * (1 - score / 100)}`}
                transform="rotate(-90 24 24)"
                style={{ transition: 'stroke-dashoffset 1s ease' }}
              />
            )}
          </svg>
        </div>
        <div className="ud-health-copy">
          <span className="ud-health-project-name">{project.name || 'Your project'}</span>
          <div className="ud-health-row">
            <span className="ud-health-num">{score !== null ? score : '—'}</span>
            <span className="ud-health-denom">/100</span>
            {health && (
              <span className="ud-health-badge" style={{ background: bandBg, color: bandColor }}>{label}</span>
            )}
          </div>
          {!health && <span className="ud-health-loading">Computing…</span>}
        </div>
      </div>
    </section>
  )
}

export default function MainDashboard() {
  const navigate = useNavigate()
  const { auth } = useAuth()
  const prefersReducedMotion = useReducedMotion()
  const [menuOpen, setMenuOpen] = useState(false)
  const [savedDraft] = useState(readDraft)
  const [idea, setIdea] = useState(savedDraft?.idea ?? '')
  const [intent, setIntent] = useState(savedDraft?.projectType ?? 'Startup')
  const [attachment, setAttachment] = useState(savedDraft?.attachment ?? null)
  const [attachmentNotice, setAttachmentNotice] = useState('')
  const [submission, setSubmission] = useState({ phase: 'idle', message: '', payload: null, geometry: null })
  const fileInput = useRef(null)
  const launchButton = useRef(null)
  const flightGuard = useRef(false)
  const flightPayload = useRef(null)
  const launching = submission.phase === 'flying'

  useEffect(() => () => { flightGuard.current = false; flightPayload.current = null }, [])

  async function addAttachment(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!/\.(txt|md)$/i.test(file.name) || file.size > 256 * 1024) {
      setAttachmentNotice('Attach a .txt or .md file smaller than 256 KB.')
      return
    }
    try {
      const text = await file.text()
      setAttachment({ name: file.name, text: text.slice(0, 20000) })
      setAttachmentNotice('')
    } catch {
      setAttachmentNotice('This file could not be read. Try another text or Markdown file.')
    }
  }

  function launch(event) {
    event.preventDefault()
    if (flightGuard.current || launching) return
    if (!idea.trim()) {
      setSubmission({ phase: 'error', message: 'Add a few words about your idea to get started.', payload: null, geometry: null })
      document.getElementById('idea-input-field')?.focus()
      return
    }
    setSubmission({ phase: 'idle', message: '', payload: null, geometry: null })
    const rect = launchButton.current?.getBoundingClientRect()
    const origin = rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: window.innerWidth * .72, y: window.innerHeight * .8 }
    const projectId = savedDraft?.projectId || newUuid()
    const payload = { ...savedDraft, projectId, idea: idea.trim(), projectType: intent, attachment }
    flightGuard.current = true
    flightPayload.current = payload
    sessionStorage.setItem(draftKey, JSON.stringify(payload))
    localStorage.setItem(draftKey, JSON.stringify(payload))
    saveProjectDraft(payload, savedDraft?.understanding || { project_name: '', problem_statement: '', target_users: '', expected_outcome: '' }, savedDraft?.workflow || {}, 'understanding').catch(() => {})
    setSubmission({ phase: 'flying', message: '', payload, geometry: flightGeometry(origin, window.innerWidth, window.innerHeight) })
  }

  function completeFlight() {
    const payload = flightPayload.current
    if (!flightGuard.current || !payload) return
    flightGuard.current = false
    sessionStorage.setItem(draftKey, JSON.stringify(payload))
    localStorage.setItem(draftKey, JSON.stringify(payload))
    navigate('/projects/new/setup', { state: { projectId: payload.projectId, idea: payload.idea, projectType: payload.projectType } })
  }

  return <div className={`ud-dashboard ${launching ? 'is-launching' : ''}`} id="overview">
    <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} activePage="overview" />
    <div className="ud-work-area">
      <motion.div className="ud-launch-content" animate={launching ? { opacity: 0, y: -12, scale: 0.995 } : { opacity: 1, y: 0, scale: 1 }} transition={{ duration: prefersReducedMotion ? 0.14 : 0.92, ease: [0.4, 0, 0.2, 1] }}>
      <header className="ud-topbar"><div className="ud-topbar-left"><button className="ud-mobile-menu ud-icon-button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={20} /></button><span className="ud-topbar-title">My workspace</span></div><div className="ud-topbar-actions"><label className="ud-search"><Search size={16} /><input placeholder="Search projects" aria-label="Search projects" /></label><button className="ud-icon-button" aria-label="Notifications"><Bell size={18} /></button><span className="ud-avatar ud-top-avatar">TS</span></div></header>
      <main className="ud-main"><div className="ud-content ud-home-content">
        {!auth.loading && !auth.authenticated && <aside className="ud-github-onboarding"><Github size={16} /><span><b>Personalize your project team</b><small>Connect GitHub to save your developer profile and get evidence-aware task suggestions.</small></span><Link to="/profile">Continue with GitHub <ArrowRight size={14} /></Link></aside>}
        <section className="ud-home-hero" aria-labelledby="welcome-title"><span className="ud-welcome-mark"><Sparkles size={19} /></span><p className="ud-welcome-overline">A little idea can go a long way</p><h1 id="welcome-title">What are you dreaming of building?</h1><p className="ud-welcome-subtitle">Describe your idea. UDAAN will help you turn it into a plan.</p>
          <form className="ud-idea-form" onSubmit={launch} noValidate><label className="ud-sr-only" htmlFor="idea-input-field">Describe your idea</label><textarea id="idea-input-field" rows={5} value={idea} onChange={event => { setIdea(event.target.value); if (submission.phase === 'error') setSubmission({ phase: 'idle', message: '', payload: null, geometry: null }) }} placeholder="I want to build something that..." disabled={launching} />
            <div className="ud-form-bottom"><div className="ud-form-tools"><div className="ud-type-selector" role="group" aria-label="Project type">{['Startup', 'Hackathon', 'College Project', 'Personal Project'].map((type, index) => { const Icon = [BriefcaseBusiness, Rocket, GraduationCap, Lightbulb][index]; return <button key={type} type="button" className={intent === type ? 'selected' : ''} aria-pressed={intent === type} onClick={() => setIntent(type)} disabled={launching}><Icon size={14} />{type}</button> })}</div>
              <input className="ud-sr-only" ref={fileInput} type="file" accept=".txt,.md,text/plain,text/markdown" onChange={addAttachment} disabled={launching} />
              {attachment ? <span className="ud-attached-file"><Paperclip size={14} /><span>{attachment.name}</span><small>Text will be included with your analysis request</small><button type="button" onClick={() => setAttachment(null)} disabled={launching} aria-label="Remove attachment"><X size={14} /></button></span> : <button className="ud-attach-button" type="button" onClick={() => fileInput.current?.click()} disabled={launching}><Paperclip size={15} />Attach a .txt or .md file</button>}
            </div><button ref={launchButton} className="ud-launch-button" type="submit" disabled={launching} aria-busy={launching}>{launching ? <><span className="ud-spinner" />Taking off...</> : <>Launch My Idea <ArrowRight size={17} /></>}</button></div>
            {submission.phase === 'error' && <p className="ud-form-message is-error" role="alert">{submission.message}</p>}{attachmentNotice && <p className="ud-form-message" role="status">{attachmentNotice}</p>}
          </form>
        </section>
        <section className="ud-inspiration"><div className="ud-simple-section-heading"><h2>Need inspiration?</h2><span>Pick one to get started</span></div><div className="ud-example-list">{ideas.map(([icon, title, description]) => <button className="ud-example" key={title} disabled={launching} onClick={() => { setIdea(`${title}. ${description}`); setSubmission({ phase: 'idle', message: '', payload: null, geometry: null }); document.getElementById('idea-input-field')?.focus() }}><span className="ud-example-icon">{icon}</span><span className="ud-example-copy"><strong>{title}</strong><small>{description}</small></span><ArrowRight size={15} className="ud-example-arrow" /></button>)}</div></section>
        <section className="ud-recent"><div className="ud-simple-section-heading"><h2>Your recent projects</h2><Link to="/projects">View all <ArrowRight size={14} /></Link></div><div className="ud-recent-list">{[['E','EcoTrack','Sustainability insights for everyday teams','Startup','green'],['S','Study Buddy','A calmer way to stay on top of coursework','College Project','blue'],['S','Sunday Table','Recipes and meal plans for shared homes','Personal Project','gold']].map(([mark,name,description,type,tone]) => <Link className="ud-recent-row" to="/projects" key={name}><span className={`ud-recent-mark ${tone}`}>{mark}</span><span className="ud-recent-copy"><strong>{name}</strong><small>{description}</small></span><span className="ud-project-type">{type}</span><ArrowRight size={15} className="ud-recent-arrow" /></Link>)}</div></section>
        <HealthWidget />
      </div></main>
      </motion.div>
      {launching && submission.geometry && createPortal(<motion.div className="ud-flight-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: prefersReducedMotion ? 0.08 : 0.2 }} aria-hidden="true">
        {!prefersReducedMotion && <svg className="ud-flight-trail" viewBox={`0 0 ${submission.geometry.width} ${submission.geometry.height}`} preserveAspectRatio="none"><motion.path d={submission.geometry.path} initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: [0, 0.7, 0.22, 0] }} transition={{ duration: 0.96, ease: [0.4, 0, 0.2, 1], opacity: { duration: 0.96, times: [0, 0.3, 0.72, 1] } }} /></svg>}
        <motion.span className="ud-flight-plane" style={{ left: submission.geometry.origin.x - 20, top: submission.geometry.origin.y - 20 }} initial={{ x: 0, y: 0, opacity: 1, scale: 0.86, rotate: submission.geometry.rotate[0] }} animate={prefersReducedMotion ? { opacity: 0, scale: 0.96 } : { x: submission.geometry.x, y: submission.geometry.y, rotate: submission.geometry.rotate, opacity: [1, 1, 0.9, 0], scale: [0.86, 1, 0.98, 0.88] }} transition={{ duration: prefersReducedMotion ? 0.15 : 0.98, ease: [0.4, 0, 0.2, 1], opacity: { duration: prefersReducedMotion ? 0.15 : 0.98, times: [0, 0.34, 0.76, 1] }, scale: { duration: prefersReducedMotion ? 0.15 : 0.98, times: [0, 0.22, 0.72, 1] } }} onAnimationComplete={completeFlight}><Send size={30} strokeWidth={1.5} /></motion.span>
      </motion.div>, document.body)}
    </div>
  </div>
}
