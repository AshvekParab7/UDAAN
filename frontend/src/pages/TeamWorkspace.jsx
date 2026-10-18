import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, Check, ChevronDown, Clock3, Copy, Filter, Mail, Menu, Plus, RefreshCw, Save, Send, Users, X } from 'lucide-react'
import Sidebar from '../layouts/Sidebar.jsx'
import { readSavedProjects, updateSavedProject } from '../services/projectStorage.js'
import { applyRoadmapSync, createTeamInvitations, getTeamWorkspace, manageTeamInvitation, previewRoadmapSync, removeTeamMember, updateTeamMember, updateTeamSize, updateTeamTask } from '../services/teamService.js'

const statusLabels = { not_started: 'Not Started', in_progress: 'In Progress', blocked: 'Blocked', completed: 'Completed' }
const priorityLabels = { high: 'High', medium: 'Medium', low: 'Low' }

function MemberCard({ member, onSave, onRemove }) {
  const [form, setForm] = useState({ name: member.name || '', email: member.email || '', role: member.role || '', skills: (member.skills || []).join(', ') })
  useEffect(() => setForm({ name: member.name || '', email: member.email || '', role: member.role || '', skills: (member.skills || []).join(', ') }), [member])
  const save = () => onSave(member.id, { ...form, skills: form.skills.split(',').map(x => x.trim()).filter(Boolean) })
  return <article className="tw-live-member">
    <div className="tw-live-member-heading"><span className="tw-slot-number">{String(member.slot).padStart(2, '0')}</span><div><b>{member.display_name}</b><small>{member.is_creator ? 'Project creator' : `Member slot ${member.slot}`}</small></div></div>
    <div className="tw-member-fields">
      <label>Name<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder={member.is_creator ? 'Your name (optional)' : 'Unassigned'} /></label>
      <label>Email<input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="Email (optional)" /></label>
      <label>Role<input value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} placeholder="Role" /></label>
      <label>Skills<input value={form.skills} onChange={e => setForm({ ...form, skills: e.target.value })} placeholder="React, research, ..." /></label>
    </div>
    <div className="tw-member-stats"><span><b>{member.task_count}</b> tasks</span><span><b>{member.workload_hours}h</b> estimated</span><span><b>{member.progress}%</b> complete</span></div>
    <div className="tw-work-meter"><i style={{ width: `${Math.min(member.workload_hours / 40 * 100, 100)}%` }} /></div>
    <div className="tw-member-actions"><button className="tw-live-save" onClick={save}><Save size={14} /> Save member</button>{!member.is_creator && <button className="tw-member-remove" onClick={() => onRemove(member)}>Remove</button>}</div>
  </article>
}

