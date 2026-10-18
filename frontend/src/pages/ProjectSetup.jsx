import { useEffect, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  Code2,
  ExternalLink,
  GitBranch,
  Github,
  Layers,
  LoaderCircle,
  Menu,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import Sidebar from '../layouts/Sidebar.jsx'
import {
  associateProjectRepository,
  detectTechnologies,
  disconnectProjectRepository,
  fetchManifests,
  fetchRepositoryBranches,
  fetchRepositoryMetadata,
  fetchRepositoryTree,
  getProjectRepository,
  listConnectedRepositories,
  parseRepositoryUrl,
  readConnectedRepoLocally,
  saveConnectedRepoLocally,
} from '../services/projectRepositoryService.js'
import { fetchProjectDraft, saveProjectDraft } from '../services/ideaWorkflowService.js'
import './ProjectSetup.css'

const draftKey = 'udaan:idea-draft'

function readDraftFromStorage() {
  try {
    return JSON.parse(sessionStorage.getItem(draftKey) || localStorage.getItem(draftKey) || 'null')
  } catch {
    return null
  }
}

function newUuid() {
  return globalThis.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const random = Math.random() * 16 | 0
    return (char === 'x' ? random : (random & 3 | 8)).toString(16)
  })
}

export default function ProjectSetup() {
  const navigate = useNavigate()
  const location = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)

  // Project state
  const [projectDraft, setProjectDraft] = useState(() => {
    const state = location.state || {}
    const stored = readDraftFromStorage() || {}
    const projectId = state.projectId || stored.projectId || newUuid()
    return {
      ...stored,
      projectId,
      idea: state.idea || stored.idea || '',
      projectType: state.projectType || stored.projectType || 'Startup',
    }
  })

  // Repository input & inspected state
  const [urlInput, setUrlInput] = useState('')
  const [existingRepos, setExistingRepos] = useState([])
  const [status, setStatus] = useState('idle') // 'idle' | 'inspecting' | 'ready' | 'connecting' | 'success' | 'error'
  const [error, setError] = useState('')
  const [inspectedRepo, setInspectedRepo] = useState(null)
  const [connectedRepo, setConnectedRepo] = useState(null)
  const [loadingInitial, setLoadingInitial] = useState(true)

  // Load project from Django or verify association
  useEffect(() => {
    let active = true

    async function initialize() {
      const draft = projectDraft
      if (draft.projectId) {
        try {
          // Check if repo already associated in Django
          const repoResponse = await getProjectRepository(draft.projectId).catch(() => null)
          if (active && repoResponse && repoResponse.repo_owner) {
            setConnectedRepo(repoResponse)
            setStatus('success')
          }
        } catch {
          // No repository connected yet, normal state
        }

        // Also fetch draft from Django to ensure sync
        try {
          const draftResponse = await fetchProjectDraft(draft.projectId).catch(() => null)
          if (active && draftResponse) {
            setProjectDraft(current => ({
              ...current,
              idea: draftResponse.idea || current.idea,
              projectType: draftResponse.project_type || current.projectType,
              understanding: draftResponse.understanding || current.understanding,
              workflow: draftResponse.workflow || current.workflow,
            }))
            if (draftResponse.repository) {
              setConnectedRepo(draftResponse.repository)
              setStatus('success')
            }
          }
        } catch {
          // Fall back to storage
        }
      }

      // Check existing connected repos for suggestions
      try {
        const userReposResponse = await listConnectedRepositories().catch(() => null)
        const repos = userReposResponse?.repositories || []
        const local = readConnectedRepoLocally()
        const combined = [...repos]
        if (local && local.fullName && !combined.some(r => r.repo_full_name === local.fullName)) {
          combined.push({
            repo_owner: local.owner,
            repo_name: local.name,
            repo_full_name: local.fullName,
            repo_url: local.url,
            selected_branch: local.branch,
          })
        }
        if (active) {
          setExistingRepos(combined)
        }
      } catch {
        // Non-fatal
      } finally {
        if (active) setLoadingInitial(false)
      }
    }

    initialize()
    return () => { active = false }
  }, [projectDraft.projectId])

  // Inspect repository (fetches metadata, branches, tree, tech detection)
  async function inspectRepository(rawUrl) {
    setError('')
    setStatus('inspecting')
    setInspectedRepo(null)

    try {
      const { owner, name } = parseRepositoryUrl(rawUrl)
      const metadata = await fetchRepositoryMetadata(owner, name)
      const branches = await fetchRepositoryBranches(owner, name)

      // Handle empty repo (no branches)
      if (branches.length === 0) {
        setInspectedRepo({
          owner,
          name,
          fullName: metadata.full_name || `${owner}/${name}`,
          url: metadata.html_url || `https://github.com/${owner}/${name}`,
          branches: [],
          selectedBranch: '',
          commitSha: '',
          isEmpty: true,
          detectedTechs: [],
        })
        setStatus('ready')
        return
      }

      // Determine initial branch
      const defaultBranch = branches.some(b => b.name === metadata.default_branch)
        ? metadata.default_branch
        : branches[0].name
      const branchSha = branches.find(b => b.name === defaultBranch)?.sha || ''

      // Fetch file tree
      const treeResult = await fetchRepositoryTree(owner, name, defaultBranch)

      if (treeResult.empty || treeResult.entries.length === 0) {
        setInspectedRepo({
          owner,
          name,
          fullName: metadata.full_name || `${owner}/${name}`,
          url: metadata.html_url || `https://github.com/${owner}/${name}`,
          branches,
          selectedBranch: defaultBranch,
          commitSha: treeResult.sha || branchSha,
          isEmpty: true,
          detectedTechs: [],
        })
        setStatus('ready')
        return
      }

      // Has code: fetch manifests and detect technologies
      const manifests = await fetchManifests(owner, name, defaultBranch, treeResult.entries)
      const detectedTechs = detectTechnologies(metadata, treeResult.entries, manifests)

      setInspectedRepo({
        owner,
        name,
        fullName: metadata.full_name || `${owner}/${name}`,
        url: metadata.html_url || `https://github.com/${owner}/${name}`,
        branches,
        selectedBranch: defaultBranch,
        commitSha: treeResult.sha || branchSha,
        isEmpty: false,
        detectedTechs,
        entries: treeResult.entries,
      })
      setStatus('ready')
    } catch (caught) {
      setError(caught?.message || 'Could not access that repository. Check the address and try again.')
      setStatus('error')
    }
  }

  // Branch change handler
  async function handleBranchChange(branchName) {
    if (!inspectedRepo || inspectedRepo.selectedBranch === branchName) return
    const branchSha = inspectedRepo.branches.find(b => b.name === branchName)?.sha || ''

    setStatus('inspecting')
    try {
      const treeResult = await fetchRepositoryTree(inspectedRepo.owner, inspectedRepo.name, branchName)
      if (treeResult.empty || treeResult.entries.length === 0) {
        setInspectedRepo(prev => ({
          ...prev,
          selectedBranch: branchName,
          commitSha: treeResult.sha || branchSha,
          isEmpty: true,
          detectedTechs: [],
        }))
      } else {
        const manifests = await fetchManifests(inspectedRepo.owner, inspectedRepo.name, branchName, treeResult.entries)
        const detectedTechs = detectTechnologies(inspectedRepo, treeResult.entries, manifests)
        setInspectedRepo(prev => ({
          ...prev,
          selectedBranch: branchName,
          commitSha: treeResult.sha || branchSha,
          isEmpty: false,
          detectedTechs,
          entries: treeResult.entries,
        }))
      }
      setStatus('ready')
    } catch {
      setInspectedRepo(prev => ({
        ...prev,
        selectedBranch: branchName,
        commitSha: branchSha,
      }))
      setStatus('ready')
    }
  }

  // Connect & persist association to Django
  async function handleConnect() {
    if (!inspectedRepo || !projectDraft.projectId) return
    setStatus('connecting')
    setError('')

    const payload = {
      owner: inspectedRepo.owner,
      name: inspectedRepo.name,
      repo_url: inspectedRepo.url,
      selected_branch: inspectedRepo.selectedBranch,
      connection_status: inspectedRepo.isEmpty ? 'empty' : 'connected',
      last_synced_sha: inspectedRepo.commitSha,
      last_synced_at: new Date().toISOString(),
      detected_technologies: inspectedRepo.detectedTechs,
      is_empty: inspectedRepo.isEmpty,
    }

    try {
      // Ensure draft is saved in Django
      await saveProjectDraft(
        projectDraft,
        projectDraft.understanding || { project_name: '', problem_statement: '', target_users: '', expected_outcome: '' },
        projectDraft.workflow || {},
        'understanding'
      ).catch(() => {})

      // Persist repository association
      const saved = await associateProjectRepository(projectDraft.projectId, payload)

      // Also update local storage for the standalone Repository page
      saveConnectedRepoLocally({
        owner: inspectedRepo.owner,
        name: inspectedRepo.name,
        fullName: inspectedRepo.fullName,
        url: inspectedRepo.url,
        branch: inspectedRepo.selectedBranch,
        language: inspectedRepo.detectedTechs[0]?.name || '',
        visibility: 'public',
        syncedAt: new Date().toISOString(),
        revision: inspectedRepo.commitSha,
        truncated: false,
        tree: inspectedRepo.entries || [],
      })

      setConnectedRepo(saved)
      setStatus('success')
    } catch (caught) {
      setError(caught?.message || 'Could not save the repository association. Please retry.')
      setStatus('error')
    }
  }

  // Disconnect repository
  async function handleDisconnect() {
    if (!projectDraft.projectId) return
    try {
      await disconnectProjectRepository(projectDraft.projectId).catch(() => {})
    } finally {
      setConnectedRepo(null)
      setInspectedRepo(null)
      setStatus('idle')
      setUrlInput('')
    }
  }

  // Skip or continue to idea planning (IdeaAnalysis)
  function handleContinueToAnalysis() {
    navigate('/projects/new/analysis', {
      state: {
        projectId: projectDraft.projectId,
        idea: projectDraft.idea,
        projectType: projectDraft.projectType,
      },
    })
  }

  // Navigate to Repository page
  function handleGoToRepository() {
    navigate('/repository')
  }

  const projectName = projectDraft.understanding?.project_name?.trim() || 'New Project'

  return (
    <div className="ud-dashboard ps-page">
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} activePage="projects" />
      <div className="ud-work-area">
        <header className="ud-topbar">
          <div className="ud-topbar-left">
            <button
              className="ud-mobile-menu ud-icon-button"
              aria-label="Open navigation"
              onClick={() => setMenuOpen(true)}
            >
              <Menu size={20} />
            </button>
            <span className="ud-topbar-title">Project Setup</span>
          </div>
          <div className="ud-topbar-actions">
            <span className="ud-avatar ud-top-avatar">TS</span>
          </div>
        </header>

        <main className="ud-main ps-main">
          <div className="ps-content">
            <Link className="ps-back-link" to="/">
              <ArrowLeft size={14} /> Back to idea input
            </Link>

            <section className="ps-header">
              <span className="ps-eyebrow">
                <Sparkles size={14} /> Project Initialization · Step 1 of 2
              </span>
              <h1>Connect a GitHub Repository</h1>
              <p>
                Optionally link your codebase now so UDAAN can inspect components, detect frameworks, and prepare for Flight Plan verification.
              </p>
            </section>

            {/* Project Summary Card */}
            <section className="ps-project-summary">
              <div className="ps-project-info">
                <span className="ps-project-kicker">Draft Project</span>
                <h3 className="ps-project-name">{projectName}</h3>
                <p className="ps-project-idea">{projectDraft.idea || 'No idea description entered.'}</p>
              </div>
              <span className="ps-type-badge">{projectDraft.projectType}</span>
            </section>

            {/* Main Repository Connection Card */}
            <div className="ps-card">
              {loadingInitial ? (
                <div className="ps-state-box ps-state-loading">
                  <LoaderCircle size={18} className="ps-spin" />
                  <span>Loading project and integration details…</span>
                </div>
              ) : status === 'success' && connectedRepo ? (
                /* Connected State */
                <div className="ps-connected-box">
                  <div className="ps-connected-head">
                    <span className="ps-badge-connected">
                      <Check size={14} /> Repository Connected
                    </span>
                    <button
                      type="button"
                      className="ps-btn-ghost"
                      onClick={handleDisconnect}
                      title="Disconnect repository"
                    >
                      <Trash2 size={14} /> Disconnect
                    </button>
                  </div>

                  <div className="ps-repo-meta">
                    <div className="ps-repo-id">
                      <Github size={22} />
                      <div>
                        <strong>{connectedRepo.repo_full_name}</strong>
                        {connectedRepo.selected_branch && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 11, color: '#556b59' }}>
                            <GitBranch size={12} />
                            <span>branch: <b>{connectedRepo.selected_branch}</b></span>
                            {connectedRepo.last_synced_sha && (
                              <span className="ps-sha-pill">
                                {connectedRepo.last_synced_sha.slice(0, 7)}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    {connectedRepo.repo_url && (
                      <a
                        href={connectedRepo.repo_url}
                        target="_blank"
                        rel="noreferrer"
                        className="ps-repo-link"
                      >
                        GitHub <ExternalLink size={12} />
                      </a>
                    )}
                  </div>

                  {connectedRepo.is_empty ? (
                    <div className="ps-empty-repo-banner">
                      <Code2 size={16} />
                      <div className="ps-empty-repo-copy">
                        <strong>Repository connected — no source files detected yet.</strong>
                        <p>You can start building your codebase and sync with UDAAN whenever you push commits.</p>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 650, color: '#415546', marginBottom: 6 }}>
                        Detected Technologies
                      </div>
                      <div className="ps-tech-list">
                        {(connectedRepo.detected_technologies || []).length ? (
                          connectedRepo.detected_technologies.map(tech => (
                            <span className="ps-tech-pill" key={tech.name}>
                              <Layers size={11} />
                              <b>{tech.name}</b>
                              {tech.evidence && <small>({tech.evidence})</small>}
                            </span>
                          ))
                        ) : (
                          <span style={{ fontSize: 11, color: '#738677' }}>
                            No specific frameworks detected in repository manifests.
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="ps-actions-row">
                    <button
                      type="button"
                      className="ps-btn-secondary"
                      onClick={handleGoToRepository}
                    >
                      <Code2 size={14} /> Open Repository Analysis
                    </button>
                    <button
                      type="button"
                      className="ps-btn-primary"
                      onClick={handleContinueToAnalysis}
                    >
                      Continue to Idea Planning <ArrowRight size={15} />
                    </button>
                  </div>
                </div>
              ) : (
                /* Connect / Form State */
                <>
                  <div className="ps-repo-form">
                    <label htmlFor="repo-url-input" className="ps-section-title">
                      Connect GitHub Repository
                    </label>
                    <div className="ps-input-group">
                      <div className="ps-repo-input">
                        <Github size={18} />
                        <input
                          id="repo-url-input"
                          type="text"
                          value={urlInput}
                          onChange={e => {
                            setUrlInput(e.target.value)
                            if (error) setError('')
                          }}
                          placeholder="e.g. owner/repository or https://github.com/..."
                          disabled={status === 'inspecting' || status === 'connecting'}
                          onKeyDown={e => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              if (urlInput.trim()) inspectRepository(urlInput)
                            }
                          }}
                        />
                      </div>
                      <button
                        type="button"
                        className="ps-btn-primary"
                        onClick={() => inspectRepository(urlInput)}
                        disabled={!urlInput.trim() || status === 'inspecting' || status === 'connecting'}
                      >
                        {status === 'inspecting' ? (
                          <>
                            <LoaderCircle size={15} className="ps-spin" /> Checking…
                          </>
                        ) : (
                          <>
                            Inspect <ArrowRight size={15} />
                          </>
                        )}
                      </button>
                    </div>

                    <small style={{ color: '#7a8c7e', fontSize: 11, lineHeight: 1.5 }}>
                      Connect an existing public GitHub repository. No private tokens are needed or exposed.
                    </small>
                  </div>

                  {/* Existing Repositories Quick List */}
                  {existingRepos.length > 0 && status !== 'ready' && (
                    <div className="ps-quick-list">
                      <span>Recently connected repositories:</span>
                      <div className="ps-quick-chips">
                        {existingRepos.slice(0, 4).map(repo => (
                          <button
                            key={repo.repo_full_name}
                            type="button"
                            className="ps-chip"
                            onClick={() => {
                              setUrlInput(repo.repo_full_name)
                              inspectRepository(repo.repo_full_name)
                            }}
                          >
                            <Github size={12} />
                            {repo.repo_full_name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Error State with Retry */}
                  {error && (
                    <div className="ps-state-box ps-state-error">
                      <AlertCircle size={17} style={{ flex: '0 0 auto' }} />
                      <div style={{ flex: 1 }}>{error}</div>
                      <button
                        type="button"
                        className="ps-btn-secondary"
                        style={{ height: 32, padding: '0 10px', fontSize: 11 }}
                        onClick={() => inspectRepository(urlInput)}
                      >
                        <RefreshCw size={12} /> Retry
                      </button>
                    </div>
                  )}

                  {/* Inspected Repository Preview */}
                  {inspectedRepo && status === 'ready' && (
                    <div className="ps-inspected-card">
                      <div className="ps-repo-meta">
                        <div className="ps-repo-id">
                          <Github size={20} />
                          <div>
                            <strong>{inspectedRepo.fullName}</strong>
                            <div style={{ fontSize: 11, color: '#687d6d', marginTop: 2 }}>
                              Status: {inspectedRepo.isEmpty ? 'Empty repository' : 'Ready to connect'}
                            </div>
                          </div>
                        </div>
                        <a
                          href={inspectedRepo.url}
                          target="_blank"
                          rel="noreferrer"
                          className="ps-repo-link"
                        >
                          View on GitHub <ExternalLink size={12} />
                        </a>
                      </div>

                      {/* Branch selector if branches exist */}
                      {inspectedRepo.branches.length > 0 && (
                        <div className="ps-branch-selector">
                          <GitBranch size={15} />
                          <label htmlFor="ps-branch-select">Branch:</label>
                          <select
                            id="ps-branch-select"
                            value={inspectedRepo.selectedBranch}
                            onChange={e => handleBranchChange(e.target.value)}
                          >
                            {inspectedRepo.branches.map(branch => (
                              <option key={branch.name} value={branch.name}>
                                {branch.name}
                              </option>
                            ))}
                          </select>
                          {inspectedRepo.commitSha && (
                            <span className="ps-sha-pill" title="Latest revision commit SHA">
                              {inspectedRepo.commitSha.slice(0, 7)}
                            </span>
                          )}
                        </div>
                      )}

                      {/* Empty vs Code detection display */}
                      {inspectedRepo.isEmpty ? (
                        <div className="ps-empty-repo-banner">
                          <Code2 size={16} />
                          <div className="ps-empty-repo-copy">
                            <strong>Repository connected — no source files detected yet.</strong>
                            <p>You can start building and sync again later. No languages or test checks were fabricated.</p>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 650, color: '#384c3c', marginBottom: 6 }}>
                            Detected Languages & Frameworks
                          </div>
                          <div className="ps-tech-list">
                            {inspectedRepo.detectedTechs.length ? (
                              inspectedRepo.detectedTechs.map(tech => (
                                <span className="ps-tech-pill" key={tech.name}>
                                  <Layers size={11} />
                                  <b>{tech.name}</b>
                                  {tech.evidence && <small>({tech.evidence})</small>}
                                </span>
                              ))
                            ) : (
                              <span style={{ fontSize: 11, color: '#7a8e80' }}>
                                Code files found; no standard manifest frameworks detected.
                              </span>
                            )}
                          </div>
                        </div>
                      )}

                      <div className="ps-actions-row">
                        <button
                          type="button"
                          className="ps-btn-secondary"
                          onClick={() => {
                            setInspectedRepo(null)
                            setUrlInput('')
                          }}
                        >
                          Choose another
                        </button>
                        <button
                          type="button"
                          className="ps-btn-primary"
                          onClick={handleConnect}
                          disabled={status === 'connecting'}
                        >
                          {status === 'connecting' ? (
                            <>
                              <LoaderCircle size={15} className="ps-spin" /> Connecting…
                            </>
                          ) : inspectedRepo.isEmpty ? (
                            <>
                              Connect Empty Repository & Continue <ArrowRight size={15} />
                            </>
                          ) : (
                            <>
                              Connect Repository <ArrowRight size={15} />
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Skip Option Footer */}
                  <div className="ps-actions-row" style={{ marginTop: 12 }}>
                    <span style={{ fontSize: 11, color: '#748677' }}>
                      Don’t have a repository ready? You can connect it at any time.
                    </span>
                    <button
                      type="button"
                      className="ps-btn-secondary"
                      onClick={handleContinueToAnalysis}
                    >
                      Skip for now <ArrowRight size={14} />
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
