import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ArrowRight, BookOpen, Check, ChevronDown, ChevronRight, CircleHelp, Clock3, Code2, ExternalLink, File, FileCode2, FileText, Folder, FolderOpen, GitBranch, Github, Layers3, LoaderCircle, Menu, Network, RefreshCw, Search, Shield, Sparkles, X } from 'lucide-react'
import Sidebar from '../layouts/Sidebar.jsx'
import ArchitectureVisualizer from './ArchitectureVisualizer.jsx'
import { apiRequest } from '../services/apiClient.js'
import { analyzeRepository, collectRepositorySourcePaths } from '../services/repositoryAnalysis.js'
import './Repository.css'

const STORAGE_KEY = 'udaan:connected-public-repository'
const API_ROOT = 'https://api.github.com'
const FILE_LIMIT = 256 * 1024
const TREE_LIMIT = 500
const ANALYSIS_SCHEMA_VERSION = 2
const OMITTED_PATH = /(^|\/)(\.env(?:\.(?!example$|sample$|template$)[^/]+)?|id_rsa|id_ed25519|credentials(?:\.json)?|secrets?\.ya?ml|.*\.(?:pem|key|p12|pfx|keystore))$/i
const TEXT_FILE = /\.(?:txt|md|mdx|json|ya?ml|toml|ini|cfg|conf|xml|html?|css|scss|sass|less|js|jsx|mjs|cjs|ts|tsx|py|pyi|go|rs|java|kt|kts|swift|rb|php|sql|prisma|graphql|gql|proto|sh|bash|zsh|ps1|bat|dockerfile|gitignore|editorconfig)$/i