function TaskEditor({ task, members, onClose, onSave }) {
  const [form, setForm] = useState({ ...task, dependencies: (task.dependencies || []).join('\n'), required_skills: (task.required_skills || []).join(', ') })
  if (!task) return null
  const field = (key, value) => setForm(prev => ({ ...prev, [key]: value }))
  return <div className="tw-modal-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><section className="tw-task-modal" role="dialog" aria-modal="true" aria-labelledby="tw-task-title">
    <div className="tw-modal-head"><div><span>ROADMAP TASK</span><h2 id="tw-task-title">Edit task</h2></div><button onClick={onClose} aria-label="Close"><X size={18} /></button></div>
    <label>Title<input value={form.title} onChange={e => field('title', e.target.value)} /></label>
    <label>Description<textarea rows="3" value={form.description} onChange={e => field('description', e.target.value)} placeholder="What needs to be done?" /></label>
    <div className="tw-modal-grid"><label>Owner<select value={form.assigned_to || ''} onChange={e => field('assigned_to', e.target.value ? Number(e.target.value) : null)}><option value="">Unassigned</option>{members.map(m => <option value={m.id} key={m.id}>{m.display_name}</option>)}</select></label><label>Milestone<input value={form.milestone} onChange={e => field('milestone', e.target.value)} /></label>
      <label>Priority<select value={form.priority} onChange={e => field('priority', e.target.value)}>{Object.entries(priorityLabels).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label><label>Status<select value={form.status} onChange={e => field('status', e.target.value)}>{Object.entries(statusLabels).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <label>Effort (hours)<input type="number" min="0.1" step="0.5" value={form.effort_hours} onChange={e => field('effort_hours', Number(e.target.value))} /></label><label>Deadline<input type="date" value={form.deadline || ''} onChange={e => field('deadline', e.target.value || null)} /></label></div>
    <label>Dependencies <small>One prerequisite task title per line</small><textarea rows="2" value={form.dependencies} onChange={e => field('dependencies', e.target.value)} /></label>
    <label>Deliverable / completion criteria<textarea rows="2" value={form.deliverable} onChange={e => field('deliverable', e.target.value)} /></label>
    <label>Relevant skills<input value={form.required_skills} onChange={e => field('required_skills', e.target.value)} /></label>
    <footer><button className="tw-modal-cancel" onClick={onClose}>Cancel</button><button className="tw-modal-save" onClick={() => onSave({ ...form, dependencies: form.dependencies.split('\n').map(x => x.trim()).filter(Boolean), required_skills: form.required_skills.split(',').map(x => x.trim()).filter(Boolean), effort_hours: Number(form.effort_hours) })}><Check size={15} /> Save task</button></footer>
  </section></div>
}

function InviteMembersModal({ onClose, onSubmit, remaining, busy }) {
  const makeRow = () => ({ email: '', name: '', role: '', skills: '' })
  const [rows, setRows] = useState([makeRow()])
  const [error, setError] = useState('')
  const update = (index, key, value) => setRows(current => current.map((row, i) => i === index ? { ...row, [key]: value } : row))
  const submit = async event => {
    event.preventDefault(); setError('')
    const emails = rows.map(row => row.email.trim().toLowerCase())
    if (new Set(emails).size !== emails.length) { setError('Use a different email address for each person.'); return }
    try { await onSubmit(rows.map(row => ({ ...row, skills: row.skills.split(',').map(skill => skill.trim()).filter(Boolean) }))) }
    catch (err) { setError(err.message || 'Could not create invitations.') }
  }
  return <div className="tw-modal-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><form className="tw-invite-modal" onSubmit={submit}>
    <div className="tw-modal-head"><div><span>TEAM WORKSPACE</span><h2>Invite members</h2><p>{remaining} invitation slot{remaining === 1 ? '' : 's'} remaining in team capacity.</p></div><button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
    <div className="tw-invite-rows">{rows.map((row, index) => <fieldset key={index}><legend>Person {index + 1}</legend><label>Email address *<input type="email" required value={row.email} onChange={e => update(index, 'email', e.target.value)} placeholder="name@example.com" /></label><div className="tw-modal-grid"><label>Name (optional)<input value={row.name} onChange={e => update(index, 'name', e.target.value)} /></label><label>Role (optional)<input value={row.role} onChange={e => update(index, 'role', e.target.value)} /></label></div><label>Skills (optional)<input value={row.skills} onChange={e => update(index, 'skills', e.target.value)} placeholder="React, research, design" /></label>{rows.length > 1 && <button type="button" className="tw-remove-invitee" onClick={() => setRows(current => current.filter((_, i) => i !== index))}>Remove person</button>}</fieldset>)}</div>
    {rows.length < remaining && <button type="button" className="tw-add-invitee" onClick={() => setRows(current => [...current, makeRow()])}><Plus size={14} /> Add another person</button>}
    {error && <p className="tw-invite-error" role="alert">{error}</p>}
    <footer><button type="button" className="tw-modal-cancel" onClick={onClose}>Cancel</button><button type="submit" className="tw-modal-save" disabled={busy || rows.length > remaining}>{busy ? 'Creating…' : <><Send size={14} /> Send invitation{rows.length > 1 ? 's' : ''}</>}</button></footer>
  </form></div>
}

export default function TeamWorkspace() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [searchParams] = useSearchParams()
  const projects = readSavedProjects()
  const [projectId, setProjectId] = useState(() => searchParams.get('project') || localStorage.getItem('udaan:selected-project') || projects[0]?.id || '')
  const [workspace, setWorkspace] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState({ member: '', priority: '', status: '', milestone: '', query: '' })
  const [selectedTask, setSelectedTask] = useState(null)
  const [roadmapChanges, setRoadmapChanges] = useState(null)
  const [teamSize, setTeamSize] = useState(1)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteBusy, setInviteBusy] = useState(false)
  const [invitationLinks, setInvitationLinks] = useState({})

  const loadWorkspace = useCallback(async () => {
    if (!projectId) { setWorkspace(null); return }
    setLoading(true); setError('')
    try {
      const data = await getTeamWorkspace(projectId)
      setWorkspace(data); setTeamSize(data.project.team_size || 1)
      const preview = await previewRoadmapSync(projectId)
      if (preview.requires_confirmation) setRoadmapChanges(preview.changes)
      else setRoadmapChanges(null)
    } catch (err) { setError(err.message || 'Could not load this project workspace.') }
    finally { setLoading(false) }
  }, [projectId])
  useEffect(() => { void loadWorkspace() }, [loadWorkspace])

  const refresh = async (message = '') => { await loadWorkspace(); if (message) setNotice(message) }
  const saveMember = async (id, data) => { try { await updateTeamMember(projectId, id, data); await refresh('Member details saved.') } catch (err) { setError(err.message) } }
  const removeMember = async member => { if (!window.confirm(`Remove ${member.display_name} from this project?`)) return; try { await removeTeamMember(projectId, member.id); await refresh('Member removed.') } catch (err) { setError(err.assigned_tasks?.length ? `Reassign ${err.assigned_tasks.map(task => task.title).join(', ')} before removing this member.` : err.message) } }
  const saveTask = async data => { try { await updateTeamTask(projectId, selectedTask.id, data); setSelectedTask(null); await refresh('Task updated.') } catch (err) { setError(err.message) } }
  const sendInvitations = async invitees => {
    setInviteBusy(true); setError('')
    try {
      const response = await createTeamInvitations(projectId, invitees)
      setInvitationLinks(current => ({ ...current, ...Object.fromEntries(response.invitations.map(invite => [invite.id, invite])) }))
      setInviteOpen(false)
      const sentCount = response.invitations.filter(invite => invite.delivery === 'sent').length
      const failedCount = response.invitations.filter(invite => invite.delivery === 'failed').length
      setNotice(sentCount === response.invitations.length ? 'Invitation emails sent.' : failedCount ? `Email delivery failed for ${failedCount} invitation(s). Copy and share the secure link(s).` : sentCount ? `Emailed ${sentCount}; copy the links for invitations not delivered by email.` : 'Invitation records are ready. Email delivery is not configured; copy and share each secure invitation link.')
      await loadWorkspace()
    } catch (err) { setError(err.message || 'Could not create invitations.'); throw err }
    finally { setInviteBusy(false) }
  }
  const invitationAction = async (invitation, action) => {
    try {
      const response = await manageTeamInvitation(projectId, invitation.id, action)
      if (action === 'resend') setInvitationLinks(current => ({ ...current, [invitation.id]: response }))
      await refresh(action === 'cancel' ? 'Invitation cancelled.' : response.delivery === 'sent' ? 'Invitation email sent.' : 'Invitation renewed. Copy and share the new secure link.')
    } catch (err) { setError(err.message) }
  }
  const copyInvitationLink = async link => {
    try { await navigator.clipboard.writeText(link); setNotice('Invitation link copied.') }
    catch { setNotice(`Copy this invitation link: ${link}`) }
  }
  const changeSize = async () => {
    try { const result = await updateTeamSize(projectId, teamSize); setWorkspace(current => ({ ...current, members: result.members, project: { ...current.project, team_size: result.team_size } })); updateSavedProject(projectId, { teamSize: result.team_size }); setNotice('Team size updated.') }
    catch (err) { if (err.status === 409 && err.assigned_tasks) setError(`Reassign ${err.assigned_tasks.map(t => t.title).join(', ')} before removing those member slots.`); else setError(err.message) }
  }
  const reconcileRoadmap = async () => { try { await applyRoadmapSync(projectId); setRoadmapChanges(null); await refresh('Roadmap changes reviewed and synced. Existing task progress and assignments were preserved where possible.') } catch (err) { setError(err.message) } }
  const members = workspace?.members || []
  const tasks = workspace?.tasks || []
  const visibleTasks = useMemo(() => tasks.filter(task => (!filters.member || String(task.assigned_to || '') === filters.member) && (!filters.priority || task.priority === filters.priority) && (!filters.status || task.status === filters.status) && (!filters.milestone || task.milestone === filters.milestone) && `${task.title} ${task.description} ${task.milestone}`.toLowerCase().includes(filters.query.toLowerCase())), [tasks, filters])
  const assigned = tasks.filter(t => t.assigned_to).length
  const completed = tasks.filter(t => t.status === 'completed').length
  const totalHours = tasks.reduce((sum, t) => sum + t.effort_hours, 0)
  const milestones = [...new Set(tasks.map(t => t.milestone).filter(Boolean))]
  const invitations = workspace?.invitations || []
  const pendingInvitations = invitations.filter(invite => invite.status === 'pending')
  const remainingCapacity = workspace?.project.remaining_capacity ?? Math.max(0, teamSize - members.length - pendingInvitations.length)

  return <div className="ud-dashboard tw-page"><Sidebar activePage="team" open={menuOpen} onClose={() => setMenuOpen(false)} /><div className="ud-work-area">
    <header className="ud-topbar"><div className="ud-topbar-left"><button className="ud-mobile-menu ud-icon-button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={20} /></button><span className="tw-breadcrumb">Workspace <span>/</span> <b>Team</b></span></div><div className="ud-topbar-actions"><button className="tw-refresh" onClick={() => void loadWorkspace()} disabled={loading}><RefreshCw size={15} /> Refresh</button></div></header>
    <main className="ud-main tw-main"><div className="tw-content">
      <section className="tw-live-heading"><div><span className="tw-live-eyebrow"><Users size={15} /> TEAM WORKSPACE</span><h1>{workspace?.project.name || 'Your project team'}</h1><p>Coordinate the people, workload, and roadmap tasks for this project.</p></div>{projects.length > 0 && <label className="tw-project-select">Project<select value={projectId} onChange={e => { setProjectId(e.target.value); setRoadmapChanges(null) }}>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><ChevronDown size={15} /></label>}</section>
      {error && <div className="tw-live-alert" role="alert"><AlertTriangle size={16} />{error}<button onClick={() => setError('')} aria-label="Dismiss"><X size={15} /></button></div>}
      {notice && <div className="tw-live-notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss"><X size={15} /></button></div>}
      {roadmapChanges && <section className="tw-roadmap-review"><div><b>Flight Plan changes need review</b><p>{roadmapChanges.new.length} new · {roadmapChanges.modified.length} changed · {roadmapChanges.removed.length} removed. Applying updates keeps existing assignments and task progress wherever tasks still match.</p><div className="tw-change-details">{[['New', roadmapChanges.new], ['Changed', roadmapChanges.modified], ['Removed', roadmapChanges.removed]].filter(([, rows]) => rows.length).map(([label, rows]) => <p key={label}><strong>{label}:</strong> {rows.map(row => `${row.milestone} / ${row.title}`).join(' · ')}</p>)}</div></div><button onClick={reconcileRoadmap}>Apply reviewed changes</button></section>}
      {!projectId ? <div className="tw-live-empty"><Users size={25} /><h2>No projects yet</h2><p>Create a project and Flight Plan first. Your team slots and tasks will appear here.</p></div> : loading && !workspace ? <div className="tw-live-empty">Loading project workspace…</div> : workspace && <>
        <section className="tw-overview-grid"><article><span>Joined members</span><strong>{members.length}<small> / {workspace.project.team_size}</small></strong><small>{pendingInvitations.length} pending invitation{pendingInvitations.length === 1 ? '' : 's'}</small></article><article><span>Assigned tasks</span><strong>{assigned}<small> / {tasks.length}</small></strong><small>{tasks.length - assigned} unassigned</small></article><article><span>Completed</span><strong>{completed}<small> / {tasks.length}</small></strong><small>{tasks.length ? Math.round(completed / tasks.length * 100) : 0}% of roadmap tasks</small></article><article><span>Estimated workload</span><strong>{totalHours}<small>h</small></strong><small>Across all active tasks</small></article></section>
        <section className="tw-members-panel"><div className="tw-live-section-head"><div><span className="tw-live-eyebrow">PEOPLE</span><h2>Team members</h2></div><div className="tw-team-actions"><span className="tw-capacity-copy">{members.length} of {workspace.project.team_size} members joined · {remainingCapacity} capacity remaining</span><div className="tw-size-control"><label>Capacity<input type="number" min="1" max="50" value={teamSize} onChange={e => setTeamSize(Math.max(1, Number(e.target.value) || 1))} /></label><button onClick={changeSize}>Update</button></div><button className="tw-invite-button" onClick={() => setInviteOpen(true)} disabled={remainingCapacity < 1}><Plus size={16} /> Invite members</button></div></div><p className="tw-panel-hint">Team size sets capacity. Members appear here after accepting a secure invitation.</p>{members.length ? <div className="tw-live-member-grid">{members.map(member => <MemberCard key={member.id} member={member} onSave={saveMember} onRemove={removeMember} />)}</div> : <div className="tw-member-empty"><Users size={18} /><div><b>No joined members yet</b><span>Invite teammates to add them to this workspace. The project creator remains a member.</span></div></div>}</section>
        {pendingInvitations.length > 0 && <section className="tw-pending-panel"><div className="tw-live-section-head"><div><span className="tw-live-eyebrow">INVITATIONS</span><h2>Pending invitations <span>{pendingInvitations.length}</span></h2></div></div><div className="tw-invitation-list">{pendingInvitations.map(invite => { const recent = invitationLinks[invite.id]; return <article className="tw-invitation-row" key={invite.id}><span className="tw-invitation-icon"><Mail size={15} /></span><div className="tw-invitation-person"><b>{invite.name || invite.email}</b><small>{invite.name ? invite.email : invite.role || 'Invitation pending'}{invite.role && invite.name ? ` · ${invite.role}` : ''}</small></div><span className="tw-invitation-status">Pending · expires {new Date(invite.expires_at).toLocaleDateString()}</span>{recent?.invite_link && <button className="tw-invitation-action" onClick={() => void copyInvitationLink(recent.invite_link)}><Copy size={13} /> Copy link</button>}<button className="tw-invitation-action" onClick={() => void invitationAction(invite, 'resend')}>Resend</button><button className="tw-invitation-cancel" onClick={() => void invitationAction(invite, 'cancel')}>Cancel</button></article> })}</div></section>}
        {invitations.some(invite => ['declined', 'expired'].includes(invite.status)) && <section className="tw-invite-history"><span>Invitation history</span>{invitations.filter(invite => ['declined', 'expired'].includes(invite.status)).map(invite => <small key={invite.id}>{invite.email} · {invite.status}</small>)}</section>}
        <section className="tw-task-panel"><div className="tw-live-section-head"><div><span className="tw-live-eyebrow">FLIGHT PLAN</span><h2>Roadmap tasks <span>{tasks.length}</span></h2></div><span className="tw-task-count-icon"><Filter size={15} /> Filter tasks</span></div>
          <div className="tw-live-filters"><input placeholder="Search tasks" value={filters.query} onChange={e => setFilters({ ...filters, query: e.target.value })} /><select value={filters.member} onChange={e => setFilters({ ...filters, member: e.target.value })}><option value="">All members</option>{members.map(m => <option value={m.id} key={m.id}>{m.display_name}</option>)}</select><select value={filters.priority} onChange={e => setFilters({ ...filters, priority: e.target.value })}><option value="">All priorities</option>{Object.entries(priorityLabels).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select><select value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}><option value="">All statuses</option>{Object.entries(statusLabels).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select><select value={filters.milestone} onChange={e => setFilters({ ...filters, milestone: e.target.value })}><option value="">All milestones</option>{milestones.map(m => <option key={m}>{m}</option>)}</select></div>
          {tasks.length === 0 ? <div className="tw-task-empty"><Clock3 size={20} /><b>{workspace.project.has_roadmap ? 'No tasks have been allocated yet' : 'No Flight Plan yet'}</b><span>{workspace.project.has_roadmap ? 'Refresh to sync tasks from the current roadmap.' : 'Add a roadmap in Flight Plan, then return here to assign its tasks.'}</span></div> : <div className="tw-live-task-list">{visibleTasks.map(task => <button className="tw-live-task" key={task.id} onClick={() => setSelectedTask(task)}><span className={`tw-task-priority-dot ${task.priority}`} /><div className="tw-live-task-main"><b>{task.title}</b><small>{task.milestone || 'Roadmap task'} · {task.effort_hours}h{task.deadline ? ` · Due ${task.deadline}` : ''}</small></div><span className="tw-live-assignee">{members.find(m => m.id === task.assigned_to)?.display_name || 'Unassigned'}</span><span className={`tw-live-status ${task.status}`}>{statusLabels[task.status]}</span><span className="tw-task-open">Edit</span></button>)}</div>}
          {tasks.some(t => !t.assigned_to) && <div className="tw-unassigned"><div><b>Unassigned tasks</b><span>{tasks.filter(t => !t.assigned_to).length} tasks need an owner</span></div><div className="tw-unassigned-list">{tasks.filter(t => !t.assigned_to).map(task => <button key={task.id} onClick={() => setSelectedTask(task)}>{task.title} <span>Assign</span></button>)}</div></div>}
        </section>
        <section className="tw-load-panel"><div className="tw-live-section-head"><div><span className="tw-live-eyebrow">CAPACITY</span><h2>Workload overview</h2></div></div><div className="tw-workload-list">{members.map(m => { const percent = totalHours ? Math.round(m.workload_hours / totalHours * 100) : 0; const state = !m.workload_hours ? 'No assigned work' : m.workload_hours > 40 ? 'High workload' : m.workload_hours < 6 ? 'Underutilised' : 'Balanced'; return <div className="tw-workload-row" key={m.id}><span>{m.display_name}</span><div className="tw-workload-track"><i style={{ width: `${Math.min(percent, 100)}%` }} /></div><b>{m.workload_hours}h</b><small>{state}</small></div> })}</div></section>
      </>}
    </div></main>
    {selectedTask && <TaskEditor task={selectedTask} members={members} onClose={() => setSelectedTask(null)} onSave={saveTask} />}
    {inviteOpen && <InviteMembersModal remaining={remainingCapacity} busy={inviteBusy} onClose={() => setInviteOpen(false)} onSubmit={sendInvitations} />}
  </div></div>
}
