export function escapeMermaidLabel(value, fallback = 'Unnamed component') {
  // All call sites wrap labels in Mermaid's quoted text syntax. Keep ordinary
  // punctuation literal so Mermaid renders it as text (not HTML entities).
  // Quotes are made typographic because raw `"` terminates Mermaid's string.
  let openingQuote = true
  return (String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\\/g, '＼').replace(/"/g, () => {
    const quote = openingQuote ? '“' : '”'
    openingQuote = !openingQuote
    return quote
  }).replace(/\s+/g, ' ').trim() || fallback)
}

function conciseRelationshipLabel(edge) {
  const matchedRoutes = edge.label?.match(/^(\d+) statically matched API route\(s\)$/)
  if (matchedRoutes) {
    const count = Number(matchedRoutes[1])
    return `${count} matched API route${count === 1 ? '' : 's'} — Static source match`
  }
  const schemaEntities = edge.label?.match(/^(\d+) schema entity\(ies\); runtime connection unverified$/)
  if (schemaEntities) {
    const count = Number(schemaEntities[1])
    return `${count} schema ${count === 1 ? 'entity' : 'entities'} — Runtime unverified`
  }
  if (/^Database provider configured; runtime connection unverified$/.test(edge.label || '')) return 'Database configuration — Runtime unverified'
  if (/^external_\d+$/.test(edge.fromId || '') || /^external_\d+$/.test(edge.toId || '')) return `${edge.label || 'HTTPS'} call — Static source evidence`
  return edge.label || 'Source relationship detected'
}

function architectureNodeId(value, index) {
  // The analyzer emits these IDs; never derive a diagram identifier from a path,
  // route, or generated description.
  if (['frontend', 'backend', 'database'].includes(value) || /^external_\d+$/.test(value || '')) return value
  return `component_${index}`
}