function loadSavedRepository() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') } catch { return null }
}
function parseRepositoryUrl(raw) {
  let url
  try { url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`) } catch { throw new Error('Enter a valid GitHub repository URL.') }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password) throw new Error('Use an https://github.com/owner/repository URL.')
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2) throw new Error('Enter a repository link in the format github.com/owner/repository.')
  const [owner, rawName] = parts
  const name = rawName.replace(/\.git$/i, '')
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name) || name === '.' || name === '..') throw new Error('That repository address is not valid.')
  return { owner, name }
}
async function githubRequest(path) {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 15000)
  let response
  try { response = await fetch(`${API_ROOT}${path}`, { signal: controller.signal, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } }) }
  catch (error) { if (error.name === 'AbortError') throw new Error('GitHub did not respond in time. Try again.'); throw error }
  finally { window.clearTimeout(timeout) }
  if (response.status === 404) throw new Error('Repository not found, or it is private. This page currently supports public repositories only.')
  if (response.status === 403 && response.headers.get('X-RateLimit-Remaining') === '0') throw new Error('GitHub’s public API rate limit has been reached. Try again later.')
  if (response.status === 409) {
    // Git Repository is empty
    return { empty: true, tree: [] }
  }
  if (!response.ok) throw new Error(`GitHub could not complete that request (HTTP ${response.status}).`)
  return response.json()
}
async function fetchSourceFiles(owner, name, branch, entries) {
  if (!entries || !entries.length || !branch) return {}
  const paths = collectRepositorySourcePaths(entries, 48)
  const files = {}
  let cursor = 0
  async function worker() {
    while (cursor < paths.length) {
      const path = paths[cursor++]
      const entry = entries.find(item => item.path === path)
      if (!entry || entry.size > FILE_LIMIT) continue
      try {
        const result = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`)
        if (result.empty || result.size > FILE_LIMIT || !result.content) continue
        const bytes = Uint8Array.from(atob(result.content.replace(/\s/g, '')), char => char.charCodeAt(0))
        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
        if (!text.includes('\0')) files[path] = text
      } catch { /* Unavailable or oversized source files are skipped, not treated as findings. */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, paths.length) }, worker))
  return files
}
function isSafeTextFile(entry) { return entry?.type === 'blob' && (entry.size ?? 0) <= FILE_LIMIT && !OMITTED_PATH.test(entry.path) && TEXT_FILE.test(entry.path) }
function createTree(entries, query = '') {
  const root = { name: '', path: '', type: 'tree', children: new Map() }
  const normalizedQuery = query.trim().toLowerCase()
  for (const entry of entries) {
    if (!entry.path || entry.path.split('/').some(part => part === '.git' || part === 'node_modules' || part === 'vendor')) continue
    const segments = entry.path.split('/')
    let parent = root
    for (const [index, segment] of segments.entries()) {
      const path = segments.slice(0, index + 1).join('/')
      let node = parent.children.get(segment)
      if (!node) { node = { name: segment, path, type: index === segments.length - 1 ? entry.type : 'tree', entry: index === segments.length - 1 ? entry : null, children: new Map() }; parent.children.set(segment, node) }
      parent = node
    }
  }
  function finalize(node) {
    const allChildren = [...node.children.values()].map(finalize).filter(Boolean)
    const visible = normalizedQuery ? allChildren.filter(child => child.matches || child.type === 'tree' && child.children.length) : allChildren
    node.children = visible.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'tree' ? -1 : 1)
    node.matches = !normalizedQuery || node.name.toLowerCase().includes(normalizedQuery) || node.path.toLowerCase().includes(normalizedQuery)
    if (normalizedQuery && !node.matches && !node.children.length) return null
    return node
  }
  return finalize(root)?.children || []
}
function flattenTree(nodes, into = []) { for (const node of nodes) { into.push(node); if (node.type === 'tree') flattenTree(node.children, into) } return into }
function formatDate(value) { if (!value) return 'Not synced yet'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? 'Not synced yet' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }
function detectTechnologies(repository, entries, manifests) {
  const paths = new Set(entries.map(entry => entry.path.toLowerCase()))
  const packageJson = manifests.packageJson || {}
  const dependencies = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) }
  const requirements = manifests.requirements || ''
  const detected = []
  const add = (name, evidence) => detected.push({ name, evidence })
  if (dependencies.react || [...paths].some(path => /(^|\/)[^/]+\.(jsx|tsx)$/.test(path))) add('React', dependencies.react ? 'Declared in package.json' : 'JSX or TSX files found')
  if (paths.has('vite.config.js') || paths.has('vite.config.ts') || paths.has('vite.config.mjs') || packageJson.devDependencies?.vite || packageJson.dependencies?.vite) add('Vite', paths.has('vite.config.js') || paths.has('vite.config.ts') || paths.has('vite.config.mjs') ? 'Vite configuration found' : 'Declared in package.json')
  if (paths.has('manage.py') || [...paths].some(path => path.endsWith('/manage.py'))) add('Django', 'manage.py found')
  if (/djangorestframework|\bdjangorestframework\b/i.test(requirements)) add('Django REST Framework', 'Listed in requirements.txt')
  if (dependencies.next) add('Next.js', 'Declared in package.json')
  if (dependencies.vue) add('Vue', 'Declared in package.json')
  if (dependencies.express) add('Express', 'Declared in package.json')
  if (dependencies.tailwindcss) add('Tailwind CSS', 'Declared in package.json')
  if (paths.has('go.mod')) add('Go', 'go.mod found')
  if (paths.has('cargo.toml')) add('Rust', 'Cargo.toml found')
  if (paths.has('pyproject.toml') || paths.has('requirements.txt')) add('Python', paths.has('pyproject.toml') ? 'pyproject.toml found' : 'requirements.txt found')
  if (repository.language && !detected.some(item => item.name === repository.language)) detected.unshift({ name: repository.language, evidence: 'GitHub repository language metadata' })
  return detected
}
function formatBytes(bytes = 0) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB` }

function TreeNode({ node, depth = 0, selected, onSelect, forceOpen = false }) {
  const [open, setOpen] = useState(depth === 0)
  const isFolder = node.type === 'tree'
  const expanded = forceOpen || open
  const Icon = isFolder ? expanded ? FolderOpen : Folder : node.name.toLowerCase() === 'readme.md' ? BookOpen : TEXT_FILE.test(node.name) ? FileCode2 : File
  return <div>
    <button type="button" className={`rp-tree-row ${isFolder ? 'is-folder' : ''} ${selected === node.path ? 'is-selected' : ''}`} style={{ '--tree-depth': depth }} onClick={() => isFolder ? setOpen(value => !value) : onSelect(node.entry)} title={node.path}>
      {isFolder ? expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : <span className="rp-tree-spacer" />}
      <Icon size={15} /><span>{node.name}</span>{!isFolder && node.entry?.size != null && <small>{formatBytes(node.entry.size)}</small>}
    </button>
    {isFolder && expanded && node.children.map(child => <TreeNode key={child.path} node={child} depth={depth + 1} selected={selected} onSelect={onSelect} forceOpen={forceOpen} />)}
  </div>
}

function EmptyRepository({ onConnectGithub, onSubmitUrl, loading, error }) {
  const [url, setUrl] = useState('')
  return <div className="rp-empty-wrap"><section className="rp-empty-card">
    <div className="rp-empty-mark"><Code2 size={24} /></div>
    <span className="rp-eyebrow">UDAAN REPOSITORY INTELLIGENCE</span>
    <h1>Your codebase,<br /><em>understood.</em></h1>
    <p className="rp-empty-copy">Connect your repository and let UDAAN help you understand your project.</p>
    <button type="button" className="rp-button-primary rp-connect-github" onClick={onConnectGithub}><Github size={17} /> Connect GitHub <ArrowRight size={16} /></button>
    <div className="rp-or"><span>or add a public repository URL</span></div>
    <form className="rp-repo-form" onSubmit={event => { event.preventDefault(); onSubmitUrl(url) }}>
      <label htmlFor="rp-repository-url">GitHub repository</label>
      <div className="rp-url-input"><Github size={16} /><input id="rp-repository-url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://github.com/owner/repository" /><button type="submit" disabled={loading || !url.trim()} aria-label="Add repository URL">{loading ? <LoaderCircle size={16} className="rp-spin" /> : <ArrowRight size={16} />}</button></div>
      {error && <p className="rp-error" role="alert"><AlertCircle size={14} />{error}</p>}
      <small>Public GitHub repositories can be explored without granting write access.</small>
    </form>
    <div className="rp-capabilities"><div><Layers3 size={16} /><span><strong>Explore files</strong><small>Browse source safely</small></span></div><div><Network size={16} /><span><strong>Understand structure</strong><small>See evidence-backed components</small></span></div><div><Shield size={16} /><span><strong>Review with care</strong><small>No code is run or changed</small></span></div></div>
  </section><p className="rp-private-note"><CircleHelp size={14} /> Private repositories need GitHub authorization. It is not configured for this workspace yet.</p></div>
}

export default function Repository() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [repository, setRepository] = useState(loadSavedRepository)
  const [entries, setEntries] = useState([])
  const [manifests, setManifests] = useState(() => loadSavedRepository()?.manifests || {})
  const [sourceFiles, setSourceFiles] = useState({})
  const [analysis, setAnalysis] = useState(() => loadSavedRepository()?.analysis?.schemaVersion === ANALYSIS_SCHEMA_VERSION ? loadSavedRepository().analysis : null)
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [analysisError, setAnalysisError] = useState('')
  const [selectedFinding, setSelectedFinding] = useState(null)
  const [explainingFinding, setExplainingFinding] = useState(false)
  const [findingFilter, setFindingFilter] = useState('all')
  const [selectedEntry, setSelectedEntry] = useState(null)
  const [fileContent, setFileContent] = useState('')
  const [fileError, setFileError] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingFile, setLoadingFile] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [connectHelp, setConnectHelp] = useState(false)
  const [activeTab, setActiveTab] = useState('explorer')
  const [search, setSearch] = useState('')

  async function fetchRepository(owner, name) {
    const metadata = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`)
    if (metadata.private) throw new Error('This repository is private. Private access needs server-side GitHub authorization, which is not configured yet.')
    const branch = metadata.default_branch || 'main'
    let treeResponse = { empty: true, tree: [] }
    if (metadata.size !== 0 && metadata.default_branch) {
      try {
        treeResponse = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${encodeURIComponent(branch)}?recursive=1`)
      } catch (err) {
        if (err.message && /409|empty/i.test(err.message)) {
          treeResponse = { empty: true, tree: [] }
        } else {
          throw err
        }
      }
    }
    const isEmpty = Boolean(treeResponse.empty || metadata.size === 0 || !treeResponse.tree || treeResponse.tree.length === 0)
    const treeEntries = isEmpty ? [] : (treeResponse.tree || []).filter(entry => ['blob', 'tree'].includes(entry.type)).slice(0, TREE_LIMIT)
    const next = {
      owner,
      name: metadata.name,
      fullName: metadata.full_name,
      url: metadata.html_url,
      branch,
      language: metadata.language || '',
      visibility: metadata.visibility || 'public',
      syncedAt: new Date().toISOString(),
      revision: treeResponse.sha || '',
      truncated: Boolean(treeResponse.truncated || (treeResponse.tree || []).length > TREE_LIMIT),
      tree: treeEntries,
      isEmpty,
    }
    const saved = loadSavedRepository()
    let sourceMap = {}
    let manifestMap = saved?.fullName === next.fullName && saved?.revision === next.revision ? saved.manifests || {} : {}
    let nextAnalysis = saved?.fullName === next.fullName && saved?.revision === next.revision && saved.analysis?.schemaVersion === ANALYSIS_SCHEMA_VERSION ? saved.analysis : null

    if (isEmpty) {
      nextAnalysis = {
        schemaVersion: ANALYSIS_SCHEMA_VERSION,
        revision: treeResponse.sha || '',
        generatedAt: new Date().toISOString(),
        findings: [],
        architecture: { frontend: false, backend: false, components: [], routes: [], rootUrlConfig: null, apiServiceFiles: [], connections: [] },
        insights: { entryPoints: [], dependencies: [], scripts: {}, packageFile: 'package.json', testFiles: [], configFiles: [], endpointCount: 0, endpoints: [], environment: [], corsOrigins: [], apiBase: null },
        verification: [],
        evidenceFiles: [],
      }
      setAnalysis(nextAnalysis); setSourceFiles({}); setManifests({}); setAnalysisLoading(false)
    } else if (!nextAnalysis) {
      setAnalysisLoading(true); setAnalysisError('')
      sourceMap = await fetchSourceFiles(owner, name, branch, treeEntries)
      const packagePath = Object.keys(sourceMap).filter(path => /(^|\/)package\.json$/i.test(path)).sort((a, b) => a.length - b.length)[0]
      let packageJson = {}
      if (packagePath) { try { packageJson = JSON.parse(sourceMap[packagePath]) } catch { packageJson = {} } }
      manifestMap = { packageJson, requirements: Object.entries(sourceMap).filter(([path]) => /(^|\/)requirements\.txt$/i.test(path)).map(([, text]) => text).join('\n'), pyproject: Object.entries(sourceMap).filter(([path]) => /(^|\/)pyproject\.toml$/i.test(path)).map(([, text]) => text).join('\n') }
      nextAnalysis = analyzeRepository({ repository: next, entries: treeEntries, files: sourceMap, manifests: manifestMap })
      setAnalysis(nextAnalysis); setSourceFiles(sourceMap); setManifests(manifestMap); setAnalysisLoading(false)
    } else { setSourceFiles({}); setAnalysis(nextAnalysis) }
    const persisted = { ...next, analysis: nextAnalysis, manifests: manifestMap }
    setRepository(persisted); setEntries(treeEntries); setSelectedEntry(null); setFileContent(''); setFileError(''); setSearch(''); setSelectedFinding(null)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...persisted, tree: treeEntries })) } catch { setNotice('Repository refreshed. Browser storage is full, so this connection may not survive a refresh.') }
    return persisted
  }

  async function connect(raw) {
    setLoading(true); setError(''); setNotice('')
    try {
      const { owner, name } = parseRepositoryUrl(raw)
      const persisted = await fetchRepository(owner, name)
      setActiveTab('explorer')
      if (persisted?.isEmpty) {
        setNotice('Connected to empty repository. Add files or commits to view code and run architecture checks.')
      }
    }
    catch (caught) { setError(caught?.message || 'Unable to load this repository. Try again.') }
    finally { setLoading(false); setAnalysisLoading(false) }
  }
  async function syncRepository() {
    if (!repository || loading) return
    setLoading(true); setError('')
    try {
      const persisted = await fetchRepository(repository.owner, repository.name)
      setNotice(persisted?.isEmpty ? 'Repository files and metadata were refreshed. This repository is currently empty.' : 'Repository files and metadata were refreshed.')
    }
    catch (caught) { setError(caught?.message || 'Unable to refresh the repository.') }
    finally { setLoading(false); setAnalysisLoading(false) }
  }
  async function openFile(entry) {
    setSelectedEntry(entry); setFileContent(''); setFileError('')
    if (!entry || !entry.path) return
    if (!isSafeTextFile(entry)) { setFileError('This file type is not displayed for safety, or the file exceeds the 256 KB preview limit.'); return }
    if (sourceFiles[entry.path]) { setFileContent(sourceFiles[entry.path]); return }
    setLoadingFile(true)
    try {
      const result = await githubRequest(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/contents/${entry.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(repository.branch)}`)
      if (result.empty || !result.content) throw new Error('This file has no preview available.')
      if (result.size > FILE_LIMIT) throw new Error('This file is too large for the safe preview limit.')
      const bytes = Uint8Array.from(atob(result.content.replace(/\s/g, '')), char => char.charCodeAt(0))
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
      if (text.includes('\0')) throw new Error('This file appears to be binary and cannot be previewed as text.')
      setFileContent(text)
    } catch (caught) { setFileError(caught?.message || 'Could not load this file.') }
    finally { setLoadingFile(false) }
  }
  async function explainFinding(finding) {
    if (!finding || explainingFinding) return
    setExplainingFinding(true); setAnalysisError('')
    try {
      const response = await apiRequest('/api/repository/explain-finding/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repository: repository.fullName, title: finding.title, category: finding.category, severity: finding.severity, impact: finding.impact, recommendation: finding.recommendation, evidence: finding.evidence }) })
      const updatedFinding = { ...finding, explanation: response.explanation }
      const updatedAnalysis = { ...analysis, findings: analysis.findings.map(item => item.id === finding.id ? updatedFinding : item) }
      setAnalysis(updatedAnalysis); setSelectedFinding(updatedFinding)
      const saved = loadSavedRepository()
      if (saved) localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, analysis: updatedAnalysis }))
    } catch (caught) { setAnalysisError(caught?.message || 'Could not prepare an AI explanation. The deterministic finding is still available.') }
    finally { setExplainingFinding(false) }
  }
  function disconnect() { localStorage.removeItem(STORAGE_KEY); setRepository(null); setEntries([]); setManifests({}); setSourceFiles({}); setAnalysis(null); setSelectedFinding(null); setSelectedEntry(null); setActiveTab('explorer'); setError(''); setAnalysisError(''); setNotice('') }
  useEffect(() => { if (repository?.tree?.length) { setEntries(repository.tree); setSelectedEntry(null) } if (repository && repository.analysis?.schemaVersion !== ANALYSIS_SCHEMA_VERSION) syncRepository() }, [])

  const tree = useMemo(() => createTree(entries.filter(entry => entry.type === 'blob' ? !OMITTED_PATH.test(entry.path) : true), search), [entries, search])
  const technologies = useMemo(() => repository ? detectTechnologies(repository, entries, manifests) : [], [repository, entries, manifests])
  const visibleFiles = useMemo(() => flattenTree(tree).filter(entry => entry.type === 'blob'), [tree])
  const readme = entries.find(entry => entry.type === 'blob' && /^readme(?:\.[^/]+)?$/i.test(entry.path.split('/').pop()))
  const rootFiles = entries.filter(entry => entry.type === 'blob' && !entry.path.includes('/')).sort((a, b) => a.path.localeCompare(b.path))
  const packageScripts = analysis?.insights?.scripts || manifests.packageJson?.scripts || {}
  const detectedChecks = analysis?.verification?.filter(item => item.command?.startsWith('npm run ')) || Object.entries(packageScripts).filter(([key]) => ['build', 'test', 'lint', 'typecheck', 'check'].includes(key)).map(([key, value]) => ({ name: key, command: `npm run ${key}`, script: String(value), status: 'not_run' }))
  const findings = analysis?.findings || []
  const filteredFindings = findings.filter(item => findingFilter === 'all' || item.severity.toLowerCase() === findingFilter)
  const tabs = [{ id: 'explorer', label: 'Code explorer', icon: FolderOpen }, { id: 'architecture', label: 'Architecture', icon: Network }, { id: 'insights', label: 'Insights', icon: Sparkles }, { id: 'verification', label: 'Verification', icon: Check }]

  return <div className="ud-dashboard rp-page">
    <Sidebar activePage="repository" open={menuOpen} onClose={() => setMenuOpen(false)} />
    <div className="ud-work-area">
      <header className="ud-topbar"><div className="ud-topbar-left"><button className="ud-mobile-menu ud-icon-button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={20} /></button><span className="ud-topbar-title">Repository</span>{repository && <span className="rp-top-project"><Github size={14} />{repository.fullName}</span>}</div><div className="ud-topbar-actions"><span className="rp-readonly"><Shield size={13} /> Read only</span></div></header>
      <main className="ud-main rp-main"><div className="rp-content">
        {!repository ? <EmptyRepository onConnectGithub={() => setConnectHelp(true)} onSubmitUrl={connect} loading={loading} error={error} /> : <>
          <section className="rp-connected-heading"><div><span className="rp-eyebrow"><span className="rp-connected-dot" /> PUBLIC REPOSITORY</span><h1>{repository.name}</h1><p>Explore real repository files and the evidence behind detected technologies.</p></div><div className="rp-actions"><button type="button" className="rp-button-secondary" onClick={disconnect}>Disconnect</button><button type="button" className="rp-button-secondary" onClick={() => { if (repository?.isEmpty) setNotice('This repository is currently empty. Add files or commits to analyze.'); else if (analysis?.revision === repository.revision) setNotice('This commit has already been analyzed. Sync the repository to check for a newer revision.'); else syncRepository() }} disabled={loading || analysisLoading || (!repository?.isEmpty && analysis?.revision === repository.revision)}><Sparkles size={15} />{analysisLoading ? 'Analyzing…' : analysis?.revision === repository.revision && !repository?.isEmpty ? 'Analysis current' : 'Analyze repository'}</button><button type="button" className="rp-button-primary" onClick={syncRepository} disabled={loading}>{loading ? <LoaderCircle size={15} className="rp-spin" /> : <RefreshCw size={15} />} Sync repository</button></div></section>
          {error && <div className="rp-banner rp-banner-error" role="alert"><AlertCircle size={15} />{error}<button type="button" onClick={() => setError('')} aria-label="Dismiss"><X size={15} /></button></div>}
          {notice && <div className="rp-banner rp-banner-success" role="status"><Check size={15} />{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss"><X size={15} /></button></div>}
          <section className="rp-repository-summary"><div className="rp-repository-identity"><span className="rp-github-mark"><Github size={20} /></span><div><strong>{repository.fullName}</strong><a href={repository.url} target="_blank" rel="noreferrer">View on GitHub <ExternalLink size={12} /></a></div></div><div className="rp-summary-facts"><span><GitBranch size={14} /><b>{repository.branch}</b><small>default branch</small></span><span><Code2 size={14} /><b>{repository.language || 'Not reported'}</b><small>primary language</small></span><span><Clock3 size={14} /><b>{formatDate(repository.syncedAt)}</b><small>last synced</small></span></div></section>
          <div className="rp-tech-tags">{technologies.length ? technologies.map(item => <span key={item.name}>{item.name}</span>) : <span>No technologies confidently detected from repository metadata.</span>}<span className="rp-file-count">{visibleFiles.length} visible text files</span></div>
          <nav className="rp-tabs" aria-label="Repository sections">{tabs.map(tab => { const Icon = tab.icon; return <button type="button" key={tab.id} className={activeTab === tab.id ? 'active' : ''} onClick={() => setActiveTab(tab.id)}><Icon size={15} />{tab.label}{tab.id === 'explorer' && <span>{visibleFiles.length}</span>}</button> })}</nav>

          {activeTab === 'explorer' && <section className="rp-explorer-panel"><aside className="rp-explorer-sidebar"><div className="rp-explorer-title"><div><FolderOpen size={16} /><strong>Files</strong></div><span>{entries.filter(entry => entry.type === 'blob').length}{repository.truncated ? '+' : ''}</span></div><label className="rp-file-search"><Search size={14} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Find a file" aria-label="Find a file" /></label><div className="rp-tree-scroll">{tree.length ? tree.map(node => <TreeNode key={node.path} node={node} selected={selectedEntry?.path} onSelect={openFile} forceOpen={Boolean(search.trim())} />) : <p className="rp-tree-empty">{repository?.isEmpty || entries.length === 0 ? 'This repository is empty.' : 'No files match your search.'}</p>}</div><p className="rp-safe-note"><Shield size={13} /> Secret files and large files are hidden.</p></aside>
            <div className="rp-code-panel"><div className="rp-code-header"><div><span className="rp-file-kind"><FileCode2 size={15} /></span><div><strong>{selectedEntry?.path || 'Select a file'}</strong><small>{selectedEntry ? `${selectedEntry.size == null ? 'Size unavailable' : formatBytes(selectedEntry.size)} · ${selectedEntry.path.split('.').pop().toUpperCase()} source` : 'Choose a text file from the explorer'}</small></div></div>{selectedEntry?.path && <a href={`${repository.url}/blob/${repository.branch.split('/').map(encodeURIComponent).join('/')}/${selectedEntry.path.split('/').map(encodeURIComponent).join('/')}`} target="_blank" rel="noreferrer" className="rp-open-source">Open on GitHub <ExternalLink size={13} /></a>}</div>
              <div className="rp-code-body">{loadingFile ? <div className="rp-panel-state"><LoaderCircle size={19} className="rp-spin" /><span>Loading file preview…</span></div> : fileError ? <div className="rp-panel-state"><Shield size={19} /><span>{fileError}</span></div> : selectedEntry ? <pre><code>{fileContent.split('\n').map((line, index) => <span className="rp-code-line" key={`${selectedEntry.path}-${index}`}><i>{index + 1}</i><span>{line || ' '}</span></span>)}</code></pre> : <div className="rp-panel-state"><FileText size={20} /><span>{repository?.isEmpty || entries.length === 0 ? 'This repository has no files to display.' : 'Choose a file to inspect its contents.'}</span></div>}</div>
              <div className="rp-code-footer"><Shield size={13} /><span>Read-only preview · files over 256 KB and secret files are not displayed</span></div>
            </div></section>}

          {activeTab === 'architecture' && <ArchitectureVisualizer analysis={analysis} repository={repository} loading={analysisLoading} onOpenFile={path => { if (!path) return; const entry = entries.find(item => item.path === path); setActiveTab('explorer'); openFile(entry || { path, type: 'blob' }) }} />}
          {activeTab === 'insights' && <section className="rp-tab-panel"><div className="rp-panel-heading"><span className="rp-panel-icon"><Sparkles size={17} /></span><div><h2>Codebase insights</h2><p>Deterministic findings from the inspected revision {analysis?.revision ? analysis.revision.slice(0, 8) : ''}. Confirmed mismatches and items needing review are labeled separately.</p></div></div>
            {analysisLoading ? <div className="rp-empty-panel"><LoaderCircle size={20} className="rp-spin" /><strong>Analyzing repository files…</strong></div> : analysisError ? <div className="rp-banner rp-banner-error"><AlertCircle size={15} />{analysisError}</div> : <>
              <div className="rp-overview-grid"><article><span>Source files inspected</span><strong>{analysis?.evidenceFiles?.length || 0}</strong><small>Relevant source files read without environment values or secret files.</small></article><article><span>API request sites</span><strong>{analysis?.insights?.endpointCount || 0}</strong><small>Frontend API service calls checked against Django routes.</small></article><article><span>Tests and configs</span><strong>{(analysis?.insights?.testFiles?.length || 0) + (analysis?.insights?.configFiles?.length || 0)}</strong><small>{analysis?.insights?.testFiles?.length || 0} test files · {analysis?.insights?.configFiles?.length || 0} test/config files detected.</small></article></div>
              <div className="rp-insights-list"><h3>Important files and dependencies</h3>{(analysis?.insights?.entryPoints || []).map(path => <p key={path}><Code2 size={15} /><button type="button" onClick={() => { setActiveTab('explorer'); openFile({ path, type: 'blob' }) }}>{path}</button></p>)}<p><Layers3 size={15} /> Dependencies from {analysis?.insights?.packageFile || 'package.json'}: {(analysis?.insights?.dependencies || []).slice(0, 14).join(', ') || 'No package dependencies detected.'}</p>{(analysis?.insights?.testFiles || []).map(path => <p key={path}><Check size={15} /> Test file found: <button type="button" onClick={() => { setActiveTab('explorer'); openFile({ path, type: 'blob' }) }}>{path}</button></p>)}{(analysis?.insights?.configFiles || []).map(path => <p key={path}><FileText size={15} /> Configuration found: <button type="button" onClick={() => { setActiveTab('explorer'); openFile({ path, type: 'blob' }) }}>{path}</button></p>)}</div>
              <div className="rp-findings"><div className="rp-findings-head"><div><h3>Integration and configuration findings</h3><p>{findings.length} evidence-backed or review findings · no repository code executed</p></div><div className="rp-filters">{['all','high','medium','low','informational'].map(filter => <button key={filter} type="button" className={findingFilter === filter ? 'active' : ''} onClick={() => setFindingFilter(filter)}>{filter === 'all' ? 'All' : filter[0].toUpperCase() + filter.slice(1)}</button>)}</div></div>
                {filteredFindings.length ? <div className="rp-finding-list">{filteredFindings.map(finding => <button type="button" className="rp-finding-row" key={finding.id} onClick={() => setSelectedFinding(finding)}><span className={`rp-severity severity-${finding.severity.toLowerCase()}`}>{finding.severity}</span><span className="rp-finding-main"><strong>{finding.title}</strong><small>{finding.file}{finding.line ? `:${finding.line}` : ''} · {finding.category} · {finding.status === 'potential' ? 'Needs review' : 'Confirmed by source evidence'}</small></span><ArrowRight size={15} /></button>)}</div> : <div className="rp-no-findings">{repository?.isEmpty ? 'This repository is empty. Add source files to detect architecture and integration findings.' : findings.length ? 'No findings match this filter.' : 'No confirmed endpoint or configuration mismatches were found in the inspected source. This does not mean the entire repository is defect-free.'}</div>}</div>
              <div className="rp-env-summary"><h3>Environment variable names</h3>{analysis?.insights?.environment?.length ? analysis.insights.environment.map(item => <div key={item.name}><code>{item.name}</code><span>{item.documented ? 'Documented in an example file' : 'Not found in an example file'}</span></div>) : <p>No environment variable references were found in the inspected files.</p>}<small>Only variable names are scanned; secret values are not read or displayed.</small></div>
            </>}</section>}

          {activeTab === 'verification' && <section className="rp-tab-panel"><div className="rp-panel-heading"><span className="rp-panel-icon"><Check size={17} /></span><div><h2>Verification</h2><p>Checks and test commands below come from the repository files. Connected code is not executed in the UDAAN web application.</p></div></div><div className="rp-verification-list">{(analysis?.verification || []).length ? analysis.verification.map((check, index) => <article key={`${check.name}-${index}`}><span className="rp-verification-icon"><Code2 size={16} /></span><div><strong>{check.name[0].toUpperCase() + check.name.slice(1)}</strong><code>{check.command}</code>{check.script && <small>Declared script: {check.script}</small>}{check.reason && <small>{check.reason}</small>}</div><span className={`rp-verification-status status-${check.status}`}>{check.status.replace('_', ' ')}</span></article>) : <div className="rp-empty-panel"><CircleHelp size={21} /><strong>{repository?.isEmpty ? 'Repository is empty' : 'No supported commands found'}</strong><p>{repository?.isEmpty ? 'No code or manifests exist to declare build or test commands.' : 'Build, test, lint, and typecheck commands are not declared in the inspected package manifest.'}</p></div>}</div><div className="rp-verification-note"><Shield size={14} /><span>Runtime tests are marked <strong>Not run</strong>. This workspace has no isolated runner for executing untrusted repository commands.</span></div></section>}
        </>}
      </div></main>
      {selectedFinding && <div className="rp-dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setSelectedFinding(null) }}><section className="rp-finding-dialog" role="dialog" aria-modal="true" aria-labelledby="rp-finding-title"><button type="button" className="rp-dialog-close" aria-label="Close finding details" onClick={() => setSelectedFinding(null)}><X size={17} /></button><div className="rp-finding-dialog-meta"><span className={`rp-severity severity-${selectedFinding.severity.toLowerCase()}`}>{selectedFinding.severity}</span><span>{selectedFinding.category}</span><span>{selectedFinding.status === 'potential' ? 'Needs review' : 'Confirmed by static evidence'}</span></div><h2 id="rp-finding-title">{selectedFinding.title}</h2><p className="rp-finding-impact">{selectedFinding.impact}</p><section className="rp-detail-section"><h3>Source evidence</h3>{selectedFinding.evidence.map((item, index) => <button className="rp-evidence-snippet" type="button" key={`${item.file}-${item.line}-${index}`} onClick={() => { const entry = entries.find(candidate => candidate.path === item.file); setSelectedFinding(null); setActiveTab('explorer'); openFile(entry || { path: item.file, type: 'blob' }) }}><span><code>{item.file}{item.line ? `:${item.line}` : ''}</code><ArrowRight size={13} /></span><pre>{item.text}</pre></button>)}</section><section className="rp-detail-section"><h3>Proposed fix</h3><p>{selectedFinding.recommendation}</p><small>This is a proposal only. UDAAN has not modified the repository.</small></section><section className="rp-detail-section"><h3>Verification method</h3><p>{selectedFinding.verification}</p><span className="rp-verification-status status-not_run">Not run</span></section>{selectedFinding.explanation && <section className="rp-detail-section rp-ai-explanation"><h3><Sparkles size={14} /> AI explanation</h3><p>{selectedFinding.explanation.explanation}</p><h4>Suggested approach</h4><p>{selectedFinding.explanation.proposed_fix}</p><h4>How to verify</h4><p>{selectedFinding.explanation.verification}</p></section>}{analysisError && <p className="rp-inline-error" role="alert">{analysisError}</p>}<div className="rp-finding-dialog-actions"><button type="button" className="rp-button-secondary" onClick={() => setSelectedFinding(null)}>Close</button><button type="button" className="rp-button-primary" onClick={() => explainFinding(selectedFinding)} disabled={explainingFinding || Boolean(selectedFinding.explanation)}>{explainingFinding ? <LoaderCircle size={14} className="rp-spin" /> : <Sparkles size={14} />}{selectedFinding.explanation ? 'Explanation added' : 'Explain with Gemini'}</button></div></section></div>}
      {connectHelp && <div className="rp-dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setConnectHelp(false) }}><section className="rp-connect-dialog" role="dialog" aria-modal="true" aria-labelledby="rp-connect-title"><button type="button" className="rp-dialog-close" aria-label="Close" onClick={() => setConnectHelp(false)}><X size={17} /></button><span className="rp-dialog-icon"><Github size={21} /></span><span className="rp-eyebrow">GITHUB CONNECTION</span><h2 id="rp-connect-title">GitHub authorization isn’t set up yet.</h2><p>This workspace has no GitHub App or OAuth credentials configured. You can still explore a public repository by URL; private repository access will be available after the server-side authorization flow is configured.</p><button type="button" className="rp-button-primary" onClick={() => { setConnectHelp(false); document.getElementById('rp-repository-url')?.focus() }}>Use a public repository URL <ArrowRight size={15} /></button></section></div>}
    </div>
  </div>
}
