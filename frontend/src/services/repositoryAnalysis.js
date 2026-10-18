const API_CALL = /\b(?:apiRequest|fetch|axios\.(?:get|post|put|patch|delete))\s*\(/g

function lineAt(source, offset) { return source.slice(0, offset).split('\n').length }
function slug(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'finding' }
function balancedCall(source, openIndex) {
  let depth = 0; let quote = ''; let escaped = false
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i]
    if (quote) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue }
    if (char === '(') depth += 1
    else if (char === ')' && --depth === 0) return source.slice(openIndex + 1, i)
  }
  return ''
}
function splitArguments(value) {
  const parts = []; let current = ''; let depth = 0; let quote = ''; let escaped = false
  for (const char of value) {
    if (quote) { current += char; if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'" || char === '`') { quote = char; current += char; continue }
    if ('([{'.includes(char)) depth += 1
    if (')]}'.includes(char)) depth -= 1
    if (char === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue }
    current += char
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}
function stringLiteral(value) { const match = value.match(/^(['"`])([\s\S]*)\1$/); return match?.[2] ?? null }
function cleanPath(path) { return `/${String(path || '').replace(/^\/+|\/+$/g, '')}${String(path || '').endsWith('/') ? '/' : ''}`.replace(/^\/$/, '/') }
function routeSegments(path) { return cleanPath(path).split('/').filter(Boolean).map(segment => segment.startsWith('<') && segment.endsWith('>') ? ':param' : segment) }
function routesMatch(requested, route) {
  const a = routeSegments(requested); const b = routeSegments(route)
  return a.length === b.length && a.every((part, index) => part === b[index] || part === ':param' || b[index] === ':param')
}
function pythonClassInfo(files) {
  const classes = {}
  for (const [path, source] of Object.entries(files)) {
    const lines = source.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const match = lines[i].match(/^class\s+([A-Za-z_]\w*)\s*\(/)
      if (!match) continue
      let end = i + 1
      while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]))) end += 1
      const body = lines.slice(i + 1, end).join('\n')
      const methods = [...body.matchAll(/^\s+def\s+(get|post|put|patch|delete|head|options)\s*\(/gm)].map(item => item[1].toUpperCase())
      classes[match[1]] = { path, line: i + 1, methods: [...new Set(methods)], body }
    }
  }
  return classes
}
function parseDjangoRoutes(files) {
  const urlFiles = Object.entries(files).filter(([path]) => /(^|\/)urls\.py$/i.test(path))
  const byModule = new Map()
  for (const [path] of urlFiles) {
    const module = path.replace(/\.py$/i, '').replace(/\\/g, '/').split('/').join('.')
    byModule.set(module, path)
  }
  const root = urlFiles.find(([path]) => /(^|\/)config\/urls\.py$/i.test(path))?.[0] || urlFiles.find(([path]) => /(^|\/)urls\.py$/i.test(path))?.[0]
  if (!root) return { routes: [], root: null }
  const classes = pythonClassInfo(files)
  const routes = []; const visiting = new Set(); let complete = true
  function visit(path, prefix = '', depth = 0) {
    if (depth > 8 || visiting.has(path)) return
    visiting.add(path)
    const source = files[path] || ''
    if (/\bre_path\s*\(|\brouter\.urls\b/.test(source)) complete = false
    let match
    const urlCallRe = /\bpath\s*\(/g
    while ((match = urlCallRe.exec(source))) {
      const callText = balancedCall(source, match.index + match[0].lastIndexOf('('))
      if (!callText) continue
      const args = splitArguments(callText); const route = stringLiteral(args[0] || '')
      if (route === null || !args[1]) { complete = false; continue }
      const includeMatch = args[1].match(/\binclude\s*\(\s*(['"])([^'"]+)\1\s*\)/)
      const line = lineAt(source, match.index)
      if (includeMatch) {
        const module = includeMatch[2]
        const includePath = byModule.get(module) || urlFiles.find(([candidate]) => candidate.endsWith(`/${module.split('.').join('/')}.py`))?.[0]
        if (includePath) visit(includePath, `${prefix}${route}`, depth + 1)
        else complete = false
        continue
      }
      const viewMatch = args[1].match(/\b([A-Za-z_]\w*)\.as_view\s*\(/)
      const view = viewMatch?.[1] || ''
      routes.push({ path: cleanPath(`${prefix}${route}`), sourcePath: path, line, view, methods: classes[view]?.methods || [], viewSource: classes[view]?.path || path })
    }
    visiting.delete(path)
  }
  visit(root)
  return { routes, root, classes, complete }
}
function extractFrontendEndpoints(files) {
  const requests = []
  for (const [path, source] of Object.entries(files)) {
    API_CALL.lastIndex = 0
    let match
    while ((match = API_CALL.exec(source))) {
      const argsText = balancedCall(source, match.index + match[0].lastIndexOf('('))
      if (!argsText) continue
      const [pathExpression, options = ''] = splitArguments(argsText)
      const literal = stringLiteral(pathExpression || '')
      if (literal === null || /^https?:\/\//i.test(literal)) continue
      const endpoint = literal.replace(/\$\{[^}]*\}/g, ':param').replace(/\$\{[^}]*\}/g, ':param')
      const axiosMethod = match[0].match(/axios\.(get|post|put|patch|delete)/i)?.[1]?.toUpperCase()
      const method = axiosMethod || options.match(/\bmethod\s*:\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]/i)?.[1]?.toUpperCase() || 'GET'
      const stringifyMatch = options.match(/JSON\.stringify\s*\(/)
      const bodySource = stringifyMatch ? balancedCall(options, stringifyMatch.index + 'JSON.stringify'.length) : ''
      const bodyObject = bodySource.trim().replace(/^\{/, '').replace(/\}$/, '')
      const bodyFields = bodyObject ? splitArguments(bodyObject).map(part => part.match(/^\s*([A-Za-z_]\w*)\s*(?::|$)/)?.[1]).filter(Boolean) : []
      requests.push({ path: cleanPath(endpoint), method, sourcePath: path, line: lineAt(source, match.index), expression: literal, bodyFields })
    }
  }
  return requests
}
function addFinding(findings, finding) {
  const base = `${finding.title}:${finding.file || ''}:${finding.line || ''}`
  findings.push({ id: slug(base), status: 'confirmed', confidence: 'high', ...finding })
}
function methodCompatibility(requested, route) {
  if (!route.methods.length) return 'unknown'
  if (route.methods.includes(requested)) return 'compatible'
  if (requested === 'HEAD' && route.methods.includes('GET')) return 'compatible'
  return 'mismatch'
}

function extractDatabaseSchema(files) {
  const entities = []
  const relationships = []
  const providers = []
  for (const [path, source] of Object.entries(files)) {
    if (/(^|\/)models\.py$/i.test(path)) {
      const lines = source.split('\n')
      const lineOffsets = []
      let sourceOffset = 0
      for (const line of lines) { lineOffsets.push(sourceOffset); sourceOffset += line.length + 1 }
      for (let index = 0; index < lines.length; index += 1) {
        const model = lines[index].match(/^class\s+([A-Za-z_]\w*)\s*\(([^)]*(?:models\.)?Model[^)]*)\)/)
        if (!model) continue
        const fields = []
        let end = index + 1
        while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]))) {
          const field = lines[end].match(/^\s+([A-Za-z_]\w*)\s*=\s*models\.([A-Za-z_]\w*)\s*\((.*)$/)
          if (field) {
            fields.push({ name: field[1], type: field[2], line: end + 1 })
            if (/^(?:ForeignKey|OneToOneField|ManyToManyField)$/.test(field[2])) {
              const openIndex = source.indexOf('(', lineOffsets[end] + lines[end].indexOf(`models.${field[2]}`) + `models.${field[2]}`.length)
              const args = openIndex >= 0 ? balancedCall(source, openIndex) : field[3]
              const target = args.match(/^\s*(['"])([^'"]+)\1/)?.[2] || args.match(/^\s*([A-Za-z_]\w*)\s*(?:,|\))/)?.[1] || args.match(/\bto\s*=\s*(?:(['"])([^'"]+)\1|([A-Za-z_]\w*))/)?.slice(2).find(Boolean)
              if (target && !/^self$/i.test(target)) relationships.push({ from: model[1], to: target.split('.').pop(), label: field[1], kind: field[2], status: 'confirmed', file: path, line: end + 1, evidence: `${field[2]} explicitly references ${target}.` })
            }
          }
          end += 1
        }
        entities.push({ name: model[1], fields, file: path, line: index + 1, kind: 'Django model' })
      }
    }
    if (/\.prisma$/i.test(path)) {
      const provider = source.match(/^\s*provider\s*=\s*['"]([^'"]+)['"]/m)?.[1]
      if (provider) providers.push({ name: provider, file: path, line: lineAt(source, source.indexOf(provider)) })
      const lines = source.split('\n')
      const modelNames = new Set([...source.matchAll(/^\s*model\s+([A-Za-z_]\w*)\s*\{/gm)].map(match => match[1]))
      for (let index = 0; index < lines.length; index += 1) {
        const model = lines[index].match(/^\s*model\s+([A-Za-z_]\w*)\s*\{/)
        if (!model) continue
        const fields = []
        let end = index + 1
        while (end < lines.length && !/^\s*\}/.test(lines[end])) {
          const field = lines[end].match(/^\s*([A-Za-z_]\w*)\s+([A-Za-z_]\w*)(\?|\[\])?(?=\s|@|$)/)
          if (field && !['@@id', '@@unique', '@@index', '@@map'].includes(field[1])) {
            fields.push({ name: field[1], type: field[2], line: end + 1 })
            if (modelNames.has(field[2])) relationships.push({ from: model[1], to: field[2], label: field[1], kind: 'Prisma relation', cardinality: field[3] === '[]' ? 'many' : 'one', status: 'inferred', file: path, line: end + 1, evidence: `Field type ${field[2]} references a Prisma model; cardinality is not fully determined by this declaration alone.` })
          }
          end += 1
        }
        entities.push({ name: model[1], fields, file: path, line: index + 1, kind: 'Prisma model' })
      }
    }
    if (/\.sql$/i.test(path)) {
      const lines = source.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const table = lines[index].match(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([\w.]+)[`"\]]?/i)
        if (!table) continue
        const name = table[1].split('.').pop()
        const fields = []
        let end = index + 1
        for (; end < lines.length && !/^\s*\);?\s*$/.test(lines[end]); end += 1) {
          const column = lines[end].match(/^\s*[`"[]?([A-Za-z_]\w*)[`"\]]?\s+([A-Za-z_]\w*)/)
          if (column && !/^(?:PRIMARY|FOREIGN|UNIQUE|CONSTRAINT|CHECK|KEY)$/i.test(column[1])) fields.push({ name: column[1], type: column[2], line: end + 1 })
          const foreign = lines[end].match(/\bREFERENCES\s+[`"[]?([\w.]+)[`"\]]?/i)
          if (foreign) relationships.push({ from: name, to: foreign[1].split('.').pop(), label: 'foreign key', kind: 'SQL foreign key', status: 'confirmed', file: path, line: end + 1, evidence: `SQL REFERENCES clause targets ${foreign[1]}.` })
        }
        entities.push({ name, fields, file: path, line: index + 1, kind: 'SQL table' })
      }
    }
  }
  const known = new Set(entities.map(entity => entity.name))
  const counts = new Map()
  for (const entity of entities) counts.set(entity.name, (counts.get(entity.name) || 0) + 1)
  const qualifiedEntities = entities.map(entity => ({ ...entity, displayName: counts.get(entity.name) > 1 ? `${entity.name} · ${entity.file.split('/').slice(-2, -1)[0] || entity.file}` : entity.name }))
  return { entities: qualifiedEntities, relationships: relationships.filter(relation => known.has(relation.from) && known.has(relation.to)), providers }
}

function findExternalRequests(files) {
  const requests = []
  const pattern = /\b(?:fetch|axios\.(?:get|post|put|patch|delete)|requests\.(?:get|post|put|patch|delete)|httpx\.(?:get|post|put|patch|delete))\s*\(\s*(['"`])(https?:\/\/[^'"`]+)\1/gi
  for (const [path, source] of Object.entries(files)) {
    let match
    while ((match = pattern.exec(source))) {
      try {
        const url = new URL(match[2])
        if (/^(?:localhost|127\.0\.0\.1)$/i.test(url.hostname) || /(?:^|\.)github\.com$/i.test(url.hostname)) continue
        const backendSource = /\.py$/i.test(path) || /(^|\/)(?:backend|server|api)\//i.test(path)
        requests.push({ host: url.host, url: `${url.origin}${url.pathname}`, file: path, line: lineAt(source, match.index), method: match[0].slice(0, match[0].indexOf('(')).toUpperCase(), sourceId: backendSource ? 'backend' : 'frontend', status: 'confirmed', evidence: `Direct ${match[0].slice(0, match[0].indexOf('('))} call uses a literal HTTPS URL.` })
      } catch { /* Invalid URL literals are not architecture evidence. */ }
    }
  }
  return requests
}

function extractPyprojectDependencies(source = '') {
  const names = new Set()
  const projectDependencies = source.match(/^\s*dependencies\s*=\s*\[([\s\S]*?)^\s*\]/m)?.[1] || ''
  for (const match of projectDependencies.matchAll(/['"]([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?\s*(?:[<>=!~;][^'"]*)?['"]/g)) names.add(match[1])
  let poetryDependencies = false
  for (const line of source.split('\n')) {
    const section = line.match(/^\s*\[([^\]]+)\]/)?.[1] || ''
    if (section) poetryDependencies = /^tool\.poetry\.(?:dependencies|group\.[^.]+\.dependencies)$/.test(section)
    if (!poetryDependencies || !line.includes('=')) continue
    const name = line.match(/^\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*=/)?.[1]
    if (name && name.toLowerCase() !== 'python') names.add(name)
  }
  return [...names]
}

export function analyzeRepository({ repository, entries = [], files = {}, manifests = {} }) {
  const findings = []; const routes = parseDjangoRoutes(files); const requests = extractFrontendEndpoints(files)
  const databaseSchema = extractDatabaseSchema(files)
  const externalApis = findExternalRequests(files)
  const eligibleSourceFiles = collectRepositorySourcePaths(entries, 49).length
  for (const request of requests) {
    const route = routes.routes.find(item => routesMatch(request.path, item.path))
    if (!route) {
      addFinding(findings, {
        title: routes.complete ? 'Frontend endpoint is not registered in Django' : 'Frontend endpoint has no statically matched Django route', severity: routes.complete ? 'high' : 'medium', category: 'Integration', status: routes.complete ? 'confirmed' : 'potential', confidence: routes.complete ? 'high' : 'medium',
        file: request.sourcePath, line: request.line,
        evidence: [{ file: request.sourcePath, line: request.line, text: `${request.method} ${request.path}` }, ...(routes.root ? [{ file: routes.root, line: 1, text: routes.complete ? 'Inspected root URL configuration and statically resolvable includes; no matching route was found.' : 'Some Django URL patterns or router includes could not be resolved statically.' }] : [])],
        impact: routes.complete ? 'Requests to this path are likely to receive HTTP 404 from the fully inspected static Django URL configuration.' : 'The static checker could not match this request; dynamic routers or URL patterns may provide it.',
        recommendation: 'Add the Django URL and view for this request, or update the frontend request path to an existing route.',
        verification: 'Call the endpoint using its intended method against the configured Django server and confirm it returns the expected response.',
        method: request.method, endpoint: request.path,
      })
      continue
    }
    const compatibility = methodCompatibility(request.method, route)
    if (compatibility === 'mismatch') addFinding(findings, {
      title: 'Frontend HTTP method is not supported by the matched Django view', severity: 'high', category: 'Integration', status: 'confirmed',
      file: request.sourcePath, line: request.line,
      evidence: [{ file: request.sourcePath, line: request.line, text: `${request.method} ${request.path}` }, { file: route.sourcePath, line: route.line, text: `${route.path} → ${route.view || 'view'}` }, { file: route.viewSource, line: routes.classes?.[route.view]?.line || 1, text: `View methods: ${route.methods.join(', ')}` }],
      impact: `The matched Django view exposes ${route.methods.join(', ')}, so ${request.method} requests are not handled by the inspected view.`,
      recommendation: 'Use a supported HTTP method or add the required method handler to the Django view.',
      verification: `Send a ${request.method} request to ${route.path} and confirm the intended view handles it.`, method: request.method, endpoint: request.path,
    })
  }
  const filePaths = new Set(entries.map(entry => entry.path))
  const packageJson = manifests.packageJson || {}
  const packagePath = Object.keys(files).find(path => /(^|\/)package\.json$/i.test(path)) || 'package.json'
  const pyprojectPath = Object.keys(files).find(path => /(^|\/)pyproject\.toml$/i.test(path)) || 'pyproject.toml'
  const pyprojectDependencies = extractPyprojectDependencies(manifests.pyproject || files[pyprojectPath] || '')
  const scripts = packageJson.scripts || {}
  const testFiles = Object.keys(files).filter(path => /(^|\/)([^/]+\.(test|spec)\.[cm]?[jt]sx?|tests?\.py)$|(^|\/)tests?\/.*\.py$/i.test(path))
  const configFiles = [...filePaths].filter(path => /(^|\/)(vite\.config\.[^/]+|vitest\.config\.[^/]+|jest\.config\.[^/]+|pytest\.ini|tox\.ini|pyproject\.toml|setup\.cfg|pytest\.toml)$/i.test(path))
  const apiServiceFiles = Object.keys(files).filter(path => /(^|\/)(services?|api)\/.*\.[jt]sx?$/i.test(path) && /apiRequest\s*\(/.test(files[path]))
  const envReferences = new Map()
  for (const [path, source] of Object.entries(files)) {
    const patterns = [/import\.meta\.env\.([A-Z][A-Z0-9_]*)/g, /process\.env\.([A-Z][A-Z0-9_]*)/g, /os\.getenv\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g, /os\.environ(?:\.get)?\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g]
    for (const pattern of patterns) { let match; while ((match = pattern.exec(source))) { const name = match[1]; const items = envReferences.get(name) || []; items.push({ file: path, line: lineAt(source, match.index) }); envReferences.set(name, items) } }
  }
  const documentedEnv = new Set(Object.keys(files).filter(path => /(^|\/)(\.env\.example|\.env\.sample|\.env\.template)$/i.test(path)).flatMap(path => (files[path] || '').split('\n').map(line => line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/)?.[1]).filter(Boolean)))
  for (const [name, refs] of envReferences) {
    if (documentedEnv.has(name) || name === 'DJANGO_SETTINGS_MODULE') continue
    addFinding(findings, { title: `Environment variable ${name} is not documented in an example file`, severity: 'medium', category: 'Configuration', file: refs[0].file, line: refs[0].line, evidence: refs.slice(0, 3).map(ref => ({ file: ref.file, line: ref.line, text: `${name} is read from the environment (value not inspected).` })), impact: 'Deployments may not know this setting is required or what value format it expects.', recommendation: `Document the name ${name} and a safe placeholder in an example environment file. Do not include secret values.`, verification: 'Compare the example environment template with the variables read by application code.' })
  }
  const apiBase = Object.entries(files).map(([path, source]) => ({ path, source })).find(item => /apiClient\.[jt]s$/.test(item.path))
  const corsSource = Object.entries(files).find(([path]) => /(^|\/)settings\.py$/.test(path))
  const corsDeclaration = corsSource?.[1].match(/CORS_ALLOWED_ORIGINS\s*=\s*\[([\s\S]*?)\]/)
  const cors = corsDeclaration?.[1] || ''
  const corsOrigins = [...cors.matchAll(/['"](https?:\/\/[^'"]+)['"]/g)].map(match => match[1].replace(/\/$/, ''))
  const corsStaticallyKnown = Boolean(corsDeclaration) && !/\b(?:os\.getenv|environ|settings\.)/.test(cors)
  const baseUrl = apiBase?.source.match(/VITE_API_BASE_URL\s*\|\|\s*['"](https?:\/\/[^'"]+)/)?.[1]
  const viteSource = Object.entries(files).find(([path]) => /(^|\/)vite\.config\.[jt]s$/i.test(path))
  const viteHost = viteSource?.[1].match(/host\s*:\s*['"]([^'"]+)['"]/)?.[1]
  const vitePort = viteSource?.[1].match(/port\s*:\s*(\d+)/)?.[1] || '5173'
  const viteOrigin = viteHost ? `http://${viteHost === '0.0.0.0' ? 'localhost' : viteHost}:${vitePort}` : null
  if (viteOrigin && corsSource && corsStaticallyKnown && !/CORS_ALLOW_ALL_ORIGINS\s*=\s*True/.test(corsSource[1]) && !corsOrigins.includes(viteOrigin)) {
    addFinding(findings, { title: 'Vite development origin is not listed in Django CORS origins', severity: 'medium', category: 'Configuration', file: corsSource[0], line: lineAt(corsSource[1], corsSource[1].indexOf('CORS_ALLOWED_ORIGINS')), evidence: [{ file: viteSource[0], line: lineAt(viteSource[1], viteSource[1].indexOf('host:')), text: `Vite origin from configured host and port: ${viteOrigin}` }, { file: corsSource[0], line: lineAt(corsSource[1], corsSource[1].indexOf('CORS_ALLOWED_ORIGINS')), text: `Allowed origins: ${corsOrigins.join(', ') || '(no literal origins found)'}` }], impact: 'Browser requests from the configured local frontend origin may be blocked by Django CORS policy.', recommendation: `Add ${viteOrigin} to Django's allowed development origins if this frontend origin is intended.`, verification: 'Load the frontend at the configured origin and inspect a Django response for the expected Access-Control-Allow-Origin header.' })
  }
  const allowedHosts = corsSource?.[1].match(/ALLOWED_HOSTS\s*=\s*\[([^\]]*)\]/)?.[1]
  let allowedHostValues = [...(allowedHosts || '').matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1])
  const allowedHostsDefault = corsSource?.[1].match(/os\.getenv\(\s*['"]DJANGO_ALLOWED_HOSTS['"]\s*,\s*['"]([^'"]*)['"]/)?.[1]
  if (allowedHostsDefault !== undefined) allowedHostValues = allowedHostsDefault.split(',').map(value => value.trim()).filter(Boolean)
  if (baseUrl && allowedHostValues.length && !allowedHostValues.includes(new URL(baseUrl).hostname)) {
    addFinding(findings, { title: 'API base host is not listed in Django ALLOWED_HOSTS', severity: 'high', category: 'Configuration', file: corsSource[0], line: lineAt(corsSource[1], corsSource[1].indexOf('ALLOWED_HOSTS')), evidence: [{ file: apiBase.path, line: lineAt(apiBase.source, apiBase.source.indexOf('VITE_API_BASE_URL')), text: `API client development fallback host: ${new URL(baseUrl).hostname}` }, { file: corsSource[0], line: lineAt(corsSource[1], corsSource[1].indexOf('ALLOWED_HOSTS')), text: `Configured hosts: ${allowedHostValues.join(', ')}` }], impact: 'Django may reject Host headers addressed to the configured API host.', recommendation: 'Add the API deployment hostname to DJANGO_ALLOWED_HOSTS for the matching environment.', verification: 'Make a request to Django using this Host header and confirm the request passes host validation.' })
  }
  if (baseUrl && apiBase && /127\.0\.0\.1|localhost/.test(new URL(baseUrl).hostname)) addFinding(findings, { title: 'API client fallback points to a local development server', severity: 'low', category: 'Configuration', status: 'potential', confidence: 'medium', file: apiBase.path, line: lineAt(apiBase.source, apiBase.source.indexOf('VITE_API_BASE_URL')), evidence: [{ file: apiBase.path, line: lineAt(apiBase.source, apiBase.source.indexOf('VITE_API_BASE_URL')), text: `Fallback API origin: ${new URL(baseUrl).origin}` }, ...(Object.keys(files).some(path => /(^|\/)\.env\.example$/i.test(path)) ? [{ file: Object.keys(files).find(path => /(^|\/)\.env\.example$/i.test(path)), line: 1, text: 'An example environment file is present; production build-time value is not available to this static check.' }] : [])], impact: 'A production build that does not override VITE_API_BASE_URL would send users to their own machine rather than the deployed API.', recommendation: 'Set VITE_API_BASE_URL to the reachable API origin in each deployment environment.', verification: 'Inspect the built frontend configuration and make a request from a deployed client.' })
  for (const request of requests) {
    const route = routes.routes.find(item => routesMatch(request.path, item.path))
    if (!route || !request.bodyFields.length) continue
    const view = routes.classes[route.view]
    const serializerName = view?.body.match(/\b([A-Z]\w*Serializer)\s*\([^)]*\bdata\s*=\s*(?:request\.data|payload)/s)?.[1]
    if (!serializerName) continue
    const serializer = Object.entries(files).map(([path, source]) => ({ path, source })).map(item => ({ ...item, match: item.source.match(new RegExp(`class\\s+${serializerName}\\s*\\([^)]*\\):([\\s\\S]*?)(?=\\nclass\\s|$)`)) })).find(item => item.match)
    if (!serializer) continue
    const serializerBody = serializer.match[1]
    const fields = [...serializerBody.matchAll(/^\s{4}([a-z_]\w*)\s*=\s*serializers\./gm)].map(item => item[1])
    const modelFields = serializerBody.match(/fields\s*=\s*\[([^\]]*)\]/)?.[1]
    if (modelFields) fields.push(...[...modelFields.matchAll(/['"]([a-z_]\w*)['"]/g)].map(item => item[1]))
    const ignored = [...view.body.matchAll(/payload\.pop\(\s*['"]([a-z_]\w*)['"]/g)].map(item => item[1])
    const unexpected = request.bodyFields.filter(field => !fields.includes(field) && !ignored.includes(field))
    if (unexpected.length) addFinding(findings, { title: 'Frontend request includes fields outside the Django serializer contract', severity: 'medium', category: 'Integration', status: 'potential', confidence: 'medium', file: request.sourcePath, line: request.line, evidence: [{ file: request.sourcePath, line: request.line, text: `Request body fields: ${request.bodyFields.join(', ')}` }, { file: serializer.path, line: lineAt(serializer.source, serializer.source.indexOf(`class ${serializerName}`)), text: `Serializer fields: ${fields.join(', ') || '(none statically detected)'}` }, ...(ignored.length ? [{ file: route.viewSource, line: view.line, text: `View explicitly handles before serializer: ${ignored.join(', ')}` }] : [])], impact: `The frontend sends ${unexpected.join(', ')}, which is not declared on ${serializerName}; the view may ignore or reject these fields.`, recommendation: 'Confirm whether each extra field is intentionally handled in the view before serialization, or align the request and serializer.', verification: 'Submit the request through the API and inspect serializer validation and response behavior.' })
  }
  const entryPoints = [...filePaths].filter(path => /(^|\/)(manage\.py|main\.[jt]sx?|index\.[jt]sx?|App\.[jt]sx?|wsgi\.py|asgi\.py)$/i.test(path))
  const dependencies = [...Object.keys(packageJson.dependencies || {}), ...Object.keys(packageJson.devDependencies || {})].sort()
  const testCommands = Object.entries(scripts).filter(([name]) => /^(test|test:.*|lint|typecheck|check|build)$/.test(name)).map(([name, command]) => ({ name, command: `npm run ${name}`, script: command, status: 'not_run' }))
  const pyproject = Object.keys(files).filter(path => /(^|\/)pyproject\.toml$/i.test(path))
  const verification = [
    ...testCommands,
    ...(Object.keys(files).some(path => /(^|\/)manage\.py$/i.test(path)) && testFiles.some(path => /\.py$/i.test(path)) ? [{ name: 'Django tests', command: 'python manage.py test', status: 'not_run', reason: 'Django test files are present; execution requires an isolated runner for connected repository code.' }] : []),
    ...(!testCommands.some(item => item.name === 'test') && testFiles.some(path => /\.[cm]?[jt]sx?$/i.test(path)) ? [{ name: 'Frontend tests', command: 'Unsupported: no test script declared', status: 'unsupported', reason: 'Frontend test files exist, but package.json does not declare a test command.' }] : []),
    ...(Object.keys(files).some(path => /(^|\/)manage\.py$/i.test(path)) ? [{ name: 'Django system check', command: 'python manage.py check', status: 'not_run', reason: 'Not run on the connected repository; untrusted source code is not executed by the web app.' }] : []),
    ...(pyproject.length ? [{ name: 'Python project configuration', command: 'Inspect pyproject.toml', status: 'unsupported', reason: 'Configuration presence is reported; dependency installation and runtime tests require an isolated runner.' }] : []),
  ]
  const backendDetected = Object.keys(files).some(path => /(^|\/)manage\.py$/i.test(path))
  const frontendDetected = Boolean(packageJson.name || [...filePaths].some(path => /(^|\/)(vite\.config\.[^/]+|src\/main\.[jt]sx?)$/i.test(path)))
  const classes = pythonClassInfo(files)
  const resolvedRoutes = routes.routes.map(route => ({ ...route, methods: route.methods.length ? route.methods : ['unknown'] }))
  const matchedRequests = requests.filter(request => routes.routes.some(route => routesMatch(request.path, route.path)))
  const connections = []
  if (frontendDetected && backendDetected && matchedRequests.length) connections.push({ from: 'Frontend', to: 'Django API', label: `${matchedRequests.length} statically matched API route(s)`, status: 'confirmed', evidence: matchedRequests.slice(0, 8).map(request => ({ file: request.sourcePath, line: request.line, text: `${request.method} ${request.path}` })) })
  const settingsEntry = Object.entries(files).find(([path, source]) => /(^|\/)settings\.py$/i.test(path) && /DATABASES\s*=/.test(source))
  const djangoModelEntry = Object.entries(files).find(([path, source]) => /(^|\/)models\.py$/i.test(path) && /from django\.db import models|import django\.db/.test(source))
  const databaseEngines = [...new Set([...(settingsEntry?.[1] || '').matchAll(/['"]ENGINE['"]\s*:\s*['"]([^'"]+)['"]/g)].map(match => match[1].split('.').pop()).concat(databaseSchema.providers.map(provider => provider.name)))]
  if (backendDetected && (settingsEntry || databaseSchema.providers.length)) connections.push({ from: 'Django API', to: 'Database', label: databaseSchema.entities.length ? `${databaseSchema.entities.length} schema entity(ies); runtime connection unverified` : 'Database provider configured; runtime connection unverified', status: 'inferred', evidence: [...(settingsEntry ? [{ file: settingsEntry[0], line: lineAt(settingsEntry[1], settingsEntry[1].indexOf('DATABASES')), text: `Django DATABASES${databaseEngines.length ? ` configures ${databaseEngines.join(', ')}` : ' configuration is declared'}` }] : []), ...databaseSchema.providers.map(provider => ({ file: provider.file, line: provider.line, text: `Prisma datasource provider is ${provider.name}.` })), ...(djangoModelEntry ? [{ file: djangoModelEntry[0], line: lineAt(djangoModelEntry[1], djangoModelEntry[1].indexOf('class ')), text: 'Django model definitions are present.' }] : [])] })
  for (const integration of externalApis) connections.push({ from: integration.sourceId === 'backend' ? 'Django API' : 'Frontend', to: integration.host, label: integration.method, status: 'confirmed', evidence: [{ file: integration.file, line: integration.line, text: integration.evidence }] })
  const nodeSpecs = []
  if (frontendDetected) nodeSpecs.push({ id: 'frontend', name: 'Frontend', role: 'Browser application and user interface', technologies: dependencies.filter(name => /react|vue|angular|svelte|vite|next|webpack|tailwind/i.test(name)).slice(0, 10), files: entryPoints.filter(path => /(?:frontend|client|web|src\/)/i.test(path) && /(?:main\.|index\.|app\.)/i.test(path)).slice(0, 8), status: 'confirmed', evidence: [Object.keys(files).find(path => /(^|\/)package\.json$/i.test(path)) || 'Repository package manifest'] })
  if (backendDetected) nodeSpecs.push({ id: 'backend', name: 'Django API', role: 'Server-side routes and request handlers', technologies: ['Django', ...(Object.keys(files).some(path => /requirements\.txt$/i.test(path) && /djangorestframework/i.test(files[path])) ? ['Django REST Framework'] : [])], files: [...new Set([routes.root, ...routes.routes.slice(0, 7).map(route => route.sourcePath), ...routes.routes.slice(0, 5).map(route => route.viewSource)].filter(Boolean))], status: 'confirmed', evidence: [Object.keys(files).find(path => /(^|\/)manage\.py$/i.test(path)) || 'manage.py'] })
  const hasDatabase = Boolean(settingsEntry || databaseSchema.entities.length || databaseSchema.providers.length)
  if (hasDatabase) nodeSpecs.push({ id: 'database', name: 'Database', role: databaseEngines.length ? `Configured engine: ${databaseEngines.join(', ')}` : `${databaseSchema.entities.length} schema object(s) detected; database engine not identified`, technologies: databaseEngines, files: [...new Set([settingsEntry?.[0], ...databaseSchema.providers.map(provider => provider.file), ...databaseSchema.entities.map(entity => entity.file)].filter(Boolean))], status: settingsEntry || databaseSchema.providers.length ? 'inferred' : 'unverified', evidence: [...(settingsEntry ? [{ file: settingsEntry[0], line: lineAt(settingsEntry[1], settingsEntry[1].indexOf('DATABASES')), text: `Django database configuration${databaseEngines.length ? ` uses ${databaseEngines.join(', ')}` : ' found'}.` }] : []), ...databaseSchema.providers.map(provider => ({ file: provider.file, line: provider.line, text: `Prisma datasource provider is ${provider.name}.` })), ...databaseSchema.entities.slice(0, 8).map(entity => ({ file: entity.file, line: entity.line, text: `${entity.kind}: ${entity.name}` }))] })
  const externalHosts = [...new Set(externalApis.map(item => item.host))]
  externalHosts.forEach((host, index) => { const calls = externalApis.filter(item => item.host === host); nodeSpecs.push({ id: `external_${index + 1}`, name: host, role: 'External HTTP API detected from direct source calls', technologies: ['HTTPS'], files: [...new Set(calls.map(item => item.file))], status: 'confirmed', evidence: calls.slice(0, 6).map(item => ({ file: item.file, line: item.line, text: item.evidence })) }) })
  const relationships = connections.map(edge => ({ ...edge, fromId: edge.from === 'Frontend' ? 'frontend' : edge.from === 'Django API' ? 'backend' : edge.from, toId: edge.to === 'Django API' ? 'backend' : edge.to === 'Database' ? 'database' : externalHosts.includes(edge.to) ? `external_${externalHosts.indexOf(edge.to) + 1}` : edge.to }))
  const stack = [
    ...dependencies.map(name => ({ name, group: /react|vue|angular|svelte|vite|next|webpack|tailwind|typescript/i.test(name) ? 'Frontend' : 'JavaScript dependencies', file: packagePath, status: 'confirmed', evidence: `Declared in ${packagePath}.` })),
    ...[...new Set((manifests.requirements || '').split('\n').map(line => line.trim().match(/^([A-Za-z0-9_.-]+)/)?.[1]).filter(Boolean))].map(name => ({ name, group: 'Python dependencies', file: Object.keys(files).find(path => /requirements\.txt$/i.test(path)) || 'requirements.txt', status: 'confirmed', evidence: 'Declared in requirements manifest.' })),
    ...pyprojectDependencies.map(name => ({ name, group: 'Python dependencies', file: pyprojectPath, status: 'confirmed', evidence: 'Declared in pyproject.toml.' })),
    ...[...new Set(databaseEngines)].map(name => ({ name, group: 'Database', file: settingsEntry?.[0] || databaseSchema.providers.find(provider => provider.name === name)?.file, status: 'confirmed', evidence: settingsEntry ? 'Declared in Django DATABASES configuration.' : 'Declared as a Prisma datasource provider.' })),
    ...(repository?.language ? [{ name: repository.language, group: 'Repository language metadata', file: null, status: 'inferred', evidence: 'Reported by GitHub repository metadata; this is not a dependency declaration.' }] : []),
  ]
  return {
    schemaVersion: 2, revision: repository?.revision || '', generatedAt: new Date().toISOString(), findings, scanCoverage: { inspectedFiles: Object.keys(files).length, limit: 48, limited: eligibleSourceFiles > 48 || Object.keys(files).length < eligibleSourceFiles },
    architecture: { frontend: frontendDetected, backend: backendDetected, components: nodeSpecs.map(node => ({ name: node.name, evidence: node.evidence.map(item => typeof item === 'string' ? item : `${item.file}:${item.line || 1}`).join(', ') })), nodes: nodeSpecs, relationships, databaseSchema, externalApis, technologies: stack, routes: resolvedRoutes, rootUrlConfig: routes.root, apiServiceFiles, connections, databaseEngine: [...new Set(databaseEngines)], databaseConfigured: Boolean(settingsEntry || databaseSchema.providers.length) },
    insights: { entryPoints, dependencies, scripts, packageFile: packagePath, testFiles, configFiles, endpointCount: requests.length, endpoints: requests.map(request => { const route = routes.routes.find(item => routesMatch(request.path, item.path)); return { ...request, route: route ? { ...route, methodStatus: methodCompatibility(request.method, route) } : null } }), environment: [...envReferences].map(([name, references]) => ({ name, references, documented: documentedEnv.has(name) })), corsOrigins, apiBase: baseUrl || null },
    verification, evidenceFiles: Object.keys(files),
  }
}

export function collectRepositorySourcePaths(entries, limit = 80) {
  const paths = entries.filter(entry => entry.type === 'blob').map(entry => entry.path)
  const priority = path => {
    const lower = path.toLowerCase()
    if (/(^|\/)package\.json$|(^|\/)\.env\.(example|sample|template)$|(^|\/)manage\.py$|(^|\/)pyproject\.toml$|(^|\/)requirements\.txt$/.test(lower)) return 0
    if (/(^|\/)(?:urls|settings|models)\.py$|(^|\/)apiClient\.[jt]s$|\.prisma$|\.sql$|(^|\/)(?:schema|schemas)\//i.test(path)) return 1
    if (/(^|\/)(services?|api)\/.*\.[jt]sx?$/.test(path)) return 2
    if (/(^|\/)(views?|serializers?|tests?)\.py$|(^|\/)tests?\/.*\.py$/.test(path)) return 3
    if (/(^|\/)(test|spec)\.[cm]?[jt]sx?$|\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return 4
    if (/(^|\/)vite\.config\.[jt]s$|(^|\/)README\.md$/i.test(path)) return 5
    return 20
  }
  return paths.filter(path => !/(^|\/)(node_modules|vendor|dist|build|\.git)\//i.test(path) && !/(^|\/)(\.env(?:\.(?!example$|sample$|template$)[^/]+)?|id_rsa|id_ed25519|credentials(?:\.json)?|secrets?\.ya?ml|.*\.(?:pem|key|p12|pfx|keystore))$/i.test(path))
    .filter(path => priority(path) < 20).sort((a, b) => priority(a) - priority(b) || a.localeCompare(b)).slice(0, limit)
}
