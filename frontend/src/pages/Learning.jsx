import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Bookmark, BookOpen, Check, CheckCircle2, ChevronDown, Clock3, Code2, ExternalLink, GraduationCap, Lightbulb, LoaderCircle, Menu, MessageCircle, Play, Search, Sparkles, Target, Youtube } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import Sidebar from '../layouts/Sidebar.jsx'
import { readSavedProjects } from '../services/projectStorage.js'
import { askLearningTutor, getLearningProject, getLearningRecommendations, getLearningState, listLearningProjects, saveLearningState } from '../services/learningService.js'
import './Learning.css'

const resources = [
  // React
  { id: 'react-quickstart', title: 'Quick Start', provider: 'React documentation', type: 'documentation', difficulty: 'Beginner', minutes: 30, url: 'https://react.dev/learn', topics: ['react', 'components', 'state', 'frontend'], tags: ['React', 'UI'], description: 'Learn components, rendering, events and state from the official React guide.' },
  { id: 'react-example', title: 'Build Tic-Tac-Toe', provider: 'React documentation', type: 'example', difficulty: 'Beginner', minutes: 60, url: 'https://react.dev/learn/tutorial-tic-tac-toe', topics: ['react', 'components', 'state', 'frontend', 'practice'], tags: ['React', 'Example'], description: 'Build a small interactive app while practicing components, state and event handling.' },
  // Django / Python
  { id: 'django-tutorial', title: 'Django Tutorial', provider: 'Django documentation', type: 'documentation', difficulty: 'Beginner', minutes: 120, url: 'https://docs.djangoproject.com/en/stable/intro/tutorial01/', topics: ['django', 'python', 'models', 'views', 'backend'], tags: ['Django', 'Python'], description: 'Build a small Django application while learning the framework\'s core structure.' },
  { id: 'drf-quickstart', title: 'Quickstart', provider: 'Django REST framework', type: 'documentation', difficulty: 'Intermediate', minutes: 45, url: 'https://www.django-rest-framework.org/tutorial/quickstart/', topics: ['django rest framework', 'api', 'serialization', 'backend'], tags: ['Django REST Framework', 'API'], description: 'Create serializers, views and routes for a REST API.' },
  { id: 'python-tutorial', title: 'The Python Tutorial', provider: 'Python documentation', type: 'documentation', difficulty: 'Beginner', minutes: 90, url: 'https://docs.python.org/3/tutorial/index.html', topics: ['python', 'django', 'backend'], tags: ['Python'], description: 'A practical introduction to the Python language for programmers.' },
  // MDN Guides
  { id: 'mdn-fetch', title: 'Making Network Requests', provider: 'MDN Web Docs', type: 'guide', difficulty: 'Beginner', minutes: 35, url: 'https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Scripting/Network_requests', topics: ['fetch', 'api', 'http', 'react', 'integration'], tags: ['JavaScript', 'API'], description: 'Understand asynchronous requests and how browser code communicates with an API.' },
  { id: 'mdn-auth', title: 'HTTP Authentication', provider: 'MDN Web Docs', type: 'guide', difficulty: 'Intermediate', minutes: 25, url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Authentication', topics: ['authentication', 'auth', 'http', 'security', 'login'], tags: ['HTTP', 'Security'], description: 'Learn the HTTP authentication challenge and response model.' },
  { id: 'mdn-css', title: 'CSS Basics', provider: 'MDN Web Docs', type: 'guide', difficulty: 'Beginner', minutes: 40, url: 'https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Styling_basics', topics: ['css', 'frontend', 'design', 'ui'], tags: ['CSS', 'Frontend'], description: 'Understand selectors, the box model, and layout techniques used in modern web design.' },
  { id: 'mdn-js-async', title: 'Asynchronous JavaScript', provider: 'MDN Web Docs', type: 'guide', difficulty: 'Intermediate', minutes: 50, url: 'https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Async_JS', topics: ['javascript', 'async', 'promises', 'fetch', 'api'], tags: ['JavaScript', 'Async'], description: 'Master promises, async/await, and how to handle data from APIs without blocking the UI.' },
  // Interactive
  { id: 'python-visualizer', title: 'Python Tutor Visualizer', provider: 'Python Tutor', type: 'interactive', difficulty: 'Beginner', minutes: 15, url: 'https://pythontutor.com/visualize.html', topics: ['python', 'javascript', 'debugging', 'fundamentals'], tags: ['Python', 'JavaScript'], description: 'Step through a short program and see how its values change as it runs.' },
  { id: 'github-skills', title: 'GitHub Skills', provider: 'GitHub', type: 'interactive', difficulty: 'Beginner', minutes: 60, url: 'https://skills.github.com/', topics: ['git', 'github', 'workflow', 'deployment'], tags: ['Git', 'GitHub'], description: 'Practice software workflows with hands-on GitHub exercises.' },
  { id: 'flexbox-froggy', title: 'Flexbox Froggy', provider: 'Flexbox Froggy', type: 'interactive', difficulty: 'Beginner', minutes: 25, url: 'https://flexboxfroggy.com/', topics: ['css', 'frontend', 'flexbox', 'layout'], tags: ['CSS', 'Frontend'], description: 'Learn CSS Flexbox layout by guiding a frog to its lilypad through 24 interactive levels.' },
  { id: 'sql-zoo', title: 'SQLZoo', provider: 'SQLZoo', type: 'interactive', difficulty: 'Beginner', minutes: 60, url: 'https://sqlzoo.net/', topics: ['sql', 'database', 'backend', 'data'], tags: ['SQL', 'Database'], description: 'Hands-on SQL exercises ranging from simple SELECT queries to complex joins and aggregations.' },
  // Practical examples
  { id: 'todo-react', title: 'Build a To-Do App in React', provider: 'Scrimba · YouTube', type: 'example', difficulty: 'Beginner', minutes: 45, url: 'https://scrimba.com/learn-react-c0e', topics: ['react', 'components', 'state', 'frontend', 'practice'], tags: ['React', 'Example'], description: 'Build a complete to-do list while drilling down on React state and component structure.' },
  { id: 'rest-api-example', title: 'Build a REST API with Django', provider: 'TestDriven.io', type: 'example', difficulty: 'Intermediate', minutes: 90, url: 'https://testdriven.io/blog/django-rest-framework/', topics: ['django rest framework', 'api', 'backend', 'python', 'practice'], tags: ['Django', 'API'], description: 'Step-by-step guide to building and testing a real Django REST API from scratch.' },
  // YouTube tutorials
  { id: 'yt-react-full', title: 'Learn React — Full Course for Beginners', provider: 'freeCodeCamp.org', type: 'youtube', difficulty: 'Beginner', minutes: 300, url: 'https://www.youtube.com/watch?v=DLX62G4lc44', videoId: 'DLX62G4lc44', topics: ['react', 'javascript', 'components', 'frontend'], tags: ['React', 'JavaScript'], description: 'A complete React course covering components, hooks, state, props and building real projects.' },
  { id: 'yt-python-beginner', title: 'Python for Beginners — Full Course', provider: 'Programming with Mosh', type: 'youtube', difficulty: 'Beginner', minutes: 360, url: 'https://www.youtube.com/watch?v=_uQrJ0TkZlc', videoId: '_uQrJ0TkZlc', topics: ['python', 'backend', 'fundamentals', 'django'], tags: ['Python', 'Backend'], description: 'Master Python from scratch: variables, control flow, functions, OOP and working with files.' },
  { id: 'yt-django-crash', title: 'Django Crash Course', provider: 'Traversy Media', type: 'youtube', difficulty: 'Beginner', minutes: 100, url: 'https://www.youtube.com/watch?v=e1IyzVyrLSU', videoId: 'e1IyzVyrLSU', topics: ['django', 'python', 'backend', 'models', 'views'], tags: ['Django', 'Python'], description: 'Build a Django app from zero — models, views, templates, and the admin panel explained clearly.' },
  { id: 'yt-git-github', title: 'Git and GitHub — Full Course', provider: 'freeCodeCamp.org', type: 'youtube', difficulty: 'Beginner', minutes: 180, url: 'https://www.youtube.com/watch?v=RGOj5yH7evk', videoId: 'RGOj5yH7evk', topics: ['git', 'github', 'workflow', 'deployment', 'version control'], tags: ['Git', 'GitHub'], description: 'Everything you need to know about version control, branching, pull requests and collaboration.' },
  { id: 'yt-js-crash', title: 'JavaScript Crash Course', provider: 'Traversy Media', type: 'youtube', difficulty: 'Beginner', minutes: 90, url: 'https://www.youtube.com/watch?v=hdI2bqOjy3c', videoId: 'hdI2bqOjy3c', topics: ['javascript', 'frontend', 'async', 'fetch', 'api'], tags: ['JavaScript', 'Frontend'], description: 'JavaScript fundamentals in one video: DOM, events, functions, arrays, objects and ES6+.' },
  { id: 'yt-css-full', title: 'CSS Full Course — Flexbox & Grid', provider: 'Dave Gray', type: 'youtube', difficulty: 'Beginner', minutes: 240, url: 'https://www.youtube.com/watch?v=n4R2E7O-Ngo', videoId: 'n4R2E7O-Ngo', topics: ['css', 'frontend', 'flexbox', 'grid', 'design', 'ui'], tags: ['CSS', 'Frontend'], description: 'Complete CSS course covering Flexbox, Grid, responsive design and modern layout techniques.' },
  { id: 'yt-api-rest', title: 'REST API Design Best Practices', provider: 'freeCodeCamp.org', type: 'youtube', difficulty: 'Intermediate', minutes: 60, url: 'https://www.youtube.com/watch?v=NiiejjVMZII', videoId: 'NiiejjVMZII', topics: ['api', 'rest', 'backend', 'http', 'integration'], tags: ['API', 'Backend'], description: 'Learn REST API design patterns, naming conventions, versioning and error handling.' },
  { id: 'yt-sql-full', title: 'SQL Full Course for Beginners', provider: 'freeCodeCamp.org', type: 'youtube', difficulty: 'Beginner', minutes: 240, url: 'https://www.youtube.com/watch?v=HXV3zeQKqGY', videoId: 'HXV3zeQKqGY', topics: ['sql', 'database', 'backend', 'data', 'models'], tags: ['SQL', 'Database'], description: 'Learn SQL from scratch: SELECT, joins, aggregations, subqueries and database design principles.' },
  { id: 'yt-ts-crash', title: 'TypeScript Crash Course', provider: 'Traversy Media', type: 'youtube', difficulty: 'Intermediate', minutes: 75, url: 'https://www.youtube.com/watch?v=BCg4U1FzODs', videoId: 'BCg4U1FzODs', topics: ['typescript', 'javascript', 'frontend', 'react'], tags: ['TypeScript', 'JavaScript'], description: 'Get up to speed with TypeScript: types, interfaces, generics and integrating with React.' },
  { id: 'yt-docker-intro', title: 'Docker for Beginners', provider: 'TechWorld with Nana', type: 'youtube', difficulty: 'Intermediate', minutes: 120, url: 'https://www.youtube.com/watch?v=3c-iBn73dDE', videoId: '3c-iBn73dDE', topics: ['docker', 'deployment', 'devops', 'backend', 'workflow'], tags: ['Docker', 'DevOps'], description: 'Understand containers, images, Docker Compose and how to containerise a web application.' },
]
const categories = [
  ['all', 'All resources'], ['youtube', 'YouTube tutorials'], ['documentation', 'Official documentation'], ['guide', 'Articles & guides'], ['interactive', 'Interactive exercises'], ['example', 'Practical examples'],
]

const text = value => typeof value === 'string' ? value : ''
function normalizeProject(project) {
  const understanding = project.understanding || {}
  return {
    ...project,
    id: project.id,
    name: project.name || understanding.project_name || 'Untitled project',
    category: project.category || project.project_type || 'Project',
    idea: project.idea || '',
    description: project.description || understanding.problem_statement || project.idea || '',
    workflow: project.workflow || {},
    stack: project.stack || project.repository?.detected_technologies || [],
    repository: project.repository || null,
  }
}
function slug(value) { return String(value || 'step').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'step' }
function taskItems(project) {
  return (project.workflow?.flight_plan?.milestones || []).flatMap((milestone, milestoneIndex) => (milestone.tasks || []).map((task, taskIndex) => ({
    key: `${milestoneIndex}-${taskIndex}`, milestone: milestone.title || `Milestone ${milestoneIndex + 1}`, milestoneIndex, taskIndex, ...task,
  })))
}
export function matchesResource(resource, project, task) {
  const stack = [...(project.stack || []), ...(project.repository?.detected_technologies || [])].join(' ').toLowerCase()
  const taskWords = `${task?.title || ''} ${task?.required_skills?.join(' ') || ''} ${task?.suggested_role || ''} ${task?.subtasks?.join(' ') || ''}`.toLowerCase()
  const haystack = `${stack} ${taskWords} ${project.description || ''}`
  return resource.topics.some(topic => haystack.includes(topic)) || (!task && resource.topics.some(topic => stack.includes(topic)))
}
export function fallbackPath(project, task, relevant) {
  const skills = [...new Set([...(task?.required_skills || []), ...(project.stack || []), ...(project.repository?.detected_technologies || [])])].slice(0, 5)
  const concepts = skills.length ? skills : [task?.title || 'Project fundamentals']
  return concepts.slice(0, 4).map((concept, index) => {
    const found = relevant.filter(resource => `${resource.tags.join(' ')} ${resource.topics.join(' ')}`.toLowerCase().includes(concept.toLowerCase().split(' ')[0]))
    const links = found.length ? found.slice(0, 2) : relevant.slice(index ? 1 : 0, (index ? 1 : 0) + 2)
    return {
      id: slug(`${task?.key || 'next'}-${concept}`), concept: `Learn ${concept}`, objective: `Understand the parts of ${concept} needed to make progress on ${task?.title || 'your project task'}.`,
      why: task ? `This skill is listed for “${task.title}” in the project roadmap.` : 'This concept appears in the project technology context.',
      prerequisites: index ? [`${concepts[index - 1]}`] : [], resource_ids: links.map(resource => resource.id), minutes: links[0]?.minutes || 25,
      exercise: `Apply ${concept} in a small, isolated example related to “${task?.title || project.name}”. Write down the expected result before running it.`,
    }
  })
}

export default function Learning() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [menuOpen, setMenuOpen] = useState(false)
  const [projects, setProjects] = useState(() => readSavedProjects().map(normalizeProject))
  const [selectedId, setSelectedId] = useState(() => searchParams.get('project') || localStorage.getItem('udaan:selected-project') || '')
  const [learningState, setLearningState] = useState({ step_status: {}, step_concepts: {}, saved_resources: [], recently_viewed: [], task_feedback: {} })
  const [learningStateLoaded, setLearningStateLoaded] = useState(false)
  const [path, setPath] = useState([])
  const [pathStatus, setPathStatus] = useState('')
  const [stateError, setStateError] = useState('')
  const [tutorQuestion, setTutorQuestion] = useState('')
  const [tutorLevel, setTutorLevel] = useState('beginner')
  const [codeContext, setCodeContext] = useState('')
  const [tutorBusy, setTutorBusy] = useState(false)
  const [tutorError, setTutorError] = useState('')
  const [tutorAnswer, setTutorAnswer] = useState(null)
  const [revealedQuiz, setRevealedQuiz] = useState({})
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const stateRef = useRef(learningState)
  const saveQueueRef = useRef(Promise.resolve())
  const recommendationRequestsRef = useRef(new Map())
  const tutorBusyRef = useRef(false)
  const project = projects.find(item => String(item.id) === String(selectedId)) || projects[0] || null
  const tasks = useMemo(() => project ? taskItems(project) : [], [project])
  const completedTasks = project?.flightPlanProgress || project?.workflow?.flightPlanProgress || []
  const requestedTask = searchParams.get('task')
  const currentTask = tasks.find(task => task.key === requestedTask || task.title === requestedTask)
    || tasks.find(task => !completedTasks.includes(task.key)) || null
  const currentMilestone = currentTask?.milestone || (tasks.length ? 'Roadmap complete' : 'No active milestone')
  const stack = [...new Set([...(project?.stack || []), ...(project?.repository?.detected_technologies || [])])]
  const matchedResources = useMemo(() => project ? resources.filter(resource => matchesResource(resource, project, currentTask)) : [], [project, currentTask])
  const rankedResources = useMemo(() => {
    const rank = new Map()
    for (const step of path) for (const id of step.resource_ids || []) if (!rank.has(id)) rank.set(id, rank.size)
    return [...matchedResources].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER))
  }, [matchedResources, path])
  // Library shows project-matched resources first; if filter/search yields nothing from
  // matched set, fall back to the full catalogue so the library tabs are never empty.
  const libraryResources = useMemo(() => {
    const haystack = (r) => `${r.title} ${r.provider} ${r.tags.join(' ')} ${r.description}`.toLowerCase()
    const q = query.toLowerCase()
    const inMatched = matchedResources.filter(r => (category === 'all' || r.type === category) && haystack(r).includes(q))
    if (inMatched.length > 0 || (category === 'all' && !q)) return inMatched
    // Fallback: search / filter across all resources when the matched set has no results
    return resources.filter(r => (category === 'all' || r.type === category) && haystack(r).includes(q))
  }, [matchedResources, category, query])
  const visibleResources = libraryResources
  const resourceScope = currentTask?.key || 'project'
  const scopedResourceKey = id => `${resourceScope}::${id}`
  const savedResourceIds = (learningState.saved_resources || []).filter(value => value.startsWith(`${resourceScope}::`)).map(value => value.slice(resourceScope.length + 2))
  const recentResources = (learningState.recently_viewed || []).map(value => {
    const [taskKey, resourceId] = value.includes('::') ? value.split('::', 2) : ['project', value]
    const resource = resources.find(item => item.id === resourceId)
    const task = tasks.find(item => item.key === taskKey)
    return resource ? { ...resource, context: task ? task.title : taskKey === 'project' ? 'Project resource' : `Roadmap task ${taskKey}` } : null
  }).filter(Boolean)

  useEffect(() => {
    let active = true
    async function loadProjects() {
      const local = readSavedProjects().map(normalizeProject)
      const byId = new Map(local.map(item => [String(item.id), item]))
      try {
        const response = await listLearningProjects()
        for (const remote of response?.results || []) {
          const previous = byId.get(String(remote.id)) || {}
          byId.set(String(remote.id), normalizeProject({ ...previous, ...remote, name: previous.name || remote.understanding?.project_name, description: previous.description || remote.understanding?.problem_statement, repository: remote.repository || previous.repository }))
        }
      } catch { /* Anonymous browser drafts remain available through existing local storage. */ }
      const hydrate = await Promise.allSettled([...byId.values()].map(item => getLearningProject(item.id)))
      for (const result of hydrate) {
        if (result.status !== 'fulfilled') continue
        const remote = result.value
        const previous = byId.get(String(remote.id)) || {}
        byId.set(String(remote.id), normalizeProject({
          ...previous, ...remote,
          name: previous.name || remote.understanding?.project_name,
          description: previous.description || remote.understanding?.problem_statement,
          category: previous.category || remote.project_type,
          repository: remote.repository || previous.repository,
          stack: remote.repository?.detected_technologies || previous.stack || [],
          flightPlanProgress: previous.flightPlanProgress || remote.workflow?.flightPlanProgress || [],
        }))
      }
      if (active) {
        const values = [...byId.values()]
        setProjects(values)
        const requested = searchParams.get('project')
        const remembered = localStorage.getItem('udaan:selected-project')
        const chosen = values.some(item => String(item.id) === requested) ? requested : values.some(item => String(item.id) === remembered) ? remembered : values[0]?.id || ''
        setSelectedId(String(chosen))
      }
    }
    void loadProjects()
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!project?.id) return
    localStorage.setItem('udaan:selected-project', project.id)
    if (searchParams.get('project') !== String(project.id)) setSearchParams(previous => { const next = new URLSearchParams(previous); next.set('project', project.id); return next }, { replace: true })
    let active = true
    const emptyState = { step_status: {}, step_concepts: {}, saved_resources: [], recently_viewed: [], task_feedback: {} }
    stateRef.current = emptyState
    setLearningState(emptyState)
    setLearningStateLoaded(false)
    setPath([]); setPathStatus(''); setStateError(''); setTutorAnswer(null)
    void getLearningState(project.id).then(value => {
      if (!active) return
      const normalized = { step_status: {}, step_concepts: {}, saved_resources: [], recently_viewed: [], task_feedback: {}, ...value }
      stateRef.current = normalized
      setLearningState(normalized)
      setLearningStateLoaded(true)
    }).catch(error => { if (active) { setStateError(error.message || 'Learning progress could not be loaded.'); setLearningStateLoaded(true) } })
    return () => { active = false }
  }, [project?.id])

  useEffect(() => {
    if (!project?.id || !currentTask || !learningStateLoaded) { setPath([]); setPathStatus(''); return }
    let active = true
    setPath([]); setPathStatus('loading')
    const resourceMeta = matchedResources.map(({ id, title, topics }) => ({ id, title, topics }))
    const completedConcepts = Object.entries(learningState.step_status || {}).filter(([, status]) => status === 'completed').map(([id]) => learningState.step_concepts?.[id]).filter(Boolean)
    const requestKey = `${project.id}:${currentTask.key}:${resourceMeta.map(item => item.id).join(',')}:${completedConcepts.join(',')}`
    let request = recommendationRequestsRef.current.get(requestKey)
    if (!request) {
      request = getLearningRecommendations(project.id, currentTask.key, resourceMeta, completedConcepts)
      recommendationRequestsRef.current.set(requestKey, request)
    }
    void request.then(result => {
      if (!active) return
      setPath((result.steps || []).map((step, index) => ({ ...step, id: step.id || slug(`${currentTask.key}-${step.concept}-${index}`) })))
      setPathStatus('ready')
    }).catch(() => {
      if (recommendationRequestsRef.current.get(requestKey) === request) recommendationRequestsRef.current.delete(requestKey)
      if (!active) return
      setPath(fallbackPath(project, currentTask, matchedResources))
      setPathStatus('fallback')
    })
    return () => { active = false }
  }, [project?.id, currentTask?.key, matchedResources, learningStateLoaded])

  async function persist(patch) {
    if (!project?.id) return
    const next = { ...stateRef.current, ...patch }
    stateRef.current = next
    setLearningState(next)
    setStateError('')
    saveQueueRef.current = saveQueueRef.current.catch(() => {}).then(() => saveLearningState(project.id, next))
    try { await saveQueueRef.current }
    catch (error) { setStateError(`${error.message || 'Could not save learning progress.'} Your change is visible, but may not persist until the API is available.`) }
  }
  function setStepStatus(step, status) {
    const id = step.id || slug(step.concept)
    void persist({ step_status: { ...stateRef.current.step_status, [id]: status }, step_concepts: { ...stateRef.current.step_concepts, [id]: step.concept } })
  }
  function openResource(resource) {
    const key = scopedResourceKey(resource.id)
    const recent = [key, ...(stateRef.current.recently_viewed || []).filter(id => id !== key)].slice(0, 12)
    void persist({ recently_viewed: recent })
  }
  function saveResource(resource) {
    const current = stateRef.current.saved_resources || []
    const key = scopedResourceKey(resource.id)
    void persist({ saved_resources: current.includes(key) ? current.filter(id => id !== key) : [...current, key] })
  }
  async function askTutor(event) {
    event.preventDefault()
    if (!project || !tutorQuestion.trim() || tutorBusyRef.current) return
    tutorBusyRef.current = true
    setTutorBusy(true); setTutorError(''); setTutorAnswer(null); setRevealedQuiz({})
    try {
      const result = await askLearningTutor(project.id, { question: tutorQuestion.trim(), level: tutorLevel, code_context: codeContext, task: currentTask ? { title: currentTask.title, milestone: currentTask.milestone, required_skills: currentTask.required_skills || [], acceptance_criteria: currentTask.acceptance_criteria || '' } : {} })
      setTutorAnswer(result)
    } catch (error) { setTutorError(error.message || 'The tutor is unavailable right now. You can still use the learning path and resources.') }
    finally { tutorBusyRef.current = false; setTutorBusy(false) }
  }
  function saveTaskFeedback(field, value) {
    const feedback = { ...(stateRef.current.task_feedback || {}), [currentTask.key]: { ...(stateRef.current.task_feedback || {})[currentTask.key], [field]: value } }
    void persist({ task_feedback: feedback })
  }
  const progressCount = path.filter(step => learningState.step_status?.[step.id] === 'completed').length

  return <div className="ud-dashboard learn-page">
    <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
    <div className="ud-work-area">
      <header className="ud-topbar"><div className="ud-topbar-left"><button className="ud-mobile-menu ud-icon-button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={20} /></button><span className="ud-topbar-title">Learning</span></div><div className="learn-header-right"><span><GraduationCap size={15} /> Project learning</span></div></header>
      <main className="ud-main learn-main"><div className="learn-content">
        {!project ? <section className="learn-empty"><span className="learn-empty-icon"><BookOpen size={23} /></span><p className="learn-eyebrow">LEARN BY BUILDING</p><h1>Make progress on a real project.</h1><p>Your learning plan will connect roadmap tasks, skills and resources here. Create or save a project to get started.</p><Link to="/" className="learn-primary">Start a project <ArrowRight size={15} /></Link></section> : <>
          <section className="learn-heading">
            <div className="learn-heading-top"><div><p className="learn-eyebrow">YOUR PROJECT LEARNING</p><h1>Learn what moves your project forward.</h1><p>Focused lessons and practice for the task in front of you.</p></div>
              <label className="learn-project-select"><span>Project</span><select aria-label="Choose a project" value={project.id} onChange={event => { setSelectedId(event.target.value); setSearchParams({ project: event.target.value }) }}>
                {projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select><ChevronDown size={15} /></label>
            </div>
            <div className="learn-focus">
              <div className="learn-focus-icon"><Target size={18} /></div><div className="learn-focus-copy"><span>{currentTask ? `UP NEXT · ${currentMilestone}` : currentMilestone.toUpperCase()}</span><strong>{currentTask?.title || (tasks.length ? 'You have completed the current roadmap tasks' : 'Your roadmap is ready for learning')}</strong><p>{currentTask?.acceptance_criteria || (currentTask ? 'Explore the skills and resources that support this roadmap task.' : tasks.length ? 'Review the project skills below or reopen a task from Flight Plan.' : 'Add milestones and tasks in Flight Plan to build a tailored learning path.')}</p></div>
              {currentTask && <Link className="learn-focus-action" to={`/flight-plan?project=${encodeURIComponent(project.id)}&task=${encodeURIComponent(currentTask.key)}`}>Return to task <ArrowRight size={14} /></Link>}
            </div>
            <div className="learn-context-meta"><span>{stack.length ? <><Code2 size={13} />{stack.join(' · ')}</> : 'No technology stack detected yet'}</span><span>{project.repository ? <><CheckCircle2 size={13} /> Repository analysis available</> : 'Repository context not connected'}</span></div>
          </section>

          {stateError && <div className="learn-error" role="status">{stateError}</div>}
          <section className="learn-path-section">
            <div className="learn-section-heading"><div><p className="learn-eyebrow">A CLEAR NEXT STEP</p><h2>Your learning path</h2><p>Study a concept, try the exercise, then decide when you’re ready to continue.</p></div>{path.length > 0 && <span className="learn-progress-pill">{progressCount} of {path.length} completed</span>}</div>
            {pathStatus === 'loading' && <div className="learn-loading"><LoaderCircle className="learn-spin" size={17} /> Tailoring a path to the selected task…</div>}
            {pathStatus === 'fallback' && <div className="learn-note"><Lightbulb size={15} /> Showing a starter path from the project’s roadmap and available skills. AI recommendations are temporarily unavailable.</div>}
            {path.length > 0 ? <div className="learn-path-list">{path.map((step, index) => {
              const stepId = step.id || slug(step.concept)
              const status = learningState.step_status?.[stepId] || 'not_started'
              const linkedResources = (step.resource_ids || []).map(id => resources.find(resource => resource.id === id)).filter(Boolean)
              return <article className={`learn-step ${status === 'completed' ? 'is-complete' : ''}`} key={stepId}>
                <div className="learn-step-number">{status === 'completed' ? <Check size={15} /> : String(index + 1).padStart(2, '0')}</div>
                <div className="learn-step-body"><div className="learn-step-head"><div><span className="learn-step-status">{status.replace('_', ' ')}</span><h3>{step.concept}</h3></div><span className="learn-duration"><Clock3 size={13} />{step.minutes || 25} min</span></div>
                  <p className="learn-objective">{step.objective}</p><p className="learn-why"><b>Why it matters:</b> {step.why}</p>
                  {!!step.prerequisites?.length && <p className="learn-prerequisites"><b>Before you start:</b> {step.prerequisites.join(' · ')}</p>}
                  <div className="learn-exercise"><span><Lightbulb size={13} /> PRACTICE</span><p>{step.exercise}</p></div>
                  {!!linkedResources.length && <div className="learn-step-resources">{linkedResources.map(resource => <a key={resource.id} href={resource.url} target="_blank" rel="noreferrer" onClick={() => openResource(resource)}>{resource.title}<ExternalLink size={12} /></a>)}</div>}
                  <div className="learn-step-actions"><button type="button" className="learn-step-primary" onClick={() => setStepStatus(step, status === 'completed' ? 'in_progress' : 'completed')}>{status === 'completed' ? 'Revisit step' : <><CheckCircle2 size={14} /> Mark complete</>}</button><button type="button" className="learn-step-secondary" onClick={() => setStepStatus(step, status === 'in_progress' ? 'not_started' : 'in_progress')}>{status === 'in_progress' ? 'Reset status' : 'In progress'}</button></div>
                </div>
              </article>
            })}</div> : pathStatus !== 'loading' && <div className="learn-inline-empty">{tasks.length ? 'No pending roadmap task. Reopen a task from Flight Plan to study its concepts.' : 'Add a Flight Plan task to generate a learning path specific to work you need to do.'}</div>}
          </section>

          <section className="learn-recommendations"><div className="learn-section-heading"><div><p className="learn-eyebrow">CURATED FROM REAL SOURCES</p><h2>Recommended for your next task</h2><p>Links are from official documentation or established learning providers. Recommendations use your project’s task and detected stack.</p></div></div>
            <div className="learn-resource-grid">{rankedResources.slice(0, 3).map(resource => <ResourceCard key={resource.id} resource={resource} saved={savedResourceIds.includes(resource.id)} onSave={saveResource} onOpen={openResource} />)}{!matchedResources.length && <div className="learn-inline-empty">No stack or task context is available yet. Add a Flight Plan task or connect a repository to improve recommendations.</div>}</div>
          </section>

          <section className="learn-library"><div className="learn-section-heading"><div><p className="learn-eyebrow">LEARN AT YOUR PACE</p><h2>Resource library</h2><p>{matchedResources.length ? 'Resources matched to this project\'s task context and detected stack.' : 'Curated resources from official docs, trusted guides and YouTube tutorials.'}</p></div>{visibleResources.length > 0 && <span className="learn-progress-pill">{visibleResources.length} resource{visibleResources.length === 1 ? '' : 's'}</span>}</div>
            <div className="learn-library-controls"><label className="learn-search"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={matchedResources.length ? "Search this project's resources" : 'Search all resources'} aria-label="Search resources" /></label><div className="learn-categories" role="tablist" aria-label="Resource category">{categories.map(([id, label]) => <button key={id} role="tab" aria-selected={category === id} className={category === id ? 'active' : ''} onClick={() => setCategory(id)}>{label}</button>)}</div></div>
            <div className="learn-resource-grid">{visibleResources.map(resource => <ResourceCard key={resource.id} resource={resource} saved={savedResourceIds.includes(resource.id)} onSave={saveResource} onOpen={openResource} />)}{!visibleResources.length && <div className="learn-inline-empty">No resources match this search and category. Try another filter.</div>}</div>
          </section>

          <section className="learn-bottom-grid">
            <div className="learn-tutor"><div className="learn-tutor-heading"><span><MessageCircle size={16} /></span><div><p className="learn-eyebrow">ASK WITH CONTEXT</p><h2>AI learning assistant</h2><p>Ask about the concept, task or code you’re working through.</p></div></div>
              <form onSubmit={askTutor}><div className="learn-tutor-controls"><label>Level<select value={tutorLevel} onChange={event => setTutorLevel(event.target.value)}><option value="beginner">Beginner</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option></select></label></div><label className="sr-only" htmlFor="learn-question">Your question</label><textarea id="learn-question" value={tutorQuestion} onChange={event => setTutorQuestion(event.target.value)} maxLength={1500} placeholder={currentTask ? `How does this concept help with “${currentTask.title}”?` : 'What would you like to understand?'} required /><details className="learn-code-context"><summary><Code2 size={13} /> Add code or an error for context (optional)</summary><textarea value={codeContext} onChange={event => setCodeContext(event.target.value)} maxLength={5000} placeholder="Paste a small relevant snippet or error message. Avoid secrets." /></details><button className="learn-primary" type="submit" disabled={tutorBusy || !tutorQuestion.trim()}>{tutorBusy ? <><LoaderCircle className="learn-spin" size={15} /> Thinking…</> : <><Sparkles size={15} /> Ask the tutor</>}</button></form>
              {tutorError && <div className="learn-error" role="alert">{tutorError}</div>}
              {tutorAnswer && <div className="learn-answer"><p className="learn-eyebrow">TUTOR RESPONSE</p><h3>Explanation</h3><p>{tutorAnswer.answer?.explanation}</p><h3>Example</h3><pre>{tutorAnswer.answer?.example}</pre><h3>Try it</h3><p>{tutorAnswer.answer?.exercise}</p>{tutorAnswer.repository_evidence_available && <span className="learn-evidence-note">Repository analysis was available as context. Examples may still be illustrative.</span>}{tutorAnswer.answer?.quiz?.map((item, index) => <div className="learn-quiz" key={`${index}-${item.question}`}><b>Quick check {index + 1}</b><p>{item.question}</p><button type="button" onClick={() => setRevealedQuiz(value => ({ ...value, [index]: !value[index] }))}>{revealedQuiz[index] ? 'Hide answer' : 'Show answer'}</button>{revealedQuiz[index] && <p className="learn-quiz-answer"><b>{item.answer}</b><br />{item.explanation}</p>}</div>)}</div>}
            </div>

            <div className="learn-history"><div className="learn-section-heading"><div><p className="learn-eyebrow">YOUR LIBRARY</p><h2>Saved & recently viewed</h2></div></div><h3><Bookmark size={14} /> Saved resources</h3><ResourceList items={(learningState.saved_resources || []).map(value => { const [taskKey, resourceId] = value.includes('::') ? value.split('::', 2) : ['project', value]; const resource = resources.find(item => item.id === resourceId); const task = tasks.find(item => item.key === taskKey); return resource ? { ...resource, context: task ? task.title : taskKey === 'project' ? 'Project resource' : `Roadmap task ${taskKey}` } : null }).filter(Boolean)} empty="Save a resource to keep it close by." onOpen={openResource} />
              <h3><Clock3 size={14} /> Recently viewed</h3><ResourceList items={recentResources.slice(0, 5)} empty="Resources you open will appear here." onOpen={openResource} />
            </div>
          </section>

          {currentTask && <section className="learn-feedback"><div><p className="learn-eyebrow">APPLIED LEARNING</p><h2>Did this help with your task?</h2><p>This reflection is separate from roadmap completion. It never changes task status.</p></div><div className="learn-feedback-actions"><button className={learningState.task_feedback?.[currentTask.key]?.applied === true ? 'selected' : ''} onClick={() => saveTaskFeedback('applied', true)}><Check size={14} /> I applied it</button><button className={learningState.task_feedback?.[currentTask.key]?.applied === false ? 'selected' : ''} onClick={() => saveTaskFeedback('applied', false)}>Not yet</button><button className={learningState.task_feedback?.[currentTask.key]?.worked === true ? 'selected' : ''} onClick={() => saveTaskFeedback('worked', true)}>It worked</button><button className={learningState.task_feedback?.[currentTask.key]?.worked === false ? 'selected' : ''} onClick={() => saveTaskFeedback('worked', false)}>Still stuck</button></div></section>}
          {currentTask && <Link className="learn-return-link" to={`/flight-plan?project=${encodeURIComponent(project.id)}&task=${encodeURIComponent(currentTask.key)}`}>Return to “{currentTask.title}” in Flight Plan <ArrowRight size={14} /></Link>}
        </>}
      </div></main>
    </div>
  </div>
}

