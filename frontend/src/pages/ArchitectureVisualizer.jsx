import { useEffect, useMemo, useRef, useState } from 'react'
import { CircleHelp, Database, Download, FileCode2, Layers3, Maximize2, Network, Waypoints, X, ZoomIn, ZoomOut } from 'lucide-react'
import { buildArchitectureDiagram, validateArchitectureDiagram } from '../services/architectureDiagrams.js'
import './ArchitectureVisualizer.css'

const views = [
  { id: 'system', label: 'System Architecture', icon: Network },
  { id: 'database', label: 'Database Schema', icon: Database },
  { id: 'api', label: 'API Connections', icon: Waypoints },
  { id: 'stack', label: 'Technology Stack', icon: Layers3 },
]

function MermaidDiagram({ definition, nodes, onSelect, zoom }) {
  const mount = useRef(null)
  const onSelectRef = useRef(onSelect)
  const cleanupHandlers = useRef([])
  onSelectRef.current = onSelect
  const [renderState, setRenderState] = useState({ svg: '', error: '' })
  useEffect(() => {
    let cancelled = false
    cleanupHandlers.current.forEach(cleanup => cleanup())
    cleanupHandlers.current = []
    async function render() {
      setRenderState({ svg: '', error: '' })
      if (!definition) return
      try {
        const { default: mermaid } = await import('mermaid')
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', htmlLabels: false, themeVariables: { primaryColor: '#e8f3eb', primaryTextColor: '#174a31', primaryBorderColor: '#176b45', lineColor: '#6d9276', edgeLabelBackground: '#fbfdfb', secondaryColor: '#f0f6f1', tertiaryColor: '#fbfdfb', fontFamily: 'Inter, system-ui, sans-serif', fontSize: '15px' }, flowchart: { htmlLabels: false, curve: 'basis', nodeSpacing: 90, rankSpacing: 130, wrappingWidth: 220, padding: 14 }, er: { useMaxWidth: true, fontSize: 14 } })
        const validation = validateArchitectureDiagram(definition)
        if (!validation.valid) throw new Error(validation.reason)
        await mermaid.parse(definition)
        const result = await mermaid.render(`udaan_diagram_${Date.now()}_${Math.random().toString(36).slice(2)}`, definition)
        if (cancelled) return
        setRenderState({ svg: result.svg, error: '' })
      } catch (error) {
        if (!cancelled) {
          const message = error?.message || 'The evidence diagram could not be rendered.'
          if (import.meta.env.DEV) console.error('UDAAN Mermaid diagram failed validation or rendering.', { message, definition })
          setRenderState({ svg: '', error: message })
        }
      }
    }
    render()
    return () => {
      cancelled = true
      cleanupHandlers.current.forEach(cleanup => cleanup())
      cleanupHandlers.current = []
    }
  }, [definition])
  useEffect(() => {
    if (!mount.current || !renderState.svg) return undefined
    mount.current.innerHTML = renderState.svg
    const svg = mount.current.querySelector('svg')
    if (svg) { svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', 'Interactive repository architecture diagram'); svg.style.maxWidth = 'none'; svg.style.height = 'auto' }
    const normalizeNodeLabel = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    const titleMap = new Map((nodes || []).map(node => [normalizeNodeLabel(node.name), node]))
    for (const element of mount.current.querySelectorAll('g.node')) {
      const text = normalizeNodeLabel(element.textContent?.replace(/_\d+$/g, '').replace(/_/g, ' '))
      const selected = titleMap.get(text)
      if (!selected) continue
      element.setAttribute('role', 'button')
      element.setAttribute('tabindex', '0')
      element.setAttribute('aria-label', `Inspect ${selected.name}`)
      const activate = event => { if (event.type !== 'keydown' || event.key === 'Enter' || event.key === ' ') { if (event.type === 'keydown') event.preventDefault(); onSelectRef.current(selected) } }
      element.addEventListener('click', activate)
      element.addEventListener('keydown', activate)
      cleanupHandlers.current.push(() => { element.removeEventListener('click', activate); element.removeEventListener('keydown', activate) })
    }
    return () => { cleanupHandlers.current.forEach(cleanup => cleanup()); cleanupHandlers.current = [] }
  }, [renderState.svg, nodes])
  if (renderState.error) return <div className="av-empty av-diagram-error" role="alert"><CircleHelp size={20} /><strong>Diagram unavailable</strong><p>The source evidence is still listed below. Mermaid could not draw this view.</p><code>{renderState.error.slice(0, 220)}</code>{import.meta.env.DEV && <details className="av-diagnostic"><summary>Mermaid source and parser details</summary><strong>Parser message</strong><pre>{renderState.error}</pre><strong>Generated definition</strong><pre>{definition}</pre></details>}</div>
  if (!renderState.svg) return <div className="av-rendering" aria-live="polite">Preparing evidence diagram…</div>
  return <div className="av-diagram-scroll"><div className="av-diagram" style={{ transform: `scale(${zoom})` }} ref={mount} /></div>
}

function downloadDiagram(format, mount) {
  const svg = mount?.querySelector('svg')
  if (!svg) return
  const clone = svg.cloneNode(true)
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  const source = new XMLSerializer().serializeToString(clone)
  const svgBlob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' })
  const svgUrl = URL.createObjectURL(svgBlob)
  const save = (blob, extension) => { const objectUrl = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = objectUrl; link.download = `udaan-architecture.${extension}`; link.click(); window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000) }
  if (format === 'svg') { save(svgBlob, 'svg'); URL.revokeObjectURL(svgUrl); return }
  const image = new Image()
  image.onload = () => {
    const bounds = svg.getBBox()
    const width = Math.max(1, Math.ceil(bounds.width + 40)); const height = Math.max(1, Math.ceil(bounds.height + 40))
    const canvas = document.createElement('canvas'); canvas.width = width * 2; canvas.height = height * 2
    const context = canvas.getContext('2d'); context.fillStyle = '#fbfdfb'; context.fillRect(0, 0, canvas.width, canvas.height); context.scale(2, 2); context.drawImage(image, 20 - bounds.x, 20 - bounds.y, bounds.width, bounds.height)
    canvas.toBlob(blob => { if (blob) save(blob, 'png'); URL.revokeObjectURL(svgUrl) }, 'image/png')
  }
  image.onerror = () => URL.revokeObjectURL(svgUrl)
  image.src = svgUrl
}

