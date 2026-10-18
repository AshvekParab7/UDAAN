import { apiRequest } from './apiClient.js'
import { analyzeRepository, collectRepositorySourcePaths } from './repositoryAnalysis.js'

const API_ROOT = 'https://api.github.com'
const FILE_LIMIT = 256 * 1024
const LOCAL_STORAGE_KEY = 'udaan:connected-public-repository'

export function parseRepositoryUrl(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Enter a GitHub repository URL or owner/name.')
  }
  const trimmed = raw.trim()
  let urlString = trimmed
  if (!/^https?:\/\//i.test(urlString)) {
    if (/^[\w.-]+\/[\w.-]+$/.test(urlString)) {
      urlString = `https://github.com/${urlString}`
    } else {
      urlString = `https://${urlString}`
    }
  }

  let url
  try {
    url = new URL(urlString)
  } catch {
    throw new Error('Enter a valid GitHub repository URL.')
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Use an https://github.com/owner/repository URL.')
  }
  if (url.hostname.toLowerCase() !== 'github.com') {
    throw new Error('Only GitHub repositories are currently supported.')
  }
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2) {
    throw new Error('Enter a repository link in the format github.com/owner/repository.')
  }
  const [owner, rawName] = parts
  const name = rawName.replace(/\.git$/i, '')
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error('That repository address is not valid.')
  }
  return { owner, name }
}

export async function githubRequest(path) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  let response
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('GitHub did not respond in time. Check your connection and try again.')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }

  if (response.status === 404) {
    throw new Error('Repository not found, or it is private. Public repositories can be connected directly; private repositories require configured authorization.')
  }
  if (response.status === 403 && response.headers.get('X-RateLimit-Remaining') === '0') {
    throw new Error('GitHub public API rate limit reached. Please wait a few minutes and try again.')
  }
  if (response.status === 409) {
    // Git Repository is empty
    return { empty: true }
  }
  if (!response.ok) {
    throw new Error(`GitHub could not complete that request (HTTP ${response.status}).`)
  }
  return response.json()
}

export async function fetchRepositoryMetadata(owner, name) {
  const metadata = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`)
  if (metadata.private) {
    throw new Error('This repository is private. Private access requires server-side GitHub authorization, which is not configured yet.')
  }
  return metadata
}

export async function fetchRepositoryBranches(owner, name) {
  try {
    const branches = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches`)
    if (Array.isArray(branches)) {
      return branches.map(b => ({ name: b.name, sha: b.commit?.sha || '' }))
    }
    return []
  } catch (error) {
    // An empty repo may have no branches or return 404/409
    if (error.message && /empty|not found/i.test(error.message)) {
      return []
    }
    throw error
  }
}

export async function fetchRepositoryTree(owner, name, branch) {
  try {
    if (!branch) {
      return { entries: [], sha: '', empty: true }
    }
    const treeResponse = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${encodeURIComponent(branch)}?recursive=1`)
    if (treeResponse.empty) {
      return { entries: [], sha: '', empty: true }
    }
    const entries = (treeResponse.tree || []).filter(entry => ['blob', 'tree'].includes(entry.type))
    return {
      entries,
      sha: treeResponse.sha || '',
      truncated: Boolean(treeResponse.truncated || entries.length > 500),
      empty: entries.length === 0,
    }
  } catch (error) {
    if (error.message && /empty|409/i.test(error.message)) {
      return { entries: [], sha: '', empty: true }
    }
    throw error
  }
}

export async function fetchManifests(owner, name, branch, entries) {
  const manifests = { packageJson: null, requirements: '', pyproject: '' }
  if (!entries || !entries.length || !branch) return manifests
  const manifestPaths = entries
    .filter(e => e.type === 'blob' && /(^|\/)(package\.json|requirements\.txt|pyproject\.toml)$/i.test(e.path))
    .slice(0, 5)

  for (const entry of manifestPaths) {
    if (entry.size > FILE_LIMIT) continue
    try {
      const result = await githubRequest(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${entry.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`
      )
      if (result.content) {
        const bytes = Uint8Array.from(atob(result.content.replace(/\s/g, '')), char => char.charCodeAt(0))
        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
        const filename = entry.path.split('/').pop().toLowerCase()
        if (filename === 'package.json') {
          try { manifests.packageJson = JSON.parse(text) } catch { /* ignore */ }
        } else if (filename === 'requirements.txt') {
          manifests.requirements += (manifests.requirements ? '\n' : '') + text
        } else if (filename === 'pyproject.toml') {
          manifests.pyproject += (manifests.pyproject ? '\n' : '') + text
        }
      }
    } catch {
      // Manifest read failure is non-fatal
    }
  }
  return manifests
}