function formatDuration(minutes) {
  if (minutes >= 60) return `${Math.round(minutes / 60)} hr${minutes >= 120 ? 's' : ''}`
  return `${minutes} min`
}

function ResourceCard({ resource, saved, onSave, onOpen }) {
  if (resource.type === 'youtube') return <YoutubeCard resource={resource} saved={saved} onSave={onSave} onOpen={onOpen} />
  const Icon = resource.type === 'interactive' ? Play : resource.type === 'guide' ? Lightbulb : resource.type === 'example' ? Code2 : BookOpen
  return <article className="learn-resource-card">
    <div className="learn-resource-icon"><Icon size={16} /></div>
    <div className="learn-resource-meta"><span>{resource.provider}</span><span>{resource.difficulty} · {formatDuration(resource.minutes)}</span></div>
    <h3>{resource.title}</h3>
    <p>{resource.description}</p>
    <div className="learn-resource-tags">{resource.tags.slice(0, 2).map(tag => <span key={tag}>{tag}</span>)}</div>
    <div className="learn-resource-actions">
      <a href={resource.url} target="_blank" rel="noreferrer" onClick={() => onOpen(resource)}>Open resource <ExternalLink size={13} /></a>
      <button type="button" aria-label={saved ? `Remove ${resource.title} from saved` : `Save ${resource.title}`} onClick={() => onSave(resource)} className={saved ? 'saved' : ''}><Bookmark size={14} fill={saved ? 'currentColor' : 'none'} /></button>
    </div>
  </article>
}