export default function ArchitectureVisualizer({ analysis, repository, loading, onOpenFile }) {
  const [activeView, setActiveView] = useState('system')
  const [selected, setSelected] = useState(null)
  const [zoom, setZoom] = useState(1)
  const diagramMount = useRef(null)
  const architecture = analysis?.architecture || {}
  const nodes = architecture.nodes || []
  const definition = useMemo(() => buildArchitectureDiagram(activeView, analysis), [activeView, analysis])
  const canDiagram = activeView !== 'stack' && Boolean(definition)
  const sourceItems = activeView === 'api' ? (analysis?.insights?.endpoints || []).map(request => ({ name: `${request.method} ${request.path}`, file: request.sourcePath, line: request.line, status: !request.route ? 'unverified' : request.route.methodStatus === 'unknown' ? 'inferred' : 'confirmed', evidence: !request.route ? 'No statically matched Django route was found; dynamic routing may exist.' : request.route.methodStatus === 'mismatch' ? `Path matches ${request.route.view || 'a Django view'}, but the view declares a different HTTP method.` : request.route.methodStatus === 'unknown' ? `Path matches ${request.route.view || 'a Django view'}; supported methods could not be determined statically.` : `Matches ${request.route.view || 'registered Django view'} at ${request.route.sourcePath}:${request.route.line}.` })) : []
  const apiNodes = activeView === 'api' ? [...nodes, ...sourceItems.map(item => ({ id: `${item.file}-${item.line}`, name: item.name, role: item.evidence, files: [item.file], status: item.status, evidence: [{ file: item.file, line: item.line, text: item.evidence }] })), ...(analysis?.insights?.endpoints || []).filter(request => request.route).map(request => ({ id: `view-${request.route.view}`, name: request.route.view || 'Django view', role: 'View registered for a matching API path', technologies: ['Django'], files: [...new Set([request.route.sourcePath, request.route.viewSource])], status: request.route.methodStatus === 'unknown' ? 'inferred' : 'confirmed', evidence: [{ file: request.route.sourcePath, line: request.route.line, text: `${request.method} ${request.path} resolves to ${request.route.view || 'a Django view'}.` }] })), ...(architecture.externalApis || []).map(item => ({ id: item.host, name: item.host, role: 'Direct external HTTPS API request', technologies: ['HTTPS'], files: [item.file], status: 'confirmed', evidence: [{ file: item.file, line: item.line, text: item.evidence }] }))] : nodes
  const isEmpty = repository?.isEmpty || !analysis?.evidenceFiles?.length
  const systemPartial = !architecture.frontend || !architecture.backend || !architecture.databaseConfigured || !(architecture.relationships || []).some(edge => edge.fromId === 'frontend')
  useEffect(() => { setSelected(null); setZoom(1) }, [analysis?.revision, repository?.fullName])

  function handleNodeSelect(node) { setSelected(node) }
  function changeZoom(by) { setZoom(value => Math.max(.55, Math.min(1.8, Math.round((value + by) * 100) / 100))) }
  function exportDiagram(format) { downloadDiagram(format, diagramMount.current) }

  return <section className="av-shell" aria-label="Interactive architecture visualizer">
    <header className="av-heading"><div><span className="av-kicker"><Network size={14} /> ARCHITECTURE VISUALIZER</span><h2>Explore how the system fits together</h2><p>Diagrams use {analysis?.scanCoverage?.inspectedFiles ?? analysis?.evidenceFiles?.length ?? 0} inspected source files from <strong>{repository?.revision?.slice(0, 8) || 'the current revision'}</strong>. No repository code is executed.</p></div>{repository?.syncedAt && <span className="av-revision">Synced {new Date(repository.syncedAt).toLocaleDateString()}</span>}</header>
    {loading ? <div className="av-state"><span className="rp-spin" /><strong>Analysing repository evidence…</strong><p>The visualizer updates after repository sync completes.</p></div> : isEmpty ? <div className="av-empty av-empty-start"><div><Network size={27} /></div><h3>{repository?.isEmpty ? 'Your repository is empty' : 'No readable source evidence found'}</h3><p>{repository?.isEmpty ? 'Sync a repository with source files and manifests. UDAAN will detect components, routes, database models, and direct external API calls.' : 'The repository file tree is available in Code Explorer, but the architecture scan could not inspect source files. Sync again after checking public GitHub access and file-size limits.'}</p></div> : <>
      <nav className="av-view-switcher" aria-label="Architecture views">{views.map(item => { const Icon = item.icon; return <button type="button" key={item.id} className={activeView === item.id ? 'active' : ''} aria-pressed={activeView === item.id} onClick={() => { setActiveView(item.id); setSelected(null); setZoom(1) }}><Icon size={15} /><span>{item.label}</span></button> })}</nav>
      {(analysis?.scanCoverage?.limited || repository?.truncated) && <div className="av-partial"><CircleHelp size={15} /><span>The repository scan was limited to relevant readable source files{repository?.truncated ? ' and the GitHub file tree was truncated' : ''}. Uninspected files may contain additional components or connections.</span></div>}
      {activeView === 'stack' ? <section className="av-stack-view"><div className="av-section-title"><div><h3>Detected technology stack</h3><p>Dependencies and engines below are declared in repository manifests or configuration.</p></div><span>{(architecture.technologies || []).length} detected</span></div>{architecture.technologies?.length ? <div className="av-stack-grid">{architecture.technologies.map((item, index) => <button type="button" className="av-stack-item" key={`${item.name}-${item.file}-${index}`} onClick={() => item.file && onOpenFile?.(item.file)} disabled={!item.file}><span className="av-stack-mark"><Layers3 size={16} /></span><span><strong>{item.name}</strong><small>{item.group} · {item.status}</small><code>{item.file || 'GitHub metadata'}</code></span><FileCode2 size={14} /></button>)}</div> : <div className="av-empty"><CircleHelp size={19} /><strong>No package dependencies detected</strong><p>Inspected files did not include supported dependency manifests.</p></div>}</section> : <>
        {activeView === 'database' && !architecture.databaseSchema?.entities?.length && <div className="av-partial"><CircleHelp size={15} /><span>No supported Django model, Prisma schema, or SQL table definitions were found in inspected files. Other architecture views remain available.</span></div>}
        {activeView === 'system' && systemPartial && <div className="av-partial"><CircleHelp size={15} /><span>This scan found only part of the system. Missing components or relationships are left unconnected; dashed nodes mark components whose runtime relationship is unverified.</span></div>}
        <div className="av-diagram-toolbar"><div className="av-legend"><span><i className="confirmed" /> Confirmed</span><span><i className="inferred" /> Inferred</span><span><i className="unverified" /> Unverified</span></div><div className="av-tools"><button type="button" onClick={() => changeZoom(-.1)} aria-label="Zoom out"><ZoomOut size={15} /></button><span>{Math.round(zoom * 100)}%</span><button type="button" onClick={() => changeZoom(.1)} aria-label="Zoom in"><ZoomIn size={15} /></button><button type="button" onClick={() => setZoom(1)} aria-label="Reset zoom"><Maximize2 size={14} /></button><button type="button" onClick={() => exportDiagram('svg')} disabled={!canDiagram}><Download size={14} /> SVG</button><button type="button" onClick={() => exportDiagram('png')} disabled={!canDiagram}><Download size={14} /> PNG</button></div></div>
        <div ref={diagramMount} className="av-diagram-panel">{canDiagram ? <MermaidDiagram key={`${activeView}-${analysis?.revision || ''}`} definition={definition} zoom={zoom} nodes={activeView === 'database' ? architecture.databaseSchema?.entities?.map(entity => ({ ...entity, name: entity.displayName || entity.name, role: entity.kind, status: 'confirmed', files: [entity.file], evidence: [{ file: entity.file, line: entity.line, text: `${entity.kind}: ${entity.name}` }] })) : apiNodes} onSelect={handleNodeSelect} /> : <div className="av-empty"><CircleHelp size={20} /><strong>{activeView === 'database' ? 'No database schema to draw' : 'No component relationships were detected'}</strong><p>Evidence is shown in the details below. No links have been inferred from names alone.</p></div>}</div>
        {selected && <aside className="av-component-detail"><div className="av-detail-head"><span className="av-stack-mark"><Layers3 size={16} /></span><div><span className={`av-status status-${selected.status || 'unverified'}`}>{selected.status || 'Unverified'}</span><h3>{selected.name}</h3></div><button type="button" onClick={() => setSelected(null)} aria-label="Close component details"><X size={16} /></button></div><p>{selected.role || selected.kind || 'Detected component from repository source.'}</p>{selected.technologies?.length > 0 && <div className="av-detail-block"><h4>Technologies</h4><div className="av-chips">{selected.technologies.map(item => <span key={item}>{item}</span>)}</div></div>}{selected.fields?.length > 0 && <div className="av-detail-block"><h4>Detected fields</h4><div className="av-field-list">{selected.fields.map(field => <span key={`${field.name}-${field.line}`}><code>{field.name}</code><small>{field.type}</small></span>)}</div></div>}{selected.files?.length > 0 && <div className="av-detail-block"><h4>Repository files</h4>{selected.files.map(path => <button className="av-source-link" type="button" key={path} onClick={() => onOpenFile?.(path)}><FileCode2 size={13} /><span>{path}</span></button>)}</div>}{selected.evidence?.length > 0 && <div className="av-detail-block"><h4>Evidence</h4>{selected.evidence.map((item, index) => { const file = typeof item === 'string' ? item : `${item.file}${item.line ? `:${item.line}` : ''}`; const text = typeof item === 'string' ? item : item.text; return <button className="av-evidence-link" type="button" key={`${file}-${index}`} onClick={() => typeof item !== 'string' && onOpenFile?.(item.file)}><code>{file}</code><small>{text}</small></button> })}</div>}</aside>}
        {activeView === 'api' && <div className="av-source-list"><div className="av-section-title"><div><h3>Detected API request sites</h3><p>Endpoint matches are static route checks, not runtime request verification.</p></div><span>{sourceItems.length}</span></div>{sourceItems.length ? sourceItems.map((item, index) => <button type="button" className="av-api-row" key={`${item.file}-${item.line}-${index}`} onClick={() => onOpenFile?.(item.file)}><strong>{item.name}</strong><span>{item.evidence}</span><code>{item.file}:{item.line}</code></button>) : <p className="av-no-items">No literal API request sites were detected in the inspected frontend service files.</p>}</div>}
      </>}
    </>}
  </section>
}