export async function fetchSourceFiles(owner, name, branch, entries, limit = 40) {
  if (!entries || !entries.length || !branch) return {}
  const paths = collectRepositorySourcePaths(entries, limit)
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
      } catch {
        // Skip unavailable or restricted files safely
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, paths.length) }, worker))
  return files
}

export async function syncAndAnalyzeRepository(owner, name, branchPreference = null) {
  const metadata = await fetchRepositoryMetadata(owner, name)
  const branch = branchPreference || metadata.default_branch || 'main'
  let treeResult = { entries: [], sha: '', empty: true }
  if (metadata.size !== 0 && metadata.default_branch) {
    treeResult = await fetchRepositoryTree(owner, name, branch)
  } else if (metadata.size === 0) {
    treeResult = { entries: [], sha: '', empty: true }
  } else {
    treeResult = await fetchRepositoryTree(owner, name, branch)
  }
  const entries = treeResult.entries || []
  const isEmpty = Boolean(treeResult.empty || entries.length === 0 || metadata.size === 0)

  const repoData = {
    owner,
    name: metadata.name,
    fullName: metadata.full_name,
    url: metadata.html_url,
    branch,
    language: metadata.language || '',
    visibility: metadata.visibility || 'public',
    syncedAt: new Date().toISOString(),
    revision: treeResult.sha || '',
    truncated: treeResult.truncated || false,
    isEmpty,
  }

  if (isEmpty) {
    const emptyAnalysis = {
      revision: treeResult.sha || '',
      generatedAt: new Date().toISOString(),
      findings: [],
      architecture: { frontend: false, backend: false, components: [], routes: [], rootUrlConfig: null, apiServiceFiles: [], connections: [] },
      insights: { entryPoints: [], dependencies: [], scripts: {}, packageFile: 'package.json', testFiles: [], configFiles: [], endpointCount: 0, endpoints: [], environment: [], corsOrigins: [], apiBase: null },
      verification: [],
      evidenceFiles: [],
    }
    const persisted = { ...repoData, tree: [], analysis: emptyAnalysis, manifests: {} }
    saveConnectedRepoLocally(persisted)
    return { repository: repoData, entries: [], manifests: {}, analysis: emptyAnalysis, files: {} }
  }

  const manifests = await fetchManifests(owner, name, branch, entries)
  const sourceFiles = await fetchSourceFiles(owner, name, branch, entries)
  if (manifests.packageJson && !sourceFiles['package.json']) {
    sourceFiles['package.json'] = JSON.stringify(manifests.packageJson)
  }
  const analysis = analyzeRepository({ repository: repoData, entries, files: sourceFiles, manifests })
  const persisted = { ...repoData, tree: entries, analysis, manifests }
  saveConnectedRepoLocally(persisted)
  return { repository: repoData, entries, manifests, analysis, files: sourceFiles }
}