function YoutubeCard({ resource, saved, onSave, onOpen }) {
  const thumb = resource.videoId ? `https://i.ytimg.com/vi/${resource.videoId}/mqdefault.jpg` : null
  return <article className="learn-yt-card">
    <a className="learn-yt-thumb" href={resource.url} target="_blank" rel="noreferrer" onClick={() => onOpen(resource)} aria-label={`Watch ${resource.title}`}>
      {thumb ? <img src={thumb} alt="" loading="lazy" /> : <div className="learn-yt-thumb-fallback"><Youtube size={26} /></div>}
      <span className="learn-yt-play"><Play size={17} fill="currentColor" /></span>
      <span className="learn-yt-duration"><Clock3 size={11} />{formatDuration(resource.minutes)}</span>
    </a>
    <div className="learn-yt-body">
      <div className="learn-yt-meta"><Youtube size={12} /><span>{resource.provider}</span><span className="learn-yt-dot" /><span>{resource.difficulty}</span></div>
      <h3>{resource.title}</h3>
      <p>{resource.description}</p>
      <div className="learn-yt-footer">
        <div className="learn-resource-tags">{resource.tags.slice(0, 2).map(tag => <span key={tag}>{tag}</span>)}</div>
        <button type="button" aria-label={saved ? `Remove ${resource.title} from saved` : `Save ${resource.title}`} onClick={() => onSave(resource)} className={saved ? 'saved' : ''}><Bookmark size={14} fill={saved ? 'currentColor' : 'none'} /></button>
      </div>
    </div>
  </article>
}
function ResourceList({ items, empty, onOpen }) {
  if (!items.length) return <p className="learn-list-empty">{empty}</p>
  return <ul className="learn-resource-list">{items.map((item, index) => <li key={`${item.id}-${item.context || ''}-${index}`}><a href={item.url} target="_blank" rel="noreferrer" onClick={() => onOpen(item)}><span>{item.title}<small>{item.provider}{item.context ? ` · ${item.context}` : ''}</small></span><ExternalLink size={13} /></a></li>)}</ul>
}
