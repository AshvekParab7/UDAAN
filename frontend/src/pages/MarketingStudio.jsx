import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ArrowDownToLine, ArrowRight, Bookmark, Check, ChevronDown, Copy, FileText, Megaphone, Menu, MessageSquareText, Pencil, RefreshCw, Search, Send, Sparkles, WandSparkles, X } from 'lucide-react'
import Sidebar from '../layouts/Sidebar.jsx'
import { readSavedProjects } from '../services/projectStorage.js'
import { getLearningProject, listLearningProjects } from '../services/learningService.js'
import { getTeamWorkspace } from '../services/teamService.js'
import { deleteMarketingContent, generateMarketingContent, listMarketingContent, saveMarketingContent, updateMarketingContent } from '../services/marketingService.js'
import './MarketingStudio.css'

const tabs = [
  { id: 'create', label: 'Create content', mode: 'social', icon: Sparkles },
  { id: 'showcase', label: 'Project showcase', mode: 'showcase', icon: Megaphone },
  { id: 'repurpose', label: 'Repurpose', mode: 'repurpose', icon: RefreshCw },
  { id: 'campaign', label: 'Campaign planner', mode: 'campaign', icon: FileText },
  { id: 'saved', label: 'Saved content', mode: null, icon: Bookmark },
]
const contentTypes = [
  { mode: 'social', title: 'Social post', subtitle: 'LinkedIn, Instagram, X, Facebook or Reddit', icon: MessageSquareText },
  { mode: 'showcase', title: 'Project showcase', subtitle: 'Launch, portfolio, demo day or README', icon: Megaphone },
  { mode: 'repurpose', title: 'Repurpose content', subtitle: 'Turn a source into useful formats', icon: RefreshCw },
  { mode: 'campaign', title: 'Campaign plan', subtitle: 'A proposed 7 or 30 day calendar', icon: FileText },
  { mode: 'tool', title: 'Marketing toolkit', subtitle: 'Descriptions, pitches, email and more', icon: WandSparkles },
]
const platforms = ['LinkedIn', 'Instagram caption', 'X post', 'X thread', 'Facebook', 'Reddit community post']
const tones = ['Professional', 'Conversational', 'Storytelling', 'Educational', 'Bold', 'Humorous']
const formats = ['LinkedIn post', 'Instagram caption', '5–8 slide carousel outline', '30–60 second video script', 'X post or thread', 'Demo narration', 'Promotional email']
const showcaseTypes = ['Project launch announcement', 'Build-in-public update', 'Portfolio description', 'Hackathon introduction', 'Demo-day announcement', 'Feature launch', 'Team achievement', 'GitHub repository description', 'README introduction', 'Elevator pitch']
const toolTypes = ['Product description', 'Landing-page copy', 'Startup elevator pitch', 'Event announcement', 'Personal brand introduction', 'Educational post', 'Internship announcement', 'Achievement announcement', 'Demo-day script', 'Promotional email', 'Audience-specific messaging', 'Call to action variations', 'Headline variations', 'Custom request']
const navCopy = { create: 'Social post', showcase: 'Project showcase', repurpose: 'Repurpose', campaign: 'Campaign', tool: 'Marketing tool' }