export function detectTechnologies(metadata, entries = [], manifests = {}) {
  const paths = new Set(entries.map(entry => entry.path.toLowerCase()))
  const packageJson = manifests.packageJson || {}
  const dependencies = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) }
  const requirements = manifests.requirements || ''
  const pyproject = manifests.pyproject || ''
  const detected = []
  const add = (name, evidence) => detected.push({ name, evidence })

  if (dependencies.react || [...paths].some(path => /(^|\/)[^/]+\.(jsx|tsx)$/.test(path))) {
    add('React', dependencies.react ? 'Declared in package.json' : 'JSX or TSX files found')
  }
  if (paths.has('vite.config.js') || paths.has('vite.config.ts') || paths.has('vite.config.mjs') || packageJson.devDependencies?.vite || packageJson.dependencies?.vite) {
    add('Vite', paths.has('vite.config.js') || paths.has('vite.config.ts') || paths.has('vite.config.mjs') ? 'Vite configuration found' : 'Declared in package.json')
  }
  if (paths.has('manage.py') || [...paths].some(path => path.endsWith('/manage.py'))) {
    add('Django', 'manage.py found')
  }
  if (/djangorestframework|\bdjangorestframework\b/i.test(requirements)) {
    add('Django REST Framework', 'Listed in requirements.txt')
  }
  if (dependencies.next) add('Next.js', 'Declared in package.json')
  if (dependencies.vue) add('Vue', 'Declared in package.json')
  if (dependencies.express) add('Express', 'Declared in package.json')
  if (dependencies.tailwindcss) add('Tailwind CSS', 'Declared in package.json')
  if (paths.has('go.mod')) add('Go', 'go.mod found')
  if (paths.has('cargo.toml')) add('Rust', 'Cargo.toml found')
  if (paths.has('pyproject.toml') || paths.has('requirements.txt')) {
    add('Python', paths.has('pyproject.toml') ? 'pyproject.toml found' : 'requirements.txt found')
  }
  if (metadata?.language && !detected.some(item => item.name === metadata.language)) {
    detected.unshift({ name: metadata.language, evidence: 'GitHub repository primary language' })
  }
  return detected
}

export function saveConnectedRepoLocally(repoPayload) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(repoPayload))
    }
  } catch {
    // Non-fatal if localStorage is restricted
  }
}

export function readConnectedRepoLocally() {
  try {
    if (typeof localStorage !== 'undefined') {
      return JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || 'null')
    }
    return null
  } catch {
    return null
  }
}

export function associateProjectRepository(projectId, repositoryData) {
  return apiRequest(`/api/projects/drafts/${encodeURIComponent(projectId)}/repository/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(repositoryData),
  })
}

export function getProjectRepository(projectId) {
  return apiRequest(`/api/projects/drafts/${encodeURIComponent(projectId)}/repository/`)
}

export function disconnectProjectRepository(projectId) {
  return apiRequest(`/api/projects/drafts/${encodeURIComponent(projectId)}/repository/`, {
    method: 'DELETE',
  })
}

export function listConnectedRepositories() {
  return apiRequest('/api/projects/repositories/')
}

export function saveRepositoryAnalysis(projectId, { analysis, commitSha }) {
  return apiRequest(`/api/projects/drafts/${encodeURIComponent(projectId)}/repository/analysis/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ analysis, commit_sha: commitSha }),
  })
}

export function getRepositoryAnalysis(projectId) {
  return apiRequest(`/api/projects/drafts/${encodeURIComponent(projectId)}/repository/analysis/`)
}

export function compareRoadmapWithRepository(projectId, { analysis, commitSha } = {}) {
  return apiRequest(`/api/projects/drafts/${encodeURIComponent(projectId)}/compare-repository/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ analysis, commit_sha: commitSha }),
  })
}

export function getRoadmapAssessment(projectId, commitSha) {
  const query = commitSha ? `?commit_sha=${encodeURIComponent(commitSha)}` : ''
  return apiRequest(`/api/projects/drafts/${encodeURIComponent(projectId)}/roadmap-assessment/${query}`)
}

export function correctTaskAssessment(projectId, taskId, { status, notes, confirmed, verifiedCheckPassed = false }) {
  return apiRequest(`/api/projects/drafts/${encodeURIComponent(projectId)}/roadmap-assessment/tasks/${encodeURIComponent(taskId)}/`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status,
      notes,
      confirmed,
      verified_check_passed: verifiedCheckPassed,
    }),
  })
}

export function explainTaskAssessment({ repository, task, assessment }) {
  return apiRequest('/api/repository/explain-task-assessment/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repository, task, assessment }),
  })
}

