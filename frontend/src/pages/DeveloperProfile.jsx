import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Github, RefreshCw, Save, ShieldCheck, Sparkles, UserRound, Menu, AlertCircle, Check } from 'lucide-react'
import Sidebar from '../layouts/Sidebar.jsx'
import { useAuth } from '../app/AuthContext.jsx'
import { getDeveloperProfile, startGitHubLogin, updateDeveloperProfile } from '../services/authService.js'
import { readSavedProjects } from '../services/projectStorage.js'
import './DeveloperProfile.css'

export default function DeveloperProfile() {
  const { auth, refresh } = useAuth()
  const [query, setQuery] = useSearchParams()
  const [profile, setProfile] = useState(null)
  const [form, setForm] = useState({ skills: '', experience: '', preferred_roles: '', availability_hours: 10, learning_goals: '' })
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState(query.get('github') === 'connected' ? 'GitHub is connected. Review your developer profile below.' : '')
  useEffect(() => {
    const errors = { cancelled: 'GitHub sign-in was cancelled.', invalid_state: 'The sign-in session expired. Start GitHub sign-in again.', not_configured: 'GitHub OAuth is not configured on this server.', token_error: 'GitHub could not exchange the sign-in code.', provider_error: 'GitHub profile information could not be retrieved.', account_link_error: 'That GitHub identity is already linked to a different UDAAN account.', account_error: 'UDAAN could not finish connecting the account.' }
    if (errors[query.get('github')]) setError(errors[query.get('github')])
  }, [])
  useEffect(() => {
    if (query.has('github')) { const next = new URLSearchParams(query); next.delete('github'); setQuery(next, { replace: true }); void refresh() }
  }, [])
  useEffect(() => {
    if (!auth.authenticated) return
    let active = true
    void getDeveloperProfile().then(data => {
      if (!active) return
      setProfile(data)
      setForm({ skills: (data.skills || []).join(', '), experience: data.experience || '', preferred_roles: (data.preferred_roles || []).join(', '), availability_hours: data.availability_hours ?? 10, learning_goals: data.learning_goals || '' })
    }).catch(err => { if (active && err.status !== 404) setError(err.message) })
    return () => { active = false }
  }, [auth.authenticated])
  const login = async refreshAnalysis => {
    setBusy(true); setError('')
    try { window.location.assign(await startGitHubLogin({ refresh: refreshAnalysis, returnTo: query.get('return_to') || '/profile', projectIds: readSavedProjects().map(project => project.id) })) }
    catch (err) { setError(err.message || 'GitHub sign-in is unavailable.'); setBusy(false) }
  }
  const save = async event => {
    event.preventDefault(); setBusy(true); setError(''); setNotice('')
    try {
      const updated = await updateDeveloperProfile({ skills: form.skills.split(',').map(item => item.trim()).filter(Boolean), experience: form.experience,
        preferred_roles: form.preferred_roles.split(',').map(item => item.trim()).filter(Boolean), availability_hours: Number(form.availability_hours), learning_goals: form.learning_goals })
      setProfile(updated); setNotice('Your developer profile was saved.')
    } catch (err) { setError(err.message || 'Could not save your profile.') }
    finally { setBusy(false) }
  }
  const setField = (key, value) => setForm(current => ({ ...current, [key]: value }))
  return <div className="ud-dashboard dp-page"><Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} /><div className="ud-work-area">
    <header className="ud-topbar"><div className="ud-topbar-left"><button className="ud-mobile-menu ud-icon-button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={20} /></button><span className="dp-crumb">Workspace <span>/</span> <b>Developer profile</b></span></div></header>
    <main className="ud-main"><div className="dp-content"><div className="dp-heading"><span className="dp-eyebrow"><UserRound size={15} /> YOUR DEVELOPER PROFILE</span><h1>Bring your experience to the team</h1><p>Use repository evidence and your own context to make better task suggestions. GitHub identity alone is not a skills assessment.</p></div>
      {error && <div className="dp-alert" role="alert"><AlertCircle size={16} />{error}</div>}{notice && <div className="dp-notice" role="status"><Check size={16} />{notice}</div>}
      {!auth.authenticated ? <section className="dp-connect"><span className="dp-connect-icon"><Github size={25} /></span><div><span className="dp-eyebrow">SECURE SIGN IN</span><h2>Continue with GitHub</h2><p>UDAAN uses GitHub OAuth to verify your account and, with your authorization, inspect public repository metadata. OAuth tokens are used server-side and are not stored.</p><button className="dp-primary" disabled={busy || !auth.github_configured} onClick={() => void login(false)}><Github size={16} />{busy ? 'Connecting…' : 'Continue with GitHub'}</button>{!auth.github_configured && <small>GitHub OAuth is not configured on this server yet.</small>}</div></section> : profile && <>
        <section className="dp-evidence"><div className="dp-evidence-head"><div className="dp-avatar">{profile.avatar_url ? <img src={profile.avatar_url} alt="" /> : <Github size={19} />}</div><div><b>@{profile.github_login}</b><a href={profile.profile_url} target="_blank" rel="noreferrer">View GitHub profile</a></div><span className="dp-state"><ShieldCheck size={14} />{profile.analysis_status === 'complete' ? 'Public profile analyzed' : profile.analysis_status === 'partial' ? 'Partial repository evidence' : 'Repository access unavailable'}</span><button className="dp-secondary" onClick={() => void login(true)} disabled={busy}><RefreshCw size={14} /> Refresh analysis</button></div>
          <p>Repository language metadata suggests exposure; it does not prove proficiency. Private repositories are not accessed.</p><div className="dp-evidence-grid"><div><span>Technologies detected</span><div className="dp-chip-list">{profile.technologies?.length ? profile.technologies.map(item => <span key={item.name}>{item.name} <small>{item.evidence_count} repo{item.evidence_count === 1 ? '' : 's'}</small></span>) : <small>No public repository languages were available.</small>}</div></div><div><span>Public repository evidence</span>{profile.public_repositories?.length ? <ul>{profile.public_repositories.slice(0, 6).map(repo => <li key={repo.name}><a href={repo.url} target="_blank" rel="noreferrer">{repo.name}</a>{repo.description && <small>{repo.description}</small>}{repo.evidence_paths?.length > 0 && <small>Inspected paths: {repo.evidence_paths.join(', ')}</small>}</li>)}</ul> : <small>No public repositories found. You can use self-declared skills below.</small>}</div></div>
        </section>
        <form className="dp-form" onSubmit={save}><div className="dp-form-head"><div><span className="dp-eyebrow"><Sparkles size={14} /> PROFILE DETAILS</span><h2>Review and edit your profile</h2><p>Only shared within projects where you are an authorized member.</p></div></div>
          <label>Skills you want teams to consider <small>Comma-separated; edit repository-derived suggestions as needed.</small><input value={form.skills} onChange={e => setField('skills', e.target.value)} placeholder="React, API design, testing" /></label>
          <div className="dp-two-col"><label>Preferred roles<input value={form.preferred_roles} onChange={e => setField('preferred_roles', e.target.value)} placeholder="Frontend, backend, research" /></label><label>Available hours per week<input type="number" min="1" max="80" value={form.availability_hours} onChange={e => setField('availability_hours', e.target.value)} /></label></div>
          <label>Experience and context<textarea rows="4" maxLength="4000" value={form.experience} onChange={e => setField('experience', e.target.value)} placeholder="Relevant work, coursework, or experience you want considered." /></label>
          <label>Learning goals<textarea rows="3" maxLength="2000" value={form.learning_goals} onChange={e => setField('learning_goals', e.target.value)} placeholder="Skills or responsibilities you would like to practice." /></label>
          <div className="dp-footer"><small>GitHub sign-in confirms identity, not technical proficiency. Missing evidence is treated as unknown.</small><button className="dp-primary" disabled={busy}><Save size={15} />{busy ? 'Saving…' : 'Save profile'}</button></div>
        </form>
      </>}
    </div></main>
  </div></div>
}
