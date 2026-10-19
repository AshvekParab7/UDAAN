import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Check, CircleX, LoaderCircle, Users } from 'lucide-react'
import { getPublicTeamInvitation, respondToTeamInvitation } from '../services/teamService.js'
import { fetchProjectDraft } from '../services/ideaWorkflowService.js'
import { saveIdeaProject } from '../services/projectStorage.js'

export default function TeamInvitationAccept() {
  const { token } = useParams()
  const navigate = useNavigate()
  const [invitation, setInvitation] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')

  useEffect(() => {
    let active = true
    getPublicTeamInvitation(token).then(data => { if (active) setInvitation(data) }).catch(err => { if (active) setError(err.message || 'This invitation is unavailable or has expired.') })
    return () => { active = false }
  }, [token])

  const respond = async decision => {
    setBusy(true); setError('')
    try {
      const response = await respondToTeamInvitation(token, decision)
      setResult(response.status)
      if (response.status === 'accepted') {
        localStorage.setItem('udaan:selected-project', response.project.id)
        try {
          const draft = await fetchProjectDraft(response.project.id)
          saveIdeaProject({ draft: { projectId: response.project.id, idea: draft.idea, projectType: draft.project_type,
            attachment: draft.attachment, startDate: draft.start_date, deadline: draft.deadline, teamSize: draft.team_size,
            weeklyHours: draft.weekly_hours, scheduleMetadata: draft.schedule_metadata },
            understanding: draft.understanding || {}, workflow: draft.workflow || {} })
        } catch { /* Team Workspace remains available from the accepted invitation link. */ }
        window.setTimeout(() => navigate(`/team?project=${encodeURIComponent(response.project.id)}`), 1000)
      }
    } catch (err) { setError(err.code === 'authentication_required' ? 'Sign in with the invited email using GitHub before accepting this invitation.' : err.message || 'Could not process this invitation.') }
    finally { setBusy(false) }
  }

  return <main className="tw-invite-page"><section className="tw-invite-card">
    <span className="tw-live-eyebrow"><Users size={15} /> UDAAN TEAM INVITATION</span>
    {invitation ? <><h1>Join {invitation.project_name}</h1><p>{invitation.name || 'You'} were invited to join this project team as {invitation.role || 'a team member'}.</p><div className="tw-invite-email">Invitation for <b>{invitation.email}</b></div>{invitation.expires_at && <small className="tw-invite-expiry">Expires {new Date(invitation.expires_at).toLocaleString()}</small>}
      {invitation.status === 'pending' && !result && <div className="tw-invite-actions"><button className="tw-modal-cancel" disabled={busy} onClick={() => void respond('decline')}><CircleX size={15} /> Decline</button><button className="tw-modal-save" disabled={busy} onClick={() => void respond('accept')}>{busy ? <LoaderCircle className="tw-invite-spin" size={15} /> : <Check size={15} />} Accept invitation</button></div>}
      {result === 'accepted' && <div className="tw-invite-success"><Check size={16} /> Invitation accepted. Opening Team Workspace…</div>}{result === 'declined' && <div className="tw-invite-declined">Invitation declined.</div>}
    </> : error ? <><h1>Invitation unavailable</h1><p>{error}</p></> : <><h1>Checking invitation…</h1><p>Please wait while we verify its secure link.</p></>}
    {error && invitation && <><p className="tw-invite-error" role="alert">{error}</p>{error.includes('Sign in') && <Link to={`/login?return_to=${encodeURIComponent(`/team/invite/${token}`)}`}>Continue with GitHub to accept</Link>}</>}
    <Link to="/">Return to UDAAN</Link>
  </section></main>
}
