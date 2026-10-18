import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { AlertCircle, AlertTriangle, ArrowLeft, ArrowRight, BookOpen, Calendar, Check, CheckCircle2, ChevronDown, CircleHelp, ClipboardCheck, Clock, Code2, Compass, FileSearch, FlaskConical, Lightbulb, LoaderCircle, Pencil, Plus, Rocket, Save, ShieldAlert, ShieldCheck, Sparkles, Trash2, UsersRound, X } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import Sidebar from '../layouts/Sidebar.jsx'
import { analyzeIdeaDraft } from '../services/ideaAnalysisService.js'
import { queueIdeaStageGeneration, getIdeaStageGeneration, saveProjectDraft, fetchProjectDraft, generateIdeaStage } from '../services/ideaWorkflowService.js'
import { saveIdeaProject } from '../services/projectStorage.js'
import { hasActionableFlightPlan } from '../services/flightPlanUtils.js'
import { applyRoadmapSync } from '../services/teamService.js'

const draftKey = 'udaan:idea-draft'
function newUuid() { return globalThis.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => { const random = Math.random() * 16 | 0; return (char === 'x' ? random : (random & 3 | 8)).toString(16) }) }
const stages = [
  { key: 'understanding', title: 'Understanding', icon: Sparkles },
  { key: 'research', title: 'Research', icon: FileSearch },
  { key: 'feasibility', title: 'Feasibility', icon: CircleHelp },
  { key: 'launch_timing', title: 'Launch Timing', icon: Calendar },
  { key: 'flight_plan', title: 'Flight Plan', icon: Rocket },
]
const understandingFields = [
  { key: 'project_name', label: 'Project name', placeholder: 'Give your idea a working name', rows: 1 },
  { key: 'problem_statement', label: 'Problem to solve', placeholder: 'What problem are you trying to solve?', rows: 3 },
  { key: 'target_users', label: 'Who it is for', placeholder: 'Who would benefit from this?', rows: 3 },
  { key: 'expected_outcome', label: 'What success looks like', placeholder: 'What would your project help people do?', rows: 3 },
]
function readDraft() {
  try {
    const draft = JSON.parse(sessionStorage.getItem(draftKey) || localStorage.getItem(draftKey) || 'null')
    if (draft && !draft.projectId) {
      draft.projectId = newUuid()
      sessionStorage.setItem(draftKey, JSON.stringify(draft))
      localStorage.setItem(draftKey, JSON.stringify(draft))
    }
    return draft
  } catch { return null }
}
function multiline(items) { return (items || []).join('\n') }
function fromMultiline(value) { return value.split('\n').map(item => item.trim()).filter(Boolean) }
const researchSections = [
  { key: 'market_problem_context', title: 'Market and problem context', icon: BookOpen, kind: 'text' },
  { key: 'existing_solutions_competitors', title: 'Existing solutions and alternatives', icon: FileSearch, kind: 'text' },
  { key: 'commonly_available_features', title: 'Commonly available features', icon: ClipboardCheck, kind: 'list' },
  { key: 'gaps_opportunities', title: 'Gaps and opportunities', icon: Lightbulb, kind: 'list' },
  { key: 'potential_users', title: 'Potential users', icon: UsersRound, kind: 'list' },
  { key: 'research_questions', title: 'Research questions', icon: CircleHelp, kind: 'list', tone: 'questions' },
  { key: 'assumptions_to_verify', title: 'Assumptions to verify', icon: ShieldCheck, kind: 'list', tone: 'assumptions' },
  { key: 'recommended_validation_actions', title: 'Validation actions', icon: FlaskConical, kind: 'list', tone: 'actions' },
  { key: 'preliminary_hypotheses', title: 'Preliminary hypotheses', icon: Lightbulb, kind: 'list', note: 'Unverified starting points' },
  { key: 'sources', title: 'Sources', icon: FileSearch, kind: 'sources' },
  { key: 'evidence_note', title: 'Evidence note', icon: Sparkles, kind: 'text' },
]
const feasibilitySections = [
  { key: 'summary', title: 'Feasibility Summary', icon: Sparkles, kind: 'text', layout: 'summary' },
  { key: 'technical_feasibility', title: 'Technical Feasibility, Architecture and Challenges', icon: Code2, kind: 'text', layout: 'technical' },
  { key: 'advantages', title: 'Advantages', icon: CheckCircle2, kind: 'list', layout: 'advantages' },
  { key: 'limitations', title: 'Limitations', icon: AlertCircle, kind: 'list', layout: 'limitations' },
  { key: 'risks_and_mitigations', title: 'Risks and Mitigations', icon: ShieldAlert, kind: 'risks', layout: 'risks' },
  { key: 'mvp_scope', title: 'MVP Scope', icon: Compass, kind: 'scope', layout: 'scope' },
  { key: 'resources_and_effort', title: 'Resources and Effort', icon: UsersRound, kind: 'text', layout: 'resources' },
  { key: 'validation_checklist', title: 'Validation Checklist', icon: ClipboardCheck, kind: 'list', layout: 'validation' },
  { key: 'market_demand_note', title: 'Market Demand Note', icon: FileSearch, kind: 'text', layout: 'market-demand' },
]
function isHttpUrl(value) {
  try { const parsed = new URL(value); return parsed.protocol === 'http:' || parsed.protocol === 'https:' } catch { return false }
}
function researchEditorValue(section, value) {
  if (section.kind === 'sources') return (value || []).map(source => [source.title || '', source.url || '', source.explanation || ''].join(' | ')).join('\n')
  return section.kind === 'list' ? multiline(value) : value || ''
}
function researchEditorResult(section, value) {
  if (section.kind === 'text') return value
  if (section.kind === 'list') return fromMultiline(value)
  return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const [title = '', url = '', ...explanation] = line.split('|').map(part => part.trim())
    return { title, url, explanation: explanation.join(' | ') }
  })
}
function FeasibilityReportCard({ section, value, onSave }) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const editorRef = useRef(null)
  const Icon = section.icon
  const populated = section.kind === 'text' ? Boolean(value?.trim()) : section.kind === 'list' || section.kind === 'risks' ? Boolean(value?.length) : Boolean(value && (value.essential_features?.length || value.postpone?.length || value.scope_rationale?.trim()))
  useEffect(() => {
    if (!editing || !editorRef.current) return
    editorRef.current.querySelectorAll('textarea').forEach(editor => {
      editor.style.height = 'auto'
      editor.style.height = `${editor.scrollHeight}px`
    })
  }, [editing, editValue])
  function beginEdit() {
    setEditValue(section.kind === 'text' ? value || '' : section.kind === 'list' ? multiline(value) : value || (section.kind === 'scope' ? { essential_features: [], postpone: [], scope_rationale: '' } : []))
    setEditing(true)
  }
  function saveEdit() {
    const next = section.kind === 'list' ? fromMultiline(editValue) : editValue
    onSave(next)
    setEditing(false)
    setEditValue('')
  }
  function updateNested(key, next) { setEditValue(current => ({ ...current, [key]: next })) }
  return <article className={`ud-research-section ud-feasibility-section ${section.layout ? `layout-${section.layout}` : ''}`}>
    <header className="ud-research-section-heading"><span className="ud-research-section-icon"><Icon size={16} /></span><div><h3>{section.title}</h3></div><button type="button" className="ud-research-edit" onClick={() => editing ? (setEditing(false), setEditValue('')) : beginEdit()} aria-label={`${editing ? 'Close editor for' : 'Edit'} ${section.title}`}><Pencil size={13} /> {editing ? 'Close' : 'Edit'}</button></header>
    {editing ? <div className="ud-research-inline-editor ud-feasibility-editor" ref={editorRef}>
      {section.kind === 'text' && <textarea aria-label={`${section.title}, editable content`} value={editValue} onChange={event => setEditValue(event.target.value)} placeholder="Add your notes" />}
      {section.kind === 'list' && <textarea aria-label={`${section.title}, editable items`} value={editValue} onChange={event => setEditValue(event.target.value)} placeholder="One item per line" />}
      {section.kind === 'risks' && <div className="ud-risk-edit-list">{editValue.map((item, index) => <div className="ud-risk-edit-row" key={index}><label><span>Risk</span><input value={item.risk || ''} onChange={event => setEditValue(current => current.map((risk, itemIndex) => itemIndex === index ? { ...risk, risk: event.target.value } : risk))} placeholder="Describe the risk..." /></label><label><span>Mitigation</span><textarea value={item.mitigation || ''} onChange={event => setEditValue(current => current.map((risk, itemIndex) => itemIndex === index ? { ...risk, mitigation: event.target.value } : risk))} placeholder="Mitigation plan..." /></label><button type="button" className="ud-remove-item" aria-label={`Remove risk ${index + 1}`} onClick={() => setEditValue(current => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={14} /></button></div>)}<button type="button" className="ud-add-item" onClick={() => setEditValue(current => [...current, { risk: '', mitigation: '' }])}><Plus size={13} /> Add risk</button></div>}
      {section.kind === 'scope' && <div className="ud-scope-edit-fields"><label><span>Essential features (one per line)</span><textarea value={multiline(editValue.essential_features)} onChange={event => updateNested('essential_features', fromMultiline(event.target.value))} /></label><label><span>Features to postpone (one per line)</span><textarea value={multiline(editValue.postpone)} onChange={event => updateNested('postpone', fromMultiline(event.target.value))} /></label><label><span>Scope rationale</span><textarea value={editValue.scope_rationale || ''} onChange={event => updateNested('scope_rationale', event.target.value)} /></label></div>}
      <div className="ud-research-editor-actions"><button type="button" className="ud-research-cancel" onClick={() => { setEditing(false); setEditValue('') }}><X size={14} /> Cancel</button><button type="button" className="ud-research-save" onClick={saveEdit}><Check size={14} /> Save</button></div>
    </div> : !populated ? <p className="ud-research-empty">No details yet. Use Edit to add content.</p> : section.kind === 'text' ? <p className="ud-research-paragraph">{value}</p> : section.kind === 'list' ? <ul className="ud-research-list">{value.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : section.kind === 'risks' ? <div className="ud-feasibility-risks">{value.map((item, index) => <div className="ud-feasibility-risk" key={`${index}-${item.risk}`}><div className="ud-risk-block"><span className="ud-risk-tag"><AlertTriangle size={11} /> Risk {index + 1}</span><strong className="ud-risk-title">{item.risk}</strong></div>{item.mitigation && <div className="ud-mitigation-block"><span className="ud-mitigation-tag"><ShieldCheck size={11} /> Mitigation Strategy</span><p className="ud-mitigation-text">{item.mitigation}</p></div>}</div>)}</div> : <div className="ud-mvp-scope-content"><section className="ud-scope-col essential"><h4>Essential features</h4>{value.essential_features?.length ? <ul className="ud-research-list">{value.essential_features.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <p className="ud-research-empty">No items yet.</p>}</section><section className="ud-scope-col postpone"><h4>Features to postpone</h4>{value.postpone?.length ? <ul className="ud-research-list">{value.postpone.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <p className="ud-research-empty">No items yet.</p>}</section><section className="ud-mvp-rationale"><h4>Scope rationale</h4><p className="ud-research-paragraph">{value.scope_rationale || 'No rationale yet.'}</p></section></div>}
  </article>
}
const emptyStage = {
  research: { market_problem_context: '', existing_solutions_competitors: '', commonly_available_features: [], gaps_opportunities: [], potential_users: [], research_questions: [], assumptions_to_verify: [], recommended_validation_actions: [], preliminary_hypotheses: [], sources: [], evidence_note: '' },
  feasibility: { summary: '', technical_feasibility: '', advantages: [], limitations: [], risks_and_mitigations: [], mvp_scope: { essential_features: [], postpone: [], scope_rationale: '' }, resources_and_effort: '', validation_checklist: [], market_demand_note: '' },
  flight_plan: { summary: '', milestones: [] },
}
const loadingMessages = { research: 'Exploring the problem and existing solutions...', feasibility: 'Evaluating technical feasibility and risks...', flight_plan: 'Creating your project roadmap...' }
function hasStageContent(value) { return value && Object.values(value).some(item => typeof item === 'string' ? item.trim() : Array.isArray(item) ? item.length > 0 : item && typeof item === 'object' ? Object.values(item).some(nested => (Array.isArray(nested) && nested.length) || (typeof nested === 'string' && nested.trim())) : false) }
function updateAtPath(value, path, next) {
  const [head, ...tail] = path.split('.')
  const key = Array.isArray(value) ? Number(head) : head
  const copy = Array.isArray(value) ? [...value] : { ...(value || {}) }
  if (!tail.length) copy[key] = next
  else copy[key] = updateAtPath(copy[key] || (Number.isInteger(Number(tail[0])) ? [] : {}), tail.join('.'), next)
  return copy
}

const emptyFlightTask = () => ({ title: '', subtasks: [], dependencies: [], effort_estimate: '', priority: 'medium', acceptance_criteria: '', required_skills: [], suggested_role: '' })
function normalizeFlightTask(task) { return typeof task === 'string' ? { ...emptyFlightTask(), title: task } : { ...emptyFlightTask(), ...(task || {}) } }
function FlightPlanMilestone({ milestone, index, onFieldChange, onTasksChange, onRemove }) {
  const [expanded, setExpanded] = useState(index === 0 || !milestone.title)
  const [expandedTasks, setExpandedTasks] = useState(() => new Set())
  const tasks = (milestone.tasks || []).map(normalizeFlightTask)
  function changeTask(taskIndex, key, value) { onTasksChange(tasks.map((task, i) => i === taskIndex ? { ...task, [key]: value } : task)) }
  function addTask() {
    const nextIndex = tasks.length
    onTasksChange([...tasks, emptyFlightTask()])
    setExpandedTasks(current => new Set([...current, nextIndex]))
  }
  return <article className={`ud-flight-milestone${expanded ? ' is-open' : ''}`}>
    <header className="ud-flight-milestone-head">
      <button type="button" className="ud-flight-milestone-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        <span className="ud-flight-milestone-index">{String(index + 1).padStart(2, '0')}</span>
        <span className="ud-flight-milestone-title"><strong>{milestone.title || 'Untitled milestone'}</strong><small>{milestone.category || 'Milestone'} <i /> {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}</small></span>
        <ChevronDown size={17} className="ud-flight-chevron" />
      </button>
      <button type="button" className="ud-flight-remove" aria-label={`Remove milestone ${index + 1}`} onClick={onRemove}><Trash2 size={15} /></button>
    </header>
    {expanded && <div className="ud-flight-milestone-body">
      <div className="ud-flight-milestone-fields">
        <label className="ud-flight-field"><span>Milestone name</span><input value={milestone.title || ''} onChange={event => onFieldChange('title', event.target.value)} placeholder="e.g. Ideas and requirements" /></label>
        <label className="ud-flight-field"><span>Category</span><input value={milestone.category || ''} onChange={event => onFieldChange('category', event.target.value)} placeholder="e.g. Research & planning" /></label>
        <label className="ud-flight-field ud-flight-field-wide"><span>Outcome</span><textarea rows={2} value={milestone.outcome || ''} onChange={event => onFieldChange('outcome', event.target.value)} placeholder="What will be complete at the end of this milestone?" /></label>
      </div>
      <div className="ud-flight-task-list">
        {tasks.map((task, taskIndex) => {
          const taskExpanded = expandedTasks.has(taskIndex)
          return <section className={`ud-flight-task${taskExpanded ? ' is-open' : ''}`} key={taskIndex}>
            <div className="ud-flight-task-head">
              <button type="button" className="ud-flight-task-toggle" aria-expanded={taskExpanded} onClick={() => setExpandedTasks(current => { const next = new Set(current); next.has(taskIndex) ? next.delete(taskIndex) : next.add(taskIndex); return next })}>
                <span className="ud-flight-task-dot" />
                <span className="ud-flight-task-name">{task.title || `Task ${taskIndex + 1}`}</span>
                <span className={`ud-flight-priority priority-${(task.priority || 'medium').toLowerCase()}`}>{task.priority || 'Medium'} priority</span>
                {task.effort_estimate && <span className="ud-flight-effort">{task.effort_estimate}</span>}
                <ChevronDown size={15} className="ud-flight-chevron" />
              </button>
              <button type="button" className="ud-flight-remove task-remove" aria-label={`Remove task ${taskIndex + 1}`} onClick={() => onTasksChange(tasks.filter((_, i) => i !== taskIndex))}><Trash2 size={14} /></button>
            </div>
            {taskExpanded && <div className="ud-flight-task-fields">
              <label className="ud-flight-field ud-flight-field-wide"><span>Task</span><input value={task.title || ''} onChange={event => changeTask(taskIndex, 'title', event.target.value)} placeholder="Describe this task" /></label>
              <label className="ud-flight-field"><span>Effort estimate</span><input value={task.effort_estimate || ''} onChange={event => changeTask(taskIndex, 'effort_estimate', event.target.value)} placeholder="e.g. 1–2 weeks" /></label>
              <label className="ud-flight-field"><span>Priority</span><select value={(task.priority || 'medium').toLowerCase()} onChange={event => changeTask(taskIndex, 'priority', event.target.value)}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
              <label className="ud-flight-field"><span>Subtasks · one per line</span><textarea rows={3} value={multiline(task.subtasks)} onChange={event => changeTask(taskIndex, 'subtasks', fromMultiline(event.target.value))} placeholder="Break the task into smaller steps" /></label>
              <label className="ud-flight-field"><span>Dependencies · task titles</span><textarea rows={3} value={multiline(task.dependencies)} onChange={event => changeTask(taskIndex, 'dependencies', fromMultiline(event.target.value))} placeholder="Tasks that need to finish first" /></label>
              <label className="ud-flight-field ud-flight-field-wide"><span>Acceptance criteria</span><textarea rows={2} value={task.acceptance_criteria || ''} onChange={event => changeTask(taskIndex, 'acceptance_criteria', event.target.value)} placeholder="How will you know this task is complete?" /></label>
              <label className="ud-flight-field"><span>Required skills · one per line</span><textarea rows={2} value={multiline(task.required_skills)} onChange={event => changeTask(taskIndex, 'required_skills', fromMultiline(event.target.value))} placeholder="Skills needed" /></label>
              <label className="ud-flight-field"><span>Suggested role</span><input value={task.suggested_role || ''} onChange={event => changeTask(taskIndex, 'suggested_role', event.target.value)} placeholder="e.g. Product manager" /></label>
            </div>}
          </section>
        })}
      </div>
      <button type="button" className="ud-flight-add-task" onClick={addTask}><Plus size={15} /> Add task</button>
    </div>}
  </article>
}

export default function IdeaAnalysis() {
  const navigate = useNavigate()
  const prefersReducedMotion = useReducedMotion()
  const pageEntrance = { initial: { opacity: 0, y: prefersReducedMotion ? 0 : 9 }, animate: { opacity: 1, y: 0 }, transition: { duration: prefersReducedMotion ? 0.14 : 0.34, ease: [0.22, 1, 0.36, 1] } }
  const [draft, setDraft] = useState(readDraft)
  const [step, setStep] = useState(() => Math.min(4, Math.max(0, readDraft()?.currentStage || 0)))
  const [startDate, setStartDate] = useState(() => readDraft()?.startDate || readDraft()?.start_date || new Date().toISOString().split('T')[0])
  const [deadline, setDeadline] = useState(() => readDraft()?.deadline || '')
  const [projectType, setProjectType] = useState(() => readDraft()?.projectType || 'Startup')
  const [teamSize, setTeamSize] = useState(() => readDraft()?.teamSize || readDraft()?.team_size || 1)
  const [weeklyHours, setWeeklyHours] = useState(() => readDraft()?.weeklyHours || readDraft()?.weekly_hours || 20)
  const [understanding, setUnderstanding] = useState(() => {
    const initial = readDraft() || {}
    return { project_name: initial.projectName || '', problem_statement: initial.problemStatement || '', target_users: initial.targetUsers || '', expected_outcome: initial.expectedOutcome || '' }
  })
  const [workflow, setWorkflow] = useState(() => readDraft()?.workflow || {})
  const [loading, setLoading] = useState(false)
  const [stageLoading, setStageLoading] = useState('')
  const [stageErrors, setStageErrors] = useState({})
  const [stageStatuses, setStageStatuses] = useState({})
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [persistenceError, setPersistenceError] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [editingResearch, setEditingResearch] = useState('')
  const [researchEditValue, setResearchEditValue] = useState('')
  const draftRef = useRef(draft)
  const understandingRef = useRef(understanding)
  const workflowRef = useRef(workflow)
  const stageRequestsRef = useRef(new Set())
  const understandingEditVersionRef = useRef({ project_name: 0, problem_statement: 0, target_users: 0, expected_outcome: 0 })
  const saveQueueRef = useRef(Promise.resolve())
  const saveTimerRef = useRef(null)
  const editedStagesRef = useRef(new Set())
  const pollingRef = useRef(false)
  const researchEditorRef = useRef(null)
  const research = workflow.research || {}
  const feasibility = workflow.feasibility || {}
  const flightPlan = workflow.flight_plan || {}

  useEffect(() => {
    if (!editingResearch || !researchEditorRef.current) return
    const editor = researchEditorRef.current
    editor.style.height = 'auto'
    editor.style.height = `${editor.scrollHeight}px`
  }, [editingResearch, researchEditValue])

  useEffect(() => {
    if (!draft?.projectId) return
    let active = true
    fetchProjectDraft(draft.projectId).then(serverDraft => {
      if (!active || !serverDraft) return
      const serverWorkflow = serverDraft.workflow || {}
      const currentWorkflow = workflowRef.current || {}
      let hasUpdate = false
      const mergedWorkflow = { ...currentWorkflow }
      for (const k of ['research', 'feasibility', 'flight_plan']) {
        if (serverWorkflow[k] && hasStageContent(serverWorkflow[k]) && (!currentWorkflow[k] || !hasStageContent(currentWorkflow[k]))) {
          mergedWorkflow[k] = serverWorkflow[k]
          hasUpdate = true
        }
      }
      if (hasUpdate) {
        workflowRef.current = mergedWorkflow
        setWorkflow(mergedWorkflow)
        const nextDraft = { ...draftRef.current, workflow: mergedWorkflow }
        draftRef.current = nextDraft
        setDraft(nextDraft)
        sessionStorage.setItem(draftKey, JSON.stringify(nextDraft))
        localStorage.setItem(draftKey, JSON.stringify(nextDraft))
      }
    }).catch(() => {})
    return () => { active = false }
  }, [draft?.projectId])

  function startResearchEdit(section) {
    setResearchEditValue(researchEditorValue(section, research[section.key]))
    setEditingResearch(section.key)
  }
  function saveResearchEdit(section) {
    updateWorkflowField('research', section.key, researchEditorResult(section, researchEditValue))
    setEditingResearch('')
    setResearchEditValue('')
  }

  function persist(next = {}) {
    if (!draftRef.current) return null
    const editedStages = next.editedStages || []
    const { editedStages: _editedStages, ...draftChanges } = next
    editedStages.forEach(stage => editedStagesRef.current.add(stage))
    const fields = next.understanding || understandingRef.current
    const updated = {
      ...draftRef.current, ...draftChanges,
      projectName: fields.project_name,
      problemStatement: fields.problem_statement,
      targetUsers: fields.target_users,
      expectedOutcome: fields.expected_outcome,
      projectType: next.projectType ?? draftRef.current?.projectType ?? projectType,
      startDate: next.startDate ?? draftRef.current?.startDate ?? startDate,
      deadline: next.deadline ?? draftRef.current?.deadline ?? deadline,
      teamSize: next.teamSize ?? draftRef.current?.teamSize ?? teamSize,
      weeklyHours: next.weeklyHours ?? draftRef.current?.weeklyHours ?? weeklyHours,
      workflow: next.workflow || workflowRef.current,
      currentStage: next.currentStage ?? draftRef.current?.currentStage ?? step,
    }
    sessionStorage.setItem(draftKey, JSON.stringify(updated))
    localStorage.setItem(draftKey, JSON.stringify(updated))
    draftRef.current = updated
    setDraft(updated)
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      const request = saveQueueRef.current.catch(() => {}).then(async () => {
        const pendingEdits = [...editedStagesRef.current]
        const response = await saveProjectDraft(updated, fields, updated.workflow, stages[updated.currentStage ?? step]?.key || 'understanding', pendingEdits)
        pendingEdits.forEach(stage => editedStagesRef.current.delete(stage))
        return response
      })
      saveQueueRef.current = request
      request.then(() => setPersistenceError('')).catch(() => setPersistenceError('Your draft is saved in this browser, but could not sync to the server. Check the connection and retry Save for later.'))
    }, 450)
    return updated
  }
  function changeUnderstanding(key, value) {
    understandingEditVersionRef.current[key] += 1
    const updated = { ...understanding, [key]: value }
    understandingRef.current = updated
    setUnderstanding(updated); persist({ understanding: updated, editedStages: ['understanding'] }); setError('')
  }
  function changeWorkflow(stageKey, updatedData, fieldPath = '') {
    const updated = { ...workflowRef.current, [stageKey]: updatedData }
    workflowRef.current = updated
    setWorkflow(updated); persist({ workflow: updated, ...(fieldPath ? { editedStages: [stageKey] } : {}) })
  }
  function updateWorkflowField(stageKey, fieldPath, value) {
    changeWorkflow(stageKey, updateAtPath(workflowRef.current[stageKey] || emptyStage[stageKey], fieldPath, value), fieldPath)
  }
  function goToStage(nextStep) {
    if (step === 3 && nextStep > 3) {
      if (!deadline) {
        setError('Please select a project deadline before generating the Flight Plan.')
        return
      }
      const todayStr = new Date().toISOString().split('T')[0]
      if (deadline <= (startDate || todayStr)) {
        setError('The deadline must be in the future and strictly after the start date.')
        return
      }
      persist({
        startDate: startDate || todayStr,
        deadline,
        projectType,
        teamSize,
        weeklyHours,
        currentStage: 4,
      })
      void prepareStage('flight_plan', true, false, false)
    }
    const safeStep = Math.min(stages.length - 1, Math.max(0, nextStep))
    const nextWorkflow = { ...workflowRef.current }
    const completedStages = new Set(draft?.completedStages || [])
    if (safeStep > step) {
      const activeKey = stages[step].key
      if (activeKey !== 'understanding' && activeKey !== 'launch_timing') nextWorkflow[activeKey] ||= emptyStage[activeKey]
      completedStages.add(activeKey)
    }
    workflowRef.current = nextWorkflow
    setWorkflow(nextWorkflow); setStep(safeStep)
    persist({ currentStage: safeStep, workflow: nextWorkflow, completedStages: [...completedStages], ...(step === 0 && safeStep > 0 ? { understandingSaved: true } : {}) })
    setError(''); setNotice('')
  }
  async function analyzeUnderstanding() {
    if (!draft || loading) return
    if (!draft.idea?.trim()) { setError('Your idea is empty. Return to the dashboard and add a few details first.'); return }
    const editVersions = { ...understandingEditVersionRef.current }
    setLoading(true); setError(''); setNotice('')
    try {
      const response = await analyzeIdeaDraft({ ...draft, projectName: understanding.project_name, problemStatement: understanding.problem_statement, targetUsers: understanding.target_users, expectedOutcome: understanding.expected_outcome })
      const latest = understandingRef.current
      const analysis = Object.fromEntries(Object.entries(response.analysis).map(([key, value]) => [key, understandingEditVersionRef.current[key] !== editVersions[key] ? latest[key] : value]))
      understandingRef.current = analysis
      setUnderstanding(analysis); persist({ understanding: analysis, editedStages: ['understanding'], understandingSaved: true })
      await flushDraft()
      void prepareStage('research', false, true)
      setNotice('Your idea outline is ready. Review it, then continue to Research.')
    } catch (requestError) {
      setError(requestError.message || 'The idea could not be analyzed. You can still complete each stage manually.')
    } finally { setLoading(false) }
  }
  async function prepareStage(stageKey, retry = false, savedAlready = false, replaceEdited = false) {
    const currentDraft = draftRef.current
    if (!currentDraft || stageRequestsRef.current.has(stageKey)) return
    stageRequestsRef.current.add(stageKey)
    setStageLoading(stageKey)
    setStageErrors(current => ({ ...current, [stageKey]: '' }))
    try {
      if (!savedAlready) await flushDraft()
      const response = await queueIdeaStageGeneration({ projectId: draftRef.current.projectId, stage: stageKey, retry, replaceEdited })
      setStageStatuses(current => ({ ...current, [stageKey]: response.status }))
      if (response.requires_confirmation) setStageErrors(current => ({ ...current, [stageKey]: 'This report has saved edits. Confirm replacement to generate a fresh report from the latest saved information.' }))
    } catch (requestError) {
      setStageErrors(current => ({ ...current, [stageKey]: requestError.message || `Could not prepare ${stageKey.replace('_', ' ')}. Retry or complete the sections manually.` }))
    } finally {
      stageRequestsRef.current.delete(stageKey)
      setStageLoading(current => current === stageKey ? '' : current)
    }
  }
  function retryStage(stageKey) {
    if (stageStatuses[stageKey] === 'stale' && workflowRef.current[stageKey] && !window.confirm('Replace this saved report with a new version based on the latest upstream information?')) return
    void prepareStage(stageKey, true, false, stageStatuses[stageKey] === 'stale' && Boolean(workflowRef.current[stageKey]))
  }

  async function generateStageDirectly(stageKey) {
    if (loading || stageLoading) return
    setStageLoading(stageKey)
    setStageErrors(current => ({ ...current, [stageKey]: '' }))
    try {
      await flushDraft()
      const currentDraft = draftRef.current
      const details = {
        understanding: understandingRef.current,
        ...(workflowRef.current || {}),
        start_date: startDate,
        deadline,
        team_size: teamSize,
        weekly_hours: weeklyHours,
      }
      const response = await generateIdeaStage({
        stage: stageKey,
        draft: currentDraft,
        projectDetails: details,
      })
      if (response?.result) {
        const nextWorkflow = { ...workflowRef.current, [stageKey]: response.result }
        workflowRef.current = nextWorkflow
        setWorkflow(nextWorkflow)
        const updated = { ...draftRef.current, workflow: nextWorkflow }
        draftRef.current = updated
        setDraft(updated)
        sessionStorage.setItem(draftKey, JSON.stringify(updated))
        localStorage.setItem(draftKey, JSON.stringify(updated))
        setStageStatuses(current => ({ ...current, [stageKey]: 'completed' }))
        setStageErrors(current => ({ ...current, [stageKey]: '' }))
        await flushDraft()
      }
    } catch (err) {
      setStageErrors(current => ({ ...current, [stageKey]: err.message || `Could not generate ${stageKey.replace('_', ' ')}.` }))
    } finally {
      setStageLoading('')
    }
  }

  useEffect(() => {
    const stage = step === 0 ? 'research' : stages[step].key
    if (stage === 'launch_timing') return
    if (!draft?.projectId || pollingRef.current) return
    let active = true
    let timer
    pollingRef.current = true
    const poll = async () => {
      if (!active) return
      try {
        const state = await getIdeaStageGeneration(draft.projectId, stage)
        if (!active) return
        setStageStatuses(current => ({ ...current, [stage]: state.status }))
        if (state.status === 'completed' && state.result) {
          const nextWorkflow = { ...workflowRef.current, [stage]: state.result }
          workflowRef.current = nextWorkflow; setWorkflow(nextWorkflow)
          const updated = { ...draftRef.current, workflow: nextWorkflow, stageGenerated: { ...(draftRef.current.stageGenerated || {}), [stage]: true } }
          draftRef.current = updated; setDraft(updated)
          sessionStorage.setItem(draftKey, JSON.stringify(updated)); localStorage.setItem(draftKey, JSON.stringify(updated))
          setStageErrors(current => ({ ...current, [stage]: '' }))
        } else if (state.status === 'failed') {
          setStageErrors(current => ({ ...current, [stage]: state.error || 'Generation failed. Retry or complete the sections manually.' }))
        } else if (state.requires_confirmation) {
          setStageErrors(current => ({ ...current, [stage]: state.error || 'This report contains edits. Confirm before replacing it.' }))
        }
        const readyForResearch = step !== 0 || Boolean(draftRef.current?.understandingSaved)
        let upstreamReady = true
        if (stage === 'feasibility' || stage === 'flight_plan') {
          const upstream = stage === 'feasibility' ? 'research' : 'feasibility'
          const upstreamState = await getIdeaStageGeneration(draft.projectId, upstream)
          upstreamReady = !['queued', 'generating'].includes(upstreamState.status)
            && (upstreamState.status === 'completed' || hasStageContent(upstreamState.result))
        }
        if (readyForResearch && upstreamReady && ['not_started', 'stale'].includes(state.status) && !state.requires_confirmation) {
          if (state.status === 'stale' && state.manually_edited && state.has_generated_result) {
            // Preserve edited reports until the user confirms replacement.
          } else if (!stageRequestsRef.current.has(stage)) void prepareStage(stage, false)
        }
        if (['queued', 'generating'].includes(state.status)) setStageLoading(stage)
        else setStageLoading(current => current === stage ? '' : current)
        if (['queued', 'generating'].includes(state.status) || (readyForResearch && ['not_started', 'stale'].includes(state.status))) timer = setTimeout(poll, 1800)
      } catch {
        if (active) timer = setTimeout(poll, 4000)
      }
    }
    void poll()
    return () => { active = false; clearTimeout(timer); pollingRef.current = false }
  }, [step, draft?.projectId])

  async function flushDraft() {
    clearTimeout(saveTimerRef.current)
    const latest = draftRef.current
    if (latest) saveQueueRef.current = saveQueueRef.current.catch(() => {}).then(async () => {
      const pendingEdits = [...editedStagesRef.current]
      const response = await saveProjectDraft(latest, understandingRef.current, workflowRef.current, stages[latest.currentStage ?? step]?.key || 'understanding', pendingEdits)
      pendingEdits.forEach(stage => editedStagesRef.current.delete(stage))
      return response
    })
    try {
      await saveQueueRef.current
      setPersistenceError('')
    } catch {
      setPersistenceError('Your draft is saved in this browser, but could not sync to the server. Check the connection and retry.')
      throw new Error('Draft server sync failed.')
    }
  }
  async function saveForLater() { persist(); try { await flushDraft(); navigate('/') } catch { /* Keep the draft open so the user can retry server sync. */ } }
  async function createProject() {
    const name = understanding.project_name.trim()
    if (!name) { setError('Add a project name in Understanding before creating your project.'); setStep(0); persist({ currentStage: 0 }); return }
    if (!draft?.idea?.trim()) { setError('Add a short description of your idea before creating the project.'); setStep(0); persist({ currentStage: 0 }); return }
    if (!hasActionableFlightPlan(workflowRef.current.flight_plan)) { setError('Add at least one milestone with a task before creating this project.'); return }
    setLoading(true); setError(''); setNotice('Saving your project and roadmap…')
    try {
      await flushDraft()
      const latestDraft = draftRef.current
      const latestUnderstanding = understandingRef.current
      const finalWorkflow = workflowRef.current
      const project = saveIdeaProject({ draft: latestDraft, understanding: latestUnderstanding, workflow: finalWorkflow })
      await applyRoadmapSync(project.id)
      sessionStorage.removeItem(draftKey)
      localStorage.removeItem(draftKey)
      navigate(`/flight-plan?project=${encodeURIComponent(project.id)}`, { state: { createdProject: name } })
    } catch (saveError) {
      setError(saveError.message === 'Draft server sync failed.' ? 'Could not sync this project to the server. Your latest work remains saved in this browser; try again when the backend is available.' : 'Could not save this project in this browser. Check that browser storage is available, then try again.')
    } finally { setLoading(false); setNotice('') }
  }

  return <div className="ud-dashboard ud-analysis-page">
    <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} activePage="projects" />
    <div className="ud-work-area">
      <header className="ud-topbar"><div className="ud-topbar-left"><button className="ud-mobile-menu ud-icon-button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><span aria-hidden="true">☰</span></button><span className="ud-topbar-title">New project</span></div><div className="ud-topbar-actions"><span className="ud-avatar ud-top-avatar">TS</span></div></header>
      {!draft ? <motion.main className="ud-analysis-main" {...pageEntrance}><section className="ud-analysis-card ud-no-draft"><Sparkles size={22} /><h1>No idea draft found</h1><p>Start with your idea on the dashboard, then come back here to shape it into a project plan.</p><Link className="ud-analysis-primary" to="/">Back to dashboard <ArrowRight size={16} /></Link></section></motion.main> : <motion.main className="ud-analysis-main" {...pageEntrance}>
        <Link className="ud-analysis-back" to="/" onClick={saveForLater}><ArrowLeft size={15} /> Back to dashboard</Link>
        <section className="ud-analysis-heading"><span className="ud-analysis-kicker"><Sparkles size={15} /> YOUR IDEA, TAKING SHAPE</span><h1>{['Let’s give it a little structure.', 'Let’s learn what to validate.', 'Let’s see what is feasible.', 'When do you want to launch?', 'Your first flight plan.'][step]}</h1><p>{['Shape the idea before doing the deeper work.', 'Turn unknowns into questions and practical validation steps.', 'Review what seems promising and what still needs evidence.', 'Set your target deadline and team capacity to create a realistic schedule.', 'Put the build steps in a realistic, deadline-driven order you can act on.'][step]}</p></section>
        <nav className="ud-stage-rail" aria-label="Project creation stages">{stages.map((stage, index) => { const isComplete = (draft.completedStages || []).includes(stage.key); return <button type="button" key={stage.key} className={`${index === step ? 'active' : ''} ${isComplete ? 'complete' : ''}`} aria-current={index === step ? 'step' : undefined} onClick={() => goToStage(index)}><span>{isComplete ? <Check size={14} /> : index + 1}</span><small>{stage.title}</small></button> })}</nav>
        <section className="ud-analysis-card ud-workflow-card">
          <div className="ud-idea-summary"><div><span className="ud-field-eyebrow">YOUR IDEA</span><p>{draft.idea}</p></div><span className="ud-summary-type">{projectType || draft.projectType}</span></div>
          {draft.attachment?.name && <p className="ud-summary-attachment">Reference attached: {draft.attachment.name}</p>}
          {step === 0 && <div className="ud-stage-content"><div className="ud-stage-intro"><span className="ud-stage-icon"><Sparkles size={17} /></span><div><h2>Clarify the idea</h2><p>{loading ? 'Understanding your idea...' : 'Review the original idea and refine its name, problem, audience, and intended outcome.'}</p></div>{loading && <LoaderCircle size={15} className="ud-spin" />}</div>{['queued', 'generating'].includes(stageStatuses.research) && <div className="ud-analysis-success" role="status"><LoaderCircle size={15} className="ud-spin" /><span>Preparing Research in the background. You can keep refining your idea.</span></div>}{stageStatuses.research === 'completed' && <div className="ud-analysis-success" role="status"><Check size={15} /><span>Your initial Research report is ready for the next stage.</span></div>}<div className="ud-analysis-fields">{understandingFields.map(field => <label key={field.key}><span>{field.label}</span><textarea value={understanding[field.key]} onChange={event => changeUnderstanding(field.key, event.target.value)} placeholder={field.placeholder} rows={field.rows} /></label>)}</div></div>}
          {step === 1 && <div className="ud-stage-content"><div className="ud-stage-intro"><span className="ud-stage-icon"><FileSearch size={17} /></span><div><h2>Research landscape</h2><p>{['queued', 'generating'].includes(stageStatuses.research) ? 'Preparing your research plan in the background…' : stageLoading === 'research' ? loadingMessages.research : 'A preliminary AI landscape, not live web research. Verify claims and sources before relying on them.'}</p></div>{['queued', 'generating'].includes(stageStatuses.research) && <LoaderCircle size={15} className="ud-spin" />}</div>
            <div className="ud-research-report" aria-label="Research report">{researchSections.map(section => {
              const Icon = section.icon
              const value = research[section.key]
              const hasContent = section.kind === 'text' ? Boolean(value?.trim()) : Boolean(value?.length)
              const isEditing = editingResearch === section.key
              return <article className={`ud-research-section ${section.tone ? `tone-${section.tone}` : ''}`} key={section.key}>
                <header className="ud-research-section-heading"><span className="ud-research-section-icon"><Icon size={16} /></span><div><h3>{section.title}</h3>{section.note && <small>{section.note}</small>}</div><button type="button" className="ud-research-edit" onClick={() => isEditing ? (setEditingResearch(''), setResearchEditValue('')) : startResearchEdit(section)} aria-label={`${isEditing ? 'Close editor for' : 'Edit'} ${section.title}`}><Pencil size={13} /> {isEditing ? 'Close' : 'Edit'}</button></header>
                {isEditing ? <div className="ud-research-inline-editor"><label className="ud-sr-only" htmlFor={`research-edit-${section.key}`}>{section.title}, editable content</label><textarea id={`research-edit-${section.key}`} ref={researchEditorRef} value={researchEditValue} onChange={event => setResearchEditValue(event.target.value)} placeholder={section.kind === 'sources' ? 'Title | URL | explanation (one source per line)' : section.kind === 'list' ? 'One item per line' : 'Add your notes'} />{section.kind === 'sources' && <p>One source per line: title | URL | explanation. Only valid web addresses become links.</p>}<div className="ud-research-editor-actions"><button type="button" className="ud-research-cancel" onClick={() => { setEditingResearch(''); setResearchEditValue('') }}><X size={14} /> Cancel</button><button type="button" className="ud-research-save" onClick={() => saveResearchEdit(section)}><Check size={14} /> Save</button></div></div> : !hasContent ? <p className="ud-research-empty">No details yet. Use Edit to add content.</p> : section.kind === 'text' ? <p className="ud-research-paragraph">{value}</p> : section.kind === 'list' ? <ul className="ud-research-list">{value.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <ul className="ud-research-sources">{value.map((source, index) => <li key={`${index}-${source.title}`}><div className="ud-source-title">{source.title || source.url || 'Source'}</div>{source.explanation && <p>{source.explanation}</p>}{source.url && (isHttpUrl(source.url) ? <a href={source.url} target="_blank" rel="noreferrer">{source.url}</a> : <span className="ud-source-url">{source.url}</span>)}</li>)}</ul>}
              </article>
            })}</div>
            {stageErrors.research && <div className="ud-analysis-error ud-research-error" role="alert"><span>{stageErrors.research} You can complete every section manually.</span><button type="button" onClick={() => retryStage('research')} disabled={Boolean(stageLoading)}><Sparkles size={14} /> {stageStatuses.research === 'stale' ? 'Replace with fresh report' : 'Retry'}</button></div>}
          </div>}
          {step === 2 && <div className="ud-stage-content"><div className="ud-stage-intro"><span className="ud-stage-icon"><CircleHelp size={17} /></span><div><h2>Feasibility review</h2><p>{['queued', 'generating'].includes(stageStatuses.feasibility) ? 'Preparing feasibility in the background…' : stageLoading === 'feasibility' ? loadingMessages.feasibility : 'Assess buildability separately from market demand. Estimates are assumptions to review.'}</p></div>{['queued', 'generating'].includes(stageStatuses.feasibility) && <LoaderCircle size={15} className="ud-spin" />}</div>
            <div className="ud-feasibility-report" aria-label="Feasibility report">{feasibilitySections.map(section => <FeasibilityReportCard key={section.key} section={section} value={section.key === 'mvp_scope' ? feasibility.mvp_scope : feasibility[section.key]} onSave={value => updateWorkflowField('feasibility', section.key, value)} />)}</div>
            {stageErrors.feasibility && <div className="ud-analysis-error ud-research-error" role="alert"><span>{stageErrors.feasibility} You can complete every section manually.</span><button type="button" onClick={() => retryStage('feasibility')} disabled={Boolean(stageLoading)}><Sparkles size={14} /> {stageStatuses.feasibility === 'stale' ? 'Replace with fresh report' : 'Retry'}</button></div>}
          </div>}
          {step === 3 && (() => {
            const todayIso = new Date().toISOString().split('T')[0]
            const startVal = startDate || todayIso
            let daysRemaining = 0
            let weeksRemaining = 0
            if (deadline && deadline > startVal) {
              const diffMs = new Date(deadline).getTime() - new Date(startVal).getTime()
              daysRemaining = Math.max(1, Math.round(diffMs / (1000 * 60 * 60 * 24)))
              weeksRemaining = Math.max(0.1, Number((daysRemaining / 7).toFixed(1)))
            }
            const capacityHours = Math.round(teamSize * weeklyHours * (daysRemaining / 7))
            let pacingLabel = 'Steady Strategic Pace'
            let pacingClass = 'steady'
            let pacingDesc = 'Structured phases with ample room for testing, bug fixes, and polish.'
            if (daysRemaining <= 7) {
              pacingLabel = 'Hackathon Sprint Pace ⚡'
              pacingClass = 'sprint'
              pacingDesc = 'Intense daily execution. Keep strict focus on bare-minimum MVP features.'
            } else if (daysRemaining <= 28) {
              pacingLabel = 'Fast-Paced Agile Sprint 🚀'
              pacingClass = 'agile'
              pacingDesc = 'Focused iterations with priority on critical path and core flows.'
            }
            return (
              <div className="ud-stage-content ud-timing-content">
                <div className="ud-stage-intro">
                  <span className="ud-stage-icon"><Calendar size={17} /></span>
                  <div>
                    <h2>When do you want to launch?</h2>
                    <p>Tell UDAAN your target deadline and team capacity so Gemini can schedule a realistic roadmap with actual dates.</p>
                  </div>
                </div>

                <div className="ud-timing-grid">
                  <div className="ud-timing-fields">
                    <label>
                      <span>Project deadline * (required)</span>
                      <input
                        type="date"
                        min={startDate || todayIso}
                        value={deadline}
                        onChange={event => {
                          setDeadline(event.target.value)
                          persist({ deadline: event.target.value })
                          setError('')
                        }}
                        required
                      />
                    </label>

                    <label>
                      <span>Project start date</span>
                      <input
                        type="date"
                        value={startDate}
                        onChange={event => {
                          setStartDate(event.target.value)
                          persist({ startDate: event.target.value })
                          setError('')
                        }}
                      />
                    </label>

                    <label>
                      <span>Project type</span>
                      <select
                        value={projectType}
                        onChange={event => {
                          setProjectType(event.target.value)
                          persist({ projectType: event.target.value })
                        }}
                      >
                        <option value="Startup">Startup</option>
                        <option value="Hackathon">Hackathon</option>
                        <option value="College Project">College Project</option>
                        <option value="Personal Project">Personal Project</option>
                      </select>
                    </label>

                    <div className="ud-timing-inline-fields">
                      <label>
                        <span>Team size</span>
                        <input
                          type="number"
                          min="1"
                          max="50"
                          value={teamSize}
                          onChange={event => {
                            const val = Math.max(1, parseInt(event.target.value) || 1)
                            setTeamSize(val)
                            persist({ teamSize: val })
                          }}
                        />
                      </label>

                      <label>
                        <span>Weekly hours / person</span>
                        <input
                          type="number"
                          min="1"
                          max="168"
                          value={weeklyHours}
                          onChange={event => {
                            const val = Math.max(1, parseInt(event.target.value) || 20)
                            setWeeklyHours(val)
                            persist({ weeklyHours: val })
                          }}
                        />
                      </label>
                    </div>
                  </div>

                  <div className="ud-timeline-preview-card">
                    <div className="ud-preview-header">
                      <Clock size={16} />
                      <span>Timeline & Capacity Preview</span>
                    </div>

                    {daysRemaining > 0 ? (
                      <div className="ud-preview-metrics">
                        <div className="ud-preview-stat">
                          <span className="ud-stat-number">{daysRemaining}</span>
                          <span className="ud-stat-unit">days to launch</span>
                          <small>· {weeksRemaining} week{weeksRemaining === 1 ? '' : 's'}</small>
                        </div>

                        <div className="ud-preview-capacity">
                          <span>Team Available Capacity</span>
                          <strong>~{capacityHours} person-hours</strong>
                          <small>{teamSize} contributor(s) × {weeklyHours} hrs/week</small>
                        </div>

                        <div className={`ud-pacing-badge ${pacingClass}`}>
                          <span>{pacingLabel}</span>
                          <p>{pacingDesc}</p>
                        </div>
                      </div>
                    ) : (
                      <div className="ud-preview-empty">
                        <AlertCircle size={22} />
                        <p>Pick a deadline in the future to see available days, total capacity, and pacing recommendations.</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })()}
          {step === 4 && <div className="ud-stage-content ud-flightplan-content"><div className="ud-stage-intro"><span className="ud-stage-icon"><Rocket size={17} /></span><div><h2>Build your first flight plan</h2><p>{['queued', 'generating'].includes(stageStatuses.flight_plan) ? 'Preparing your roadmap in the background…' : stageLoading === 'flight_plan' ? loadingMessages.flight_plan : 'Review milestones, tasks, dependencies, effort, and acceptance criteria before creating the project.'}</p></div>{['queued', 'generating'].includes(stageStatuses.flight_plan) && <LoaderCircle size={15} className="ud-spin" />}</div>
            <section className="ud-flight-overview"><div><span className="ud-flight-overview-icon"><Compass size={16} /></span><div><h3>Roadmap overview</h3><p>A short view of what this plan will help you build.</p></div></div><label className="ud-flight-field"><span>Plan overview</span><textarea rows={3} value={flightPlan.summary || ''} onChange={event => updateWorkflowField('flight_plan','summary',event.target.value)} placeholder="Summarize the goal and direction of this roadmap" /></label></section>
            <div className="ud-flight-section-heading">
              <div><span className="ud-flight-section-kicker">YOUR ROADMAP</span><h3>Milestones</h3></div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                {!(flightPlan.milestones || []).length && (
                  <button
                    type="button"
                    className="ud-analysis-secondary"
                    style={{ padding: '0.35rem 0.85rem', fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
                    onClick={() => generateStageDirectly('flight_plan')}
                    disabled={Boolean(stageLoading) || ['queued', 'generating'].includes(stageStatuses.flight_plan)}
                  >
                    {stageLoading === 'flight_plan' ? <LoaderCircle size={14} className="ud-spin" /> : <Sparkles size={14} />}
                    <span>{stageLoading === 'flight_plan' ? 'Generating roadmap…' : 'Generate roadmap with AI'}</span>
                  </button>
                )}
                <span className="ud-flight-count">{(flightPlan.milestones || []).length} {(flightPlan.milestones || []).length === 1 ? 'milestone' : 'milestones'}</span>
              </div>
            </div>
            <div className="ud-flight-milestone-list">{(flightPlan.milestones || []).map((milestone, index) => <FlightPlanMilestone key={index} milestone={milestone} index={index} onFieldChange={(key, value) => updateWorkflowField('flight_plan',`milestones.${index}.${key}`,value)} onTasksChange={tasks => updateWorkflowField('flight_plan',`milestones.${index}.tasks`,tasks)} onRemove={() => updateWorkflowField('flight_plan','milestones',flightPlan.milestones.filter((_, itemIndex) => itemIndex !== index))} />)}</div>
            <button type="button" className="ud-flight-add-milestone" onClick={() => updateWorkflowField('flight_plan','milestones',[...(flightPlan.milestones || []), { title: '', category: '', outcome: '', tasks: [] }])}><Plus size={16} /><span><strong>Add a milestone</strong><small>Break your roadmap into another meaningful stage</small></span></button>
            {stageErrors.flight_plan && <div className="ud-analysis-error ud-research-error" role="alert"><span>{stageErrors.flight_plan} You can create milestones manually.</span><button type="button" onClick={() => generateStageDirectly('flight_plan')} disabled={Boolean(stageLoading)}><Sparkles size={14} /> Retry roadmap generation</button></div>}
          </div>}
          {notice && <div className="ud-analysis-success" role="status"><Check size={16} /><span>{notice}</span></div>}
          {error && <div className="ud-analysis-error" role="alert">{error}</div>}
          {persistenceError && <div className="ud-analysis-error" role="alert">{persistenceError}</div>}
          <div className="ud-analysis-actions ud-workflow-actions"><button className="ud-analysis-secondary" type="button" onClick={saveForLater}><Save size={14} /> Save for later</button><div className="ud-workflow-action-group">{step > 0 && <button className="ud-analysis-secondary" type="button" onClick={() => goToStage(step - 1)}><ArrowLeft size={15} /> Back</button>}
            {step === 0 && <button className="ud-analysis-secondary" type="button" onClick={analyzeUnderstanding} disabled={loading}>{loading ? <LoaderCircle size={15} className="ud-spin" /> : <Sparkles size={15} />} {loading ? 'Understanding your idea...' : 'Analyze my idea'}</button>}
            {step < 4 ? <button className="ud-analysis-primary" type="button" onClick={() => goToStage(step + 1)} disabled={Boolean(stageLoading) || loading}>Continue to {stages[step + 1].title} <ArrowRight size={16} /></button> : <button className="ud-analysis-primary" type="button" onClick={createProject} disabled={loading || Boolean(stageLoading)}>{loading ? <><LoaderCircle size={15} className="ud-spin" /> Saving project…</> : <><ClipboardCheck size={16} /> Create project and roadmap</>}</button>}
          </div></div>
        </section>
        <p className="ud-analysis-footnote">Your work saves in this browser as you go. AI suggestions are editable and never represent verified research.</p>
      </motion.main>}
    </div>
  </div>
}