function normalizeProject(project) {
  const understanding = project.understanding || {}
  return {
    ...project,
    name: project.name || understanding.project_name || 'Untitled project',
    description: project.description || understanding.problem_statement || project.idea || '',
    target_users: understanding.target_users || '',
    expected_outcome: understanding.expected_outcome || '',
    project_type: project.project_type || project.category || 'Project',
    workflow: project.workflow || {},
  }
}
function makeWorkspaceItem(item) {
  const completeBody = [item.hook, item.body, item.cta, ...(item.hashtags || [])].filter(Boolean).join('\n\n')
  return { ...item, body: completeBody, saved: false, favorite: false }
}
function dateLabel(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
function projectSummary(project, teamWorkspace) {
  const milestones = project?.workflow?.flight_plan?.milestones || []
  const planned = milestones.flatMap(item => item.tasks || []).length
  const features = project?.latest_assessment?.task_assessments || {}
  const verified = Object.values(features).filter(item => item.status === 'verified').length
  const completed = teamWorkspace?.tasks?.filter(task => task.status === 'completed').length ?? project?.workspace_completed_tasks ?? 0
  return { milestones, planned, verified, completed }
}

export default function MarketingStudio() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [menuOpen, setMenuOpen] = useState(false)
  const [projects, setProjects] = useState(() => readSavedProjects().map(normalizeProject))
  const [selectedId, setSelectedId] = useState(() => searchParams.get('project') || localStorage.getItem('udaan:selected-project') || 'custom')
  const [teamWorkspace, setTeamWorkspace] = useState(null)
  const [activeTab, setActiveTab] = useState('create')
  const [mode, setMode] = useState('social')
  const [inputs, setInputs] = useState({ topic: '', objective: 'awareness', audience: '', tone: 'Professional', length: 'Medium', keywords: '', cta: '', extra_instructions: '', platform: 'LinkedIn', showcase_type: showcaseTypes[0], formats: [formats[0], formats[2], formats[3]], campaign_days: 7, campaign_platform: 'LinkedIn', template: toolTypes[0], source_content: '', context_override: '' })
  const [editContext, setEditContext] = useState(false)
  const [results, setResults] = useState([])
  const [approach, setApproach] = useState('')
  const [generationBusy, setGenerationBusy] = useState(false)
  const [refineBusy, setRefineBusy] = useState('')
  const [library, setLibrary] = useState([])
  const [libraryLoaded, setLibraryLoaded] = useState(false)
  const [libraryBusy, setLibraryBusy] = useState(false)
  const [libraryFilters, setLibraryFilters] = useState({ q: '', project: '', type: '', platform: '' })
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [copying, setCopying] = useState('')

  const selectedProject = projects.find(item => String(item.id) === String(selectedId)) || null
  const summary = useMemo(() => projectSummary(selectedProject, teamWorkspace), [selectedProject, teamWorkspace])
  const savedProjects = projects

  const loadProjects = useCallback(async () => {
    const localProjects = readSavedProjects().map(normalizeProject)
    const byId = new Map(localProjects.map(project => [String(project.id), project]))
    try {
      const response = await listLearningProjects()
      for (const project of response?.results || []) {
        const previous = byId.get(String(project.id)) || {}
        byId.set(String(project.id), normalizeProject({ ...previous, ...project, name: previous.name || project.understanding?.project_name, description: previous.description || project.understanding?.problem_statement }))
      }
    } catch { /* Local project drafts remain selectable if account listing is unavailable. */ }
    const hydrated = await Promise.allSettled([...byId.values()].map(project => getLearningProject(project.id)))
    hydrated.forEach(result => {
      if (result.status !== 'fulfilled') return
      const project = result.value
      const previous = byId.get(String(project.id)) || {}
      byId.set(String(project.id), normalizeProject({ ...previous, ...project, name: previous.name || project.understanding?.project_name, description: previous.description || project.understanding?.problem_statement }))
    })
    setProjects([...byId.values()])
    const requested = searchParams.get('project')
    const remembered = localStorage.getItem('udaan:selected-project')
    const all = [...byId.keys()]
    const chosen = requested && byId.has(String(requested)) ? requested : remembered && byId.has(String(remembered)) ? remembered : all[0] || 'custom'
    setSelectedId(String(chosen))
  }, [])

  const loadLibrary = useCallback(async filters => {
    setLibraryBusy(true)
    try {
      const response = await listMarketingContent(filters || {})
      setLibrary(response.results || [])
      setLibraryLoaded(true)
    } catch (err) {
      setError(err.message || 'Saved content could not be loaded.')
      setLibraryLoaded(true)
    } finally { setLibraryBusy(false) }
  }, [])

  useEffect(() => { void loadProjects(); void loadLibrary() }, [loadProjects, loadLibrary])
  useEffect(() => {
    if (selectedId !== 'custom' && selectedProject?.id) {
      localStorage.setItem('udaan:selected-project', String(selectedProject.id))
      if (searchParams.get('project') !== String(selectedProject.id)) setSearchParams(previous => { const next = new URLSearchParams(previous); next.set('project', String(selectedProject.id)); return next }, { replace: true })
    } else if (selectedId === 'custom' && searchParams.has('project')) setSearchParams(previous => { const next = new URLSearchParams(previous); next.delete('project'); return next }, { replace: true })
  }, [selectedId, selectedProject?.id])
  useEffect(() => {
    if (!selectedProject?.id) { setTeamWorkspace(null); return }
    let active = true
    void getTeamWorkspace(selectedProject.id).then(value => { if (active) setTeamWorkspace(value) }).catch(() => { if (active) setTeamWorkspace(null) })
    return () => { active = false }
  }, [selectedProject?.id])
  useEffect(() => {
    if (activeTab === 'saved') void loadLibrary({ q: libraryFilters.q, project: libraryFilters.project, type: libraryFilters.type, platform: libraryFilters.platform })
  }, [activeTab, libraryFilters.project, libraryFilters.type, libraryFilters.platform, loadLibrary])

  const switchTab = tab => {
    setActiveTab(tab)
    const nextMode = tabs.find(item => item.id === tab)?.mode
    if (nextMode) setMode(nextMode)
    setError(''); setNotice('')
  }
  const setField = (key, value) => setInputs(current => ({ ...current, [key]: value }))
  const generationInputs = useMemo(() => {
    const base = { ...inputs }
    if (mode !== 'repurpose') delete base.source_content
    if (mode !== 'campaign') delete base.campaign_days
    if (!selectedProject) delete base.context_override
    return base
  }, [inputs, mode, selectedProject])

  const generate = async event => {
    event?.preventDefault?.()
    if (generationBusy) return
    if (mode === 'repurpose' && !inputs.source_content.trim()) { setError('Add the source content you want to repurpose.'); return }
    if (mode !== 'repurpose' && !inputs.topic.trim() && !inputs.source_content.trim()) { setError('Describe what you want to create first.'); return }
    setGenerationBusy(true); setError(''); setNotice('')
    try {
      const response = await generateMarketingContent({ mode, project_id: selectedProject?.id || null, inputs: generationInputs })
      setResults((response.result?.items || []).map((item, index) => ({ ...makeWorkspaceItem(item), localKey: `${Date.now()}-${index}`, content_type: mode, generation_inputs: { ...generationInputs, mode }, project: selectedProject?.id || null, projectName: selectedProject?.name || null })))
      setApproach(response.result?.approach || '')
      setNotice('Drafts are ready to review and edit. Nothing has been published.')
      setActiveTab('create')
    } catch (err) { setError(err.message || 'Content generation failed. Your request is still here; try again or revise it.') }
    finally { setGenerationBusy(false) }
  }

  const copyResult = async item => {
    try { await navigator.clipboard.writeText(item.body); setCopying(item.localKey || item.id); setNotice('Content copied to clipboard.') }
    catch { setError('Clipboard access was blocked by the browser. Select the text and copy it manually.') }
  }
  const downloadResult = item => {
    try {
      const file = new Blob([`${item.title}\n\n${item.body}`], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(file)
      const link = document.createElement('a')
      link.href = url; link.download = `${(item.title || 'marketing-draft').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'marketing-draft'}.txt`
      link.click(); URL.revokeObjectURL(url); setNotice('Draft downloaded as a text file.')
    } catch { setError('The browser could not download this draft.') }
  }

  const saveResult = async item => {
    setError(''); setNotice('')
    const payload = { title: item.title || 'Untitled draft', body: item.body, content_type: item.content_type || mode, platform: item.platform || item.format || '', project_id: item.project || selectedProject?.id || null, generation_inputs: item.generation_inputs || generationInputs, status: 'saved' }
    try {
      const saved = item.id ? await updateMarketingContent(item.id, payload) : await saveMarketingContent(payload)
      setResults(current => current.map(row => row.localKey === item.localKey || row.id === item.id ? { ...row, ...saved, saved: true, projectName: saved.project_name || row.projectName } : row))
      await loadLibrary()
      setNotice('Saved to your content library.')
    } catch (err) { setError(err.message || 'This draft could not be saved.') }
  }
  const deleteSaved = async item => {
    try { await deleteMarketingContent(item.id); setLibrary(current => current.filter(row => row.id !== item.id)); setResults(current => current.filter(row => row.id !== item.id)); setNotice('Saved draft deleted.') }
    catch (err) { setError(err.message || 'Could not delete this saved draft.') }
  }
  const refine = async (item, action) => {
    const key = `${item.localKey || item.id}:${action}`
    setRefineBusy(key); setError('')
    try {
      const response = await generateMarketingContent({ mode: 'refine', project_id: item.project || selectedProject?.id || null, inputs: { ...(item.generation_inputs || generationInputs), source_title: item.title || '', source_content: item.body, refinement_action: action, extra_instructions: action === 'change tone' ? `Change tone to ${inputs.tone}.` : (item.generation_inputs?.extra_instructions || '') } })
      const newDraft = makeWorkspaceItem(response.result.items[0])
      setResults(current => current.map(row => row.localKey === item.localKey || (item.id && row.id === item.id) ? { ...row, ...newDraft, localKey: row.localKey, id: row.id, saved: Boolean(row.id), generation_inputs: row.generation_inputs } : row))
      setNotice(`Draft ${action}d. Review the result before saving.`)
    } catch (err) { setError(err.message || `Could not ${action} this draft.`) }
    finally { setRefineBusy('') }
  }
  const openSaved = item => {
    setSelectedId(item.project || 'custom')
    setResults(current => [{ ...item, localKey: `saved-${item.id}`, saved: true, generation_inputs: item.generation_inputs || {}, projectName: item.project_name }])
    setMode(item.content_type || 'tool'); setActiveTab('create'); setApproach('Saved draft reopened for editing.')
    if (item.generation_inputs) setInputs(current => ({ ...current, ...item.generation_inputs }))
  }
  const duplicateSaved = item => {
    openSaved({ ...item, id: null, title: `${item.title} — copy`, status: 'draft' })
    setNotice('Copy opened as an unsaved draft.')
  }
  const repurposeResult = item => {
    setSelectedId(item.project || selectedId); setMode('repurpose'); setField('source_content', item.body); setField('topic', item.title); setActiveTab('repurpose'); setNotice('Source text added. Choose the formats to create.')
  }
  const toggleFormat = format => setField('formats', inputs.formats.includes(format) ? inputs.formats.filter(item => item !== format) : [...inputs.formats, format])
  const visibleLibrary = library.filter(item => !libraryFilters.q || `${item.title} ${item.body}`.toLowerCase().includes(libraryFilters.q.toLowerCase()))

  return <div className="ud-dashboard ms-page">
    <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
    <div className="ud-work-area">
      <header className="ud-topbar"><div className="ud-topbar-left"><button className="ud-mobile-menu ud-icon-button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={20} /></button><span className="ms-breadcrumb">Create <span>/</span> <b>Marketing Studio</b></span></div><div className="ud-topbar-actions"><span className="ms-private-note"><Sparkles size={13} /> Drafts only · no auto-publishing</span></div></header>
      <main className="ud-main"><div className="ms-content">
        <section className="ms-heading"><div><span className="ms-eyebrow"><Megaphone size={15} /> MARKETING STUDIO</span><h1>Turn your ideas into content worth sharing.</h1><p>Make project-aware posts, campaigns and creative that stays grounded in what’s real.</p></div>
          <label className="ms-project-select"><span>Creating for</span><select value={selectedProject?.id || 'custom'} onChange={event => { setSelectedId(event.target.value); setResults([]); setApproach(''); setError('') }}><option value="custom">Custom Content — No Project</option>{savedProjects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><ChevronDown size={15} /></label>
        </section>
        {error && <div className="ms-feedback ms-error" role="alert"><X size={15} />{error}<button onClick={() => setError('')} aria-label="Dismiss"><X size={14} /></button></div>}
        {notice && <div className="ms-feedback ms-success" role="status"><Check size={15} />{notice}<button onClick={() => setNotice('')} aria-label="Dismiss"><X size={14} /></button></div>}
        <nav className="ms-tabs" aria-label="Marketing Studio sections">{tabs.map(tab => { const Icon = tab.icon; return <button type="button" key={tab.id} className={activeTab === tab.id ? 'active' : ''} onClick={() => switchTab(tab.id)}><Icon size={15} />{tab.label}</button> })}</nav>
        {activeTab === 'saved' ? <section className="ms-panel ms-library-panel"><div className="ms-panel-heading"><div><span className="ms-eyebrow">YOUR LIBRARY</span><h2>Saved content</h2><p>Drafts are private to your account or this browser workspace.</p></div><button className="ms-secondary" onClick={() => void loadLibrary()} disabled={libraryBusy}><RefreshCw size={14} /> Refresh</button></div>
          <div className="ms-library-filters"><label><Search size={15} /><input placeholder="Search saved drafts" value={libraryFilters.q} onChange={event => setLibraryFilters(current => ({ ...current, q: event.target.value }))} /></label><select value={libraryFilters.project} onChange={event => setLibraryFilters(current => ({ ...current, project: event.target.value }))}><option value="">All projects</option><option value="custom">Custom content</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><select value={libraryFilters.type} onChange={event => setLibraryFilters(current => ({ ...current, type: event.target.value }))}><option value="">All types</option>{Object.entries(navCopy).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select><select value={libraryFilters.platform} onChange={event => setLibraryFilters(current => ({ ...current, platform: event.target.value }))}><option value="">All platforms</option>{platforms.map(value => <option value={value} key={value}>{value}</option>)}</select></div>
          {libraryBusy ? <div className="ms-empty"><span className="ms-spinner" /> Loading your library…</div> : visibleLibrary.length ? <div className="ms-library-grid">{visibleLibrary.map(item => <SavedCard key={item.id} item={item} onOpen={openSaved} onDuplicate={duplicateSaved} onDelete={deleteSaved} />)}</div> : <EmptyState title={libraryLoaded ? 'Your library is ready for a first draft' : 'Loading saved content'} copy={libraryLoaded ? 'Save a generated variation to keep it here for later editing.' : 'Fetching content saved to this workspace.'} />}
        </section> : <>
          <section className="ms-create-layout">
            <div className="ms-panel ms-form-panel">
              <div className="ms-panel-heading"><div><span className="ms-eyebrow">CREATE CONTENT</span><h2>What do you want to create?</h2><p>Give UDAAN a clear brief. You can edit every result before sharing it.</p></div><span className="ms-lock-note"><Sparkles size={13} /> AI draft</span></div>
              {activeTab === 'create' && <div className="ms-type-grid">{contentTypes.map(type => <ContentTypeCard key={type.mode} item={type} selected={mode === type.mode} onClick={() => setMode(type.mode)} />)}</div>}
              {activeTab !== 'create' && <div className="ms-mode-notice"><span className="ms-type-icon"><WandSparkles size={17} /></span><div><b>{tabs.find(item => item.id === activeTab)?.label}</b><small>{activeTab === 'campaign' ? 'A proposed publishing plan—nothing gets scheduled.' : activeTab === 'repurpose' ? 'Preserve the source meaning while adapting its format.' : 'Use your project context to draft a shareable story.'}</small></div></div>}
              {selectedProject && <section className="ms-context-card"><div className="ms-context-top"><span className="ms-context-mark">{selectedProject.name.slice(0, 1).toUpperCase()}</span><div><strong>{selectedProject.name}</strong><small>{selectedProject.project_type} · project context added automatically</small></div><button type="button" onClick={() => setEditContext(value => !value)}>{editContext ? 'Close context editor' : <><Pencil size={13} /> Edit context</>}</button></div>
                {!editContext ? <div className="ms-context-summary"><p>{selectedProject.description || selectedProject.idea || 'No project description has been added yet.'}</p><div>{(selectedProject.repository?.detected_technologies || []).slice(0, 5).map(item => <span key={item.name || item}>{item.name || item}</span>)}<small>{summary.milestones.length} planned milestones · {summary.completed} tasks marked complete · {summary.verified} independently verified</small></div></div> : <label className="ms-context-edit">Add, correct or remove details for this generation<textarea rows="5" maxLength="7000" value={inputs.context_override} onChange={event => setField('context_override', event.target.value)} placeholder="Correct the project summary or add confirmed details. Avoid adding claims you cannot support." /></label>}
                <p className="ms-context-footnote">Planned features remain plans. A task marked complete is user-recorded progress; verified claims require saved check evidence.</p>
              </section>}
              <form className="ms-form" onSubmit={generate}>
                <div className="ms-form-grid">
                  <label className="ms-field ms-wide"><span>{mode === 'repurpose' ? 'Source content' : mode === 'campaign' ? 'Campaign topic or project' : 'Topic, project or request'} <i>*</i></span><textarea rows={mode === 'repurpose' ? 5 : 3} maxLength={8000} value={mode === 'repurpose' ? inputs.source_content : inputs.topic} onChange={event => setField(mode === 'repurpose' ? 'source_content' : 'topic', event.target.value)} placeholder={mode === 'repurpose' ? 'Paste the text or rough notes to transform…' : selectedProject ? 'For example: introduce the current booking flow in a portfolio post…' : 'For example: write a friendly introduction for my design portfolio…'} /></label>
                  {mode !== 'repurpose' && <><label className="ms-field"><span>Goal</span><select value={inputs.objective} onChange={event => setField('objective', event.target.value)}>{['awareness', 'engagement', 'launch', 'portfolio', 'recruitment', 'education', 'conversion'].map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></label><label className="ms-field"><span>Audience</span><input value={inputs.audience} onChange={event => setField('audience', event.target.value)} placeholder={selectedProject ? 'Use project audience' : 'Who should this reach?'} /></label></>}
                  {mode === 'social' && <label className="ms-field"><span>Platform</span><select value={inputs.platform} onChange={event => setField('platform', event.target.value)}>{platforms.map(value => <option key={value}>{value}</option>)}</select></label>}
                  {mode === 'showcase' && <label className="ms-field"><span>Showcase format</span><select value={inputs.showcase_type} onChange={event => setField('showcase_type', event.target.value)}>{showcaseTypes.map(value => <option key={value}>{value}</option>)}</select></label>}
                  {mode === 'tool' && <label className="ms-field"><span>Marketing tool</span><select value={inputs.template} onChange={event => setField('template', event.target.value)}>{toolTypes.map(value => <option key={value}>{value}</option>)}</select></label>}
                  {mode === 'campaign' && <><label className="ms-field"><span>Campaign length</span><select value={inputs.campaign_days} onChange={event => setField('campaign_days', Number(event.target.value))}><option value={7}>7-day plan</option><option value={30}>30-day plan</option></select></label><label className="ms-field"><span>Primary platform</span><select value={inputs.campaign_platform} onChange={event => setField('campaign_platform', event.target.value)}>{platforms.map(value => <option key={value}>{value}</option>)}</select></label></>}
                  {mode === 'repurpose' && <div className="ms-field ms-wide"><span>Output formats</span><div className="ms-format-list">{formats.map(format => <label key={format}><input type="checkbox" checked={inputs.formats.includes(format)} onChange={() => toggleFormat(format)} /><span>{format}</span></label>)}</div></div>}
                  {mode !== 'campaign' && mode !== 'repurpose' && <label className="ms-field"><span>Tone</span><select value={inputs.tone} onChange={event => setField('tone', event.target.value)}>{tones.map(value => <option key={value}>{value}</option>)}</select></label>}
                  {mode !== 'campaign' && mode !== 'repurpose' && <label className="ms-field"><span>Length</span><select value={inputs.length} onChange={event => setField('length', event.target.value)}>{['Short', 'Medium', 'Long'].map(value => <option key={value}>{value}</option>)}</select></label>}
                  {mode !== 'repurpose' && mode !== 'campaign' && <label className="ms-field"><span>Keywords <small>optional</small></span><input value={inputs.keywords} onChange={event => setField('keywords', event.target.value)} placeholder="Terms to include" /></label>}
                  {mode !== 'repurpose' && mode !== 'campaign' && <label className="ms-field"><span>Call to action <small>optional</small></span><input value={inputs.cta} onChange={event => setField('cta', event.target.value)} placeholder="What should readers do next?" /></label>}
                  <label className="ms-field ms-wide"><span>Additional instructions <small>optional</small></span><textarea rows="2" maxLength="1800" value={inputs.extra_instructions} onChange={event => setField('extra_instructions', event.target.value)} placeholder="Add confirmed details, phrases to avoid, or a specific creative direction." /></label>
                </div>
                <div className="ms-form-foot"><span><Sparkles size={14} /> {selectedProject ? 'Uses your saved project details and repository evidence.' : 'Custom mode supports unrelated creative requests.'} No live trend research is configured.</span><button className="ms-primary" type="submit" disabled={generationBusy}>{generationBusy ? <><span className="ms-spinner" /> Creating drafts…</> : <><Sparkles size={15} /> Generate content <ArrowRight size={15} /></>}</button></div>
              </form>
            </div>
            <aside className="ms-side-panel"><div className="ms-side-card"><span className="ms-eyebrow">QUICK START</span><h3>Start with a format</h3><p>Pick a useful output, then tailor the brief.</p>{contentTypes.map(type => <button className="ms-quick-action" key={type.mode} onClick={() => { setMode(type.mode); setActiveTab(type.mode === 'showcase' ? 'showcase' : type.mode === 'repurpose' ? 'repurpose' : type.mode === 'campaign' ? 'campaign' : 'create') }}><span><type.icon size={15} /></span><b>{type.title}</b><ArrowRight size={13} /></button>)}</div>
              <div className="ms-side-card ms-recent-card"><div className="ms-side-head"><div><span className="ms-eyebrow">RECENTLY SAVED</span><h3>Your library</h3></div><button onClick={() => switchTab('saved')}>View all <ArrowRight size={13} /></button></div>{library.slice(0, 3).length ? library.slice(0, 3).map(item => <button className="ms-recent-item" key={item.id} onClick={() => openSaved(item)}><span>{item.title}</span><small>{item.project_name || 'Custom content'} · {dateLabel(item.updated_at)}</small></button>) : <p className="ms-recent-empty">Your saved drafts will appear here.</p>}</div>
            </aside>
          </section>
          {mode === 'repurpose' && activeTab === 'repurpose' && <p className="ms-repurpose-hint">Choose the formats above. UDAAN will create one draft for each selected format, preserving the original source meaning.</p>}
          {approach && results.length > 0 && <div className="ms-approach"><Sparkles size={15} /><div><b>Creative direction</b><span>{approach}</span></div></div>}
          {results.length > 0 && <section className="ms-results"><div className="ms-results-heading"><div><span className="ms-eyebrow">YOUR DRAFTS</span><h2>Review, edit and choose a favorite</h2><p>{results.length} editable option{results.length === 1 ? '' : 's'} · nothing is published automatically</p></div><button className="ms-secondary" onClick={generate} disabled={generationBusy}><RefreshCw size={14} /> Regenerate set</button></div><div className="ms-result-grid">{results.map((item, index) => <ResultCard key={item.localKey || item.id || index} item={item} index={index} busy={refineBusy} copying={copying} tone={inputs.tone} onChange={(key, value) => setResults(current => current.map(row => row === item ? { ...row, [key]: value } : row))} onCopy={() => void copyResult(item)} onDownload={() => downloadResult(item)} onSave={() => void saveResult(item)} onRefine={action => void refine(item, action)} onRepurpose={() => repurposeResult(item)} />)}</div></section>}
        </>}
      </div></main>
    </div>
  </div>
}

function ContentTypeCard({ item, selected, onClick }) { const Icon = item.icon; return <button type="button" className={`ms-type-card ${selected ? 'selected' : ''}`} onClick={onClick}><span className="ms-type-icon"><Icon size={17} /></span><b>{item.title}</b><small>{item.subtitle}</small></button> }
function EmptyState({ title, copy }) { return <div className="ms-empty"><span className="ms-empty-icon"><Bookmark size={19} /></span><h3>{title}</h3><p>{copy}</p></div> }
function ResultCard({ item, index, busy, copying, tone, onChange, onCopy, onDownload, onSave, onRefine, onRepurpose }) {
  const key = item.localKey || item.id
  const refinements = [['improve hook', 'Improve hook'], ['shorten', 'Shorten'], ['expand', 'Expand'], ['change tone', 'Change tone']]
  return <article className="ms-result-card"><header><div><span className="ms-result-kicker">{item.day ? `DAY ${item.day}` : `OPTION ${index + 1}`}</span><span className="ms-result-platform">{item.platform || item.format}</span></div><button type="button" className={`ms-favorite ${item.favorite ? 'selected' : ''}`} title={item.favorite ? 'Favorite' : 'Mark favorite'} onClick={() => onChange('favorite', !item.favorite)}><span>{item.favorite ? '★' : '☆'}</span></button></header>
    <label className="ms-result-title"><span>Title / hook</span><input value={item.title || ''} onChange={event => onChange('title', event.target.value)} /></label>
    {item.objective && <span className="ms-objective">{item.objective}</span>}
    <label className="ms-result-body"><span>Editable content</span><textarea rows={Math.min(18, Math.max(7, (item.body || '').split('\n').length + 3))} value={item.body || ''} onChange={event => onChange('body', event.target.value)} /></label>
    {item.rationale && <p className="ms-rationale"><Sparkles size={12} />{item.rationale}</p>}
    <div className="ms-result-actions"><button onClick={onCopy}><Copy size={13} />{copying === key ? 'Copied' : 'Copy'}</button><button onClick={onDownload}><ArrowDownToLine size={13} /> Export</button><button className="ms-save-draft" onClick={onSave}><Bookmark size={13} />{item.id ? 'Save edits' : item.saved ? 'Saved' : 'Save to library'}</button></div>
    <details className="ms-refine"><summary><WandSparkles size={13} /> Refine this draft</summary><div>{refinements.map(([action, label]) => <button key={action} disabled={busy === `${key}:${action}`} onClick={() => onRefine(action)}>{busy === `${key}:${action}` ? <span className="ms-spinner" /> : <Sparkles size={12} />}{label}</button>)}<button disabled={busy === `${key}:regenerate`} onClick={() => onRefine('regenerate')}><RefreshCw size={12} />Regenerate</button><button onClick={onRepurpose}><ArrowRight size={12} />Repurpose</button></div><small>Change tone uses the selected “{tone}” tone. Original request settings are retained.</small></details>
  </article>
}
function SavedCard({ item, onOpen, onDuplicate, onDelete }) { return <article className="ms-saved-card"><div className="ms-saved-meta"><span>{item.content_type || 'Draft'}</span><span>{item.platform || 'Custom format'}</span></div><h3>{item.title}</h3><p>{item.body}</p><div className="ms-saved-foot"><span>{item.project_name || 'Custom content'} · {dateLabel(item.updated_at)}</span><div><button title="Open and edit" onClick={() => onOpen(item)}><Pencil size={13} /></button><button title="Duplicate" onClick={() => onDuplicate(item)}><Copy size={13} /></button><button title="Delete" onClick={() => onDelete(item)}><X size={14} /></button></div></div></article> }