function safeEntityId(value, index) {
  // ER syntax requires entity identifiers. These come only from detected schema
  // model/table names (never file paths or AI descriptions), normalized to IDs.
  const normalized = String(value || '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z_]+/, '')
  return normalized ? `${normalized}_${index}` : `Entity_${index}`
}

function safeErAttribute(value, fallback) {
  // Mermaid ER attributes use identifier-like type and field tokens. Keep the
  // full source values in the component details; this token is only for syntax.
  const normalized = String(value || fallback).replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_')
  return normalized || fallback
}

const classes = [
  '  classDef confirmed fill:#e8f3eb,stroke:#176b45,color:#174a31,stroke-width:1.5px',
  '  classDef inferred fill:#f0f6f1,stroke:#83a98c,color:#31583d,stroke-dasharray:5 3',
  '  classDef unverified fill:#f8faf8,stroke:#c7d3c9,color:#65746a,stroke-dasharray:3 3',
]

function statusClass(status) {
  return status === 'confirmed' ? 'confirmed' : status === 'inferred' ? 'inferred' : 'unverified'
}

function connectedDiagram(architecture) {
  const nodes = architecture?.nodes || []
  const edges = architecture?.relationships || []
  if (!nodes.length) return ''
  const rows = ['flowchart LR', ...classes]
  const ids = new Map(nodes.map((node, index) => [node.id, architectureNodeId(node.id, index)]))
  for (const node of nodes) rows.push(`  ${ids.get(node.id)}["${escapeMermaidLabel(node.name)}"]:::${statusClass(node.status)}`)
  let linkIndex = 0
  for (const edge of edges) {
    if (!ids.has(edge.fromId) || !ids.has(edge.toId)) continue
    const status = statusClass(edge.status)
    const label = conciseRelationshipLabel(edge)
    // Quoted edge labels avoid Mermaid's pipe-delimited label grammar.
    rows.push(`  ${ids.get(edge.fromId)} -- "${escapeMermaidLabel(label)}" --> ${ids.get(edge.toId)}`)
    if (status === 'inferred') rows.push(`  linkStyle ${linkIndex} stroke:#83a98c,stroke-dasharray:5 4`)
    if (status === 'unverified') rows.push(`  linkStyle ${linkIndex} stroke:#c7d3c9,stroke-dasharray:3 4`)
    linkIndex += 1
  }
  return rows.join('\n')
}

function databaseDiagram(schema) {
  const entities = schema?.entities || []
  if (!entities.length) return ''
  const visible = entities.slice(0, 40)
  const ids = new Map(visible.map((entity, index) => [entity, safeEntityId(entity.displayName || entity.name, index)]))
  const rows = ['erDiagram']
  for (const entity of visible) {
    rows.push(`  ${ids.get(entity)} {`)
    for (const field of (entity.fields || []).slice(0, 24)) {
      rows.push(`    ${safeErAttribute(field.type, 'unknown')} ${safeErAttribute(field.name, 'field')}`)
    }
    rows.push('  }')
  }
  for (const relation of schema.relationships || []) {
    const from = visible.find(entity => entity.name === relation.from && entity.file === relation.file) || visible.find(entity => entity.name === relation.from)
    const to = visible.find(entity => entity.name === relation.to && entity.file === relation.file) || visible.find(entity => entity.name === relation.to)
    if (!from || !to) continue
    const connector = relation.kind === 'OneToOneField' ? '||--||' : relation.kind === 'ManyToManyField' ? '}o--o{' : relation.kind === 'Prisma relation' && relation.cardinality === 'many' ? '}o..o{' : relation.status === 'inferred' ? '}o..||' : '}o--||'
    const evidenceLabel = relation.status === 'inferred' ? `${relation.label} inferred cardinality` : relation.label
    rows.push(`  ${ids.get(from)} ${connector} ${ids.get(to)} : "${escapeMermaidLabel(evidenceLabel, 'Relationship')}"`)
  }
  return rows.join('\n')
}

function apiDiagram(analysis) {
  const architecture = analysis?.architecture || {}
  const nodes = architecture.nodes || []
  const frontend = nodes.find(node => node.id === 'frontend')
  const backend = nodes.find(node => node.id === 'backend')
  const requests = (analysis?.insights?.endpoints || []).slice(0, 24)
  const external = architecture.externalApis || []
  if (!frontend && !backend && !requests.length && !external.length) return ''
  const rows = ['flowchart LR', ...classes]
  if (frontend) rows.push('  frontend["Frontend"]:::confirmed')
  if (backend) rows.push('  backend["Django API"]:::confirmed')
  requests.forEach((request, index) => {
    const endpointId = `endpoint_${index}`
    const routeStatus = !request.route ? 'unverified' : request.route.methodStatus === 'mismatch' || request.route.methodStatus === 'unknown' ? 'inferred' : 'confirmed'
    const routeLabel = !request.route ? 'No static route match' : request.route.methodStatus === 'mismatch' ? 'Static path match · method differs' : request.route.methodStatus === 'unknown' ? 'Static path match · method unknown' : 'Route and method match statically'
    rows.push(`  ${endpointId}["${escapeMermaidLabel(`${request.method} ${request.path}`)}"]:::${routeStatus}`)
    if (frontend) rows.push(`  frontend -- "${escapeMermaidLabel(routeLabel)}" --> ${endpointId}`)
    if (request.route && backend) {
      const viewId = `view_${index}`
      rows.push(`  ${viewId}["${escapeMermaidLabel(request.route.view || 'Django view')}"]:::confirmed`)
      rows.push(`  ${endpointId} -- "Registered Django route" --> ${viewId}`)
      rows.push(`  ${viewId} -- "Django URL route" --> backend`)
    }
  })
  external.forEach((integration, index) => {
    const id = `external_api_${index}`
    rows.push(`  ${id}["${escapeMermaidLabel(integration.host)}"]:::confirmed`)
    const backendSource = integration.sourceId === 'backend'
    const source = backendSource ? backend ? 'django' : null : frontend ? 'frontend' : null
    if (source) rows.push(`  ${source} -- "HTTPS call in source" --> ${id}`)
  })
  return rows.join('\n')
}

export function buildArchitectureDiagram(view, analysis) {
  if (view === 'database') return databaseDiagram(analysis?.architecture?.databaseSchema)
  if (view === 'api') return apiDiagram(analysis)
  if (view === 'system') return connectedDiagram(analysis?.architecture)
  return ''
}

export function validateArchitectureDiagram(definition) {
  if (typeof definition !== 'string' || !definition.trim() || definition.length > 50000) return { valid: false, reason: 'Diagram is empty or exceeds the size limit.' }
  if (!/^(?:flowchart LR|erDiagram)\n/.test(definition)) return { valid: false, reason: 'Unsupported Mermaid diagram type.' }
  if (/^\s*(?:click\s+\w|%%\s*\{|href\s+)/im.test(definition) || /javascript\s*:/i.test(definition)) return { valid: false, reason: 'Diagram contains an unsupported directive.' }
  return { valid: true, reason: '' }
}
