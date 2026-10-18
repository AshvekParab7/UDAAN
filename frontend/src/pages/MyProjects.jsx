import { useMemo, useState } from 'react'
import {
  ArrowRight, Bell, Bolt, Check, ChevronDown, CircleCheck, GraduationCap, Menu,
  Grid2X2, List, MoreHorizontal, Plus, Rocket, Search, SlidersHorizontal, Sparkles,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import Sidebar from '../layouts/Sidebar.jsx'
import { readSavedProjects } from '../services/projectStorage.js'

const initialProjects = [
  {
    id: 'ecotrack', name: 'EcoTrack — Smart Sustainability Platform',
    description: 'Enterprise ESG telemetry aggregator with streaming IoT sensor connectors, Pydantic v2 schemas, and automated GHG calculations.',
    category: 'Startup', status: 'in-progress', statusLabel: 'In flight', level: 'Level 3: Build the Core', xp: '450 / 1,200 XP', progress: 38,
    milestone: 'IoT data pipeline', stack: ['FastAPI', 'React', 'PostgreSQL'], team: ['TS', 'DS', 'AK'], updated: 'Updated 5 minutes ago', tone: 'forest',
  },
  {
    id: 'neohealth', name: 'NeoHealth FHIR Sync',
    description: 'Bi-directional HL7/FHIR v4 medical record reconciliation with cryptographic audit trails and offline cache.',
    category: 'College Project', status: 'completed', statusLabel: 'Viva ready', level: 'Level 6: Viva Ready & Deployed', xp: '1,100 / 1,200 XP', progress: 92,
    milestone: 'Final dry-run stage', stack: ['Django', 'FHIR', 'PostgreSQL'], team: ['TS', 'MV'], updated: 'Updated yesterday', tone: 'sage',
  },
  {
    id: 'liquidity', name: 'Liquidity AMM Engine',
    description: 'Deterministic constant-product market maker with cross-slot arbitrage simulations and gas-optimized settlement.',
    category: 'Personal Lab', status: 'planning', statusLabel: 'Planning', level: 'Level 2: System Specs', xp: '200 / 1,200 XP', progress: 18,
    milestone: 'Drafting math verification', stack: ['Rust', 'Axum', 'Solana'], team: ['DS'], updated: 'Updated yesterday', tone: 'violet',
  },
  {
    id: 'aeroshield', name: 'AeroShield Autonomous Drone Router',
    description: 'Decentralized mesh telemetry and dynamic waypoint collision avoidance for agricultural drone clusters.',
    category: 'Hackathon', status: 'in-progress', statusLabel: 'Active sprint', level: 'Level 4: Connect the Wings', xp: '650 / 1,200 XP', progress: 54,
    milestone: 'ROS2 integration', stack: ['Go', 'ROS2', 'Protobuf'], team: ['TS', 'MV', 'SK'], updated: 'Updated 1 day ago', tone: 'blue',
  },
  {
    id: 'carbonpulse', name: 'CarbonPulse MRV Exchanger',
    description: 'Carbon offset registry verification protocol with verifiable satellite multispectral data ingestion.',
    category: 'Startup', status: 'archived', statusLabel: 'Archived & live', level: 'Level 6: Ready for Takeoff', xp: '1,200 / 1,200 XP', progress: 100,
    milestone: 'Fully verified', stack: ['FastAPI', 'React', 'PostgreSQL'], team: ['TS', 'DS', 'AK'], updated: 'Completed 3 weeks ago', tone: 'gold',
  },
]

const tabs = [
  { id: 'all', label: 'All' }, { id: 'in-progress', label: 'In Progress' },
  { id: 'planning', label: 'Planning' }, { id: 'completed', label: 'Completed' }, { id: 'archived', label: 'Archived' },
]
const categoryIcon = { Startup: Rocket, Hackathon: Bolt, 'College Project': GraduationCap, 'Personal Lab': Sparkles, 'Personal Project': Sparkles }

function ProjectCard({ project, onOptions }) {
  const CategoryIcon = categoryIcon[project.category] ?? Rocket
  return <article className="mp-card">
    <div className="mp-card-top"><span className={`mp-category ${project.tone}`}><CategoryIcon size={13} />{project.category}</span>
      <div className="mp-card-tools"><span className={`mp-status ${project.status}`}>{project.status === 'completed' && <CircleCheck size={12} />}{project.statusLabel}</span><button className="mp-icon-button" aria-label={`Options for ${project.name}`} onClick={() => onOptions(project.name)}><MoreHorizontal size={18} /></button></div>
    </div>
    <div className="mp-card-description"><h2>{project.name}</h2><p>{project.description}</p></div>
    <div className="mp-progress-box"><div className="mp-progress-heading"><strong>{project.level}</strong><span>{project.xp}</span></div><div className="mp-progress-track"><span style={{ width: `${project.progress}%` }} /></div><div className="mp-progress-foot"><span>{project.progress}% complete</span><span>{project.milestone}</span></div></div>
    <div className="mp-stack">{project.stack.map(item => <span key={item}>{item}</span>)}</div>
    <div className="mp-card-footer"><div className="mp-avatars" aria-label="Project team">{project.team.map((person, index) => <span key={person} className={`avatar-${index % 3}`}>{person}</span>)}</div><span>{project.updated}</span></div>
    {project.workflow?.flight_plan ? <Link className="mp-card-action" to={`/flight-plan?project=${encodeURIComponent(project.id)}`}>Open Flight Plan<ArrowRight size={15} /></Link> : <button className="mp-card-action" onClick={() => onOptions(project.name)}>{project.status === 'completed' || project.status === 'archived' ? 'View Workspace' : 'Continue Building'}<ArrowRight size={15} /></button>}
  </article>
}

export default function MyProjects() {
  const [projects, setProjects] = useState(() => [...readSavedProjects(), ...initialProjects])
  const [activeTab, setActiveTab] = useState('all')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All Types')
  const [sortBy, setSortBy] = useState('Recently Updated')
  const [view, setView] = useState('grid')
  const [notice, setNotice] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)

  const counts = useMemo(() => ({
    all: projects.length,
    'in-progress': projects.filter(project => project.status === 'in-progress').length,
    planning: projects.filter(project => project.status === 'planning').length,
    completed: projects.filter(project => project.status === 'completed').length,
    archived: projects.filter(project => project.status === 'archived').length,
  }), [projects])

  const visibleProjects = useMemo(() => {
    const filtered = projects.filter(project => {
      const statusMatches = activeTab === 'all' || project.status === activeTab
      const typeMatches = category === 'All Types' || project.category === category
      const queryMatches = `${project.name} ${project.description} ${project.category} ${project.stack.join(' ')}`.toLowerCase().includes(search.toLowerCase())
      return statusMatches && typeMatches && queryMatches
    })
    if (sortBy === 'Highest Progress') return filtered.sort((a, b) => b.progress - a.progress)
    if (sortBy === 'Alphabetical') return filtered.sort((a, b) => a.name.localeCompare(b.name))
    if (sortBy === 'Deadline Approaching') return filtered.sort((a, b) => a.progress - b.progress)
    return filtered
  }, [activeTab, category, projects, search, sortBy])

  function createProject() {
    setNotice('Start with your idea on the dashboard.')
    window.setTimeout(() => setNotice(''), 3000)
  }

  function projectAction(name) {
    setNotice(`${name} workspace is ready to continue.`)
    window.setTimeout(() => setNotice(''), 3000)
  }

  return <div className="ud-dashboard mp-page">
    <Sidebar activePage="projects" open={menuOpen} onClose={() => setMenuOpen(false)} />
    <div className="ud-work-area">
      <header className="ud-topbar">
        <div className="ud-topbar-left"><button className="ud-mobile-menu ud-icon-button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={20} /></button><span className="ud-topbar-title">My Projects</span></div>
        <div className="ud-topbar-actions"><label className="ud-search"><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search workspace" aria-label="Search workspace" /></label><button className="ud-icon-button" aria-label="Notifications"><Bell size={18} /></button><button className="ud-top-account"><span className="ud-avatar ud-top-avatar">TS</span><span>Tara</span><ChevronDown size={14} /></button></div>
      </header>
      <main className="ud-main mp-main">
        <div className="mp-content">
          <div className="mp-heading-row"><div><div className="mp-eyebrow">Your workspace</div><h1>My Projects</h1><p>Every idea has a journey. Pick up where you left off.</p></div><Link className="mp-new-project" to="/"><Plus size={16} />New Project</Link></div>
          <div className="mp-summary"><span><Rocket size={15} /> <strong>{counts['in-progress'] + counts.planning}</strong> active projects</span><i /><span><Check size={15} /> <strong>{counts.completed + counts.archived}</strong> finished</span></div>
          <div className="mp-controls">
            <label className="mp-search"><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search projects by name, stack, or keyword..." aria-label="Search projects" /></label>
            <label className="mp-select-wrap"><SlidersHorizontal size={15} /><select aria-label="Filter by project type" value={category} onChange={event => setCategory(event.target.value)}><option>All Types</option><option>Startup</option><option>Hackathon</option><option>College Project</option><option>Personal Lab</option><option>Personal Project</option></select><ChevronDown size={14} /></label>
            <label className="mp-select-wrap mp-sort"><select aria-label="Sort projects" value={sortBy} onChange={event => setSortBy(event.target.value)}><option>Recently Updated</option><option>Highest Progress</option><option>Alphabetical</option><option>Deadline Approaching</option></select><ChevronDown size={14} /></label>
            <div className="mp-view-toggle" aria-label="Project layout"><button aria-label="Grid view" className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')}><Grid2X2 size={16} /></button><button aria-label="List view" className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}><List size={17} /></button></div>
          </div>
          <div className="mp-tabs" role="tablist" aria-label="Filter projects by status">{tabs.map(tab => <button role="tab" aria-selected={activeTab === tab.id} className={activeTab === tab.id ? 'active' : ''} key={tab.id} onClick={() => setActiveTab(tab.id)}>{tab.label}<span>{counts[tab.id]}</span></button>)}</div>
          {visibleProjects.length ? <div className={`mp-project-grid ${view === 'list' ? 'list-view' : ''}`}>{visibleProjects.map(project => <ProjectCard key={project.id} project={project} onOptions={projectAction} />)}<Link className="mp-create-card" to="/"><span className="mp-create-icon"><Plus size={22} /></span><strong>Start something new</strong><small>Bring an idea and we’ll help you shape the plan.</small><span className="mp-create-link">Create a project <ArrowRight size={14} /></span></Link></div> : <div className="mp-empty"><span><Search size={20} /></span><h2>{activeTab === 'archived' ? 'No archived projects yet' : 'No projects found'}</h2><p>{activeTab === 'archived' ? 'Completed projects you archive will be saved here.' : 'Try another search or filter to find a project.'}</p><button onClick={() => { setSearch(''); setCategory('All Types'); setActiveTab('all') }}>Show all projects</button></div>}
          {notice && <div className="mp-toast" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss">×</button></div>}
        </div>
      </main>
    </div>
  </div>
}
