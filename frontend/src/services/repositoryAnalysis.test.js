import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeRepository, collectRepositorySourcePaths } from './repositoryAnalysis.js'
import { buildArchitectureDiagram, validateArchitectureDiagram } from './architectureDiagrams.js'

test('reports a frontend path that is missing from included Django URL modules', () => {
  const files = {
    'frontend/src/services/projectService.js': "export const getProjects = () => apiRequest('/api/projects/')",
    'backend/config/urls.py': "urlpatterns = [path('api/', include('apps.core.urls'))]",
    'backend/apps/core/urls.py': "urlpatterns = [path('ideas/analyze/', IdeaAnalysisView.as_view())]",
    'backend/apps/core/idea_views.py': 'class IdeaAnalysisView(APIView):\n    def post(self, request):\n        pass',
    'backend/.env.example': 'DJANGO_SECRET_KEY=\n',
  }
  const result = analyzeRepository({ repository: { revision: 'abc' }, entries: Object.keys(files).map(path => ({ path, type: 'blob' })), files })
  const finding = result.findings.find(item => item.title === 'Frontend endpoint is not registered in Django')
  assert.ok(finding)
  assert.equal(finding.endpoint, '/api/projects/')
  assert.equal(finding.method, 'GET')
  assert.equal(finding.file, 'frontend/src/services/projectService.js')
  assert.equal(result.architecture.routes.length, 1)
  assert.equal(result.architecture.routes[0].path, '/api/ideas/analyze/')
})

test('matches supported methods and Django path converters', () => {
  const files = {
    'frontend/src/services/draftService.js': "apiRequest('/api/projects/drafts/123e4567-e89b-42d3-a456-426614174000/', { method: 'PUT', body: JSON.stringify({ idea }) })",
    'backend/config/urls.py': "urlpatterns = [path('api/', include('apps.core.urls'))]",
    'backend/apps/core/urls.py': "urlpatterns = [path('projects/drafts/<uuid:draft_id>/', ProjectDraftView.as_view())]",
    'backend/apps/core/views.py': 'class ProjectDraftView(APIView):\n    def get(self, request, draft_id):\n        pass\n    def put(self, request, draft_id):\n        pass',
  }
  const result = analyzeRepository({ repository: {}, entries: Object.keys(files).map(path => ({ path, type: 'blob' })), files })
  assert.equal(result.findings.length, 0)
  assert.equal(result.insights.endpoints[0].route.methods.includes('PUT'), true)
})

test('collects only relevant source files and excludes secret and generated paths', () => {
  const entries = [
    'frontend/package.json', 'frontend/src/services/api.js', 'backend/manage.py',
    'backend/config/urls.py', 'backend/.env', 'backend/.env.example',
    'frontend/node_modules/pkg/index.js', 'frontend/dist/bundle.js', 'README.md',
  ].map(path => ({ path, type: 'blob' }))
  const paths = collectRepositorySourcePaths(entries)
  assert.ok(paths.includes('frontend/package.json'))
  assert.ok(paths.includes('backend/config/urls.py'))
  assert.ok(paths.includes('backend/.env.example'))
  assert.ok(!paths.includes('backend/.env'))
  assert.ok(!paths.some(path => path.includes('node_modules') || path.includes('/dist/')))
})

test('builds architecture evidence from Django routes, models, database settings, and direct external calls', () => {
  const files = {
    'frontend/package.json': '{"name":"sample-ui","dependencies":{"react":"^19.0.0"}}',
    'frontend/src/main.jsx': 'createRoot(document.getElementById("root"))',
    'frontend/src/services/items.js': "apiRequest('/api/items/')",
    'frontend/src/services/maps.js': "fetch('https://maps.example.test/v1/tiles')",
    'backend/manage.py': 'from django.core.management import execute_from_command_line',
    'backend/config/urls.py': "urlpatterns = [path('api/', include('apps.items.urls'))]",
    'backend/apps/items/urls.py': "urlpatterns = [path('items/', ItemView.as_view())]",
    'backend/apps/items/views.py': 'class ItemView(APIView):\n    def get(self, request):\n        pass',
    'backend/apps/items/models.py': 'class Group(models.Model):\n    title = models.CharField(max_length=100)\n\nclass Item(models.Model):\n    group = models.ForeignKey(\n        Group,\n        on_delete=models.CASCADE,\n    )',
    'backend/config/settings.py': "DATABASES = {'default': {'ENGINE': 'django.db.backends.postgresql'}}",
  }
  const manifests = { packageJson: JSON.parse(files['frontend/package.json']), requirements: 'Django==5.0\ndjangorestframework==3.15' }
  const result = analyzeRepository({ repository: { revision: 'rev-1', language: 'Python' }, entries: Object.keys(files).map(path => ({ path, type: 'blob' })), files, manifests })
  const architecture = result.architecture
  assert.deepEqual(architecture.databaseSchema.entities.map(entity => entity.name), ['Group', 'Item'])
  assert.equal(architecture.databaseSchema.relationships[0].to, 'Group')
  assert.ok(architecture.relationships.some(edge => edge.fromId === 'frontend' && edge.toId === 'backend' && edge.status === 'confirmed'))
  assert.ok(architecture.relationships.some(edge => edge.fromId === 'backend' && edge.toId === 'database' && edge.status === 'inferred'))
  assert.equal(architecture.externalApis[0].host, 'maps.example.test')
  assert.ok(architecture.technologies.some(item => item.name === 'react'))
})

test('reports partial architecture without inventing relationships for unmatched requests', () => {
  const files = {
    'package.json': '{"name":"ui"}',
    'src/services/api.js': "apiRequest('/api/unregistered/')",
  }
  const result = analyzeRepository({ repository: {}, entries: Object.keys(files).map(path => ({ path, type: 'blob' })), files, manifests: { packageJson: JSON.parse(files['package.json']) } })
  assert.equal(result.architecture.nodes.some(node => node.id === 'frontend'), true)
  assert.equal(result.architecture.relationships.length, 0)
  assert.equal(result.insights.endpoints[0].route, null)
})

test('builds and validates Mermaid definitions from evidence for each diagram view', async () => {
  const analysis = {
    architecture: {
      nodes: [
        { id: 'frontend', name: 'Frontend', status: 'confirmed' },
        { id: 'backend', name: 'Django API', status: 'confirmed' },
        { id: 'database', name: 'Database', status: 'inferred' },
      ],
      relationships: [
        { fromId: 'frontend', toId: 'backend', label: '1 API route', status: 'confirmed' },
        { fromId: 'backend', toId: 'database', label: 'Configured; runtime unverified', status: 'inferred' },
      ],
      databaseSchema: { entities: [{ name: 'Book', file: 'models.py', line: 3, fields: [{ name: 'owner', type: 'ForeignKey', line: 4 }] }, { name: 'User', file: 'models.py', line: 1, fields: [] }], relationships: [{ from: 'Book', to: 'User', label: 'owner', kind: 'ForeignKey', status: 'confirmed' }] },
      externalApis: [{ host: 'maps.example.test', file: 'src/maps.js', line: 4 }],
    },
    insights: { endpoints: [{ method: 'GET', path: '/api/books/', sourcePath: 'src/books.js', line: 2, route: { view: 'BookView', sourcePath: 'urls.py', methodStatus: 'compatible' } }] },
  }
  for (const view of ['system', 'database', 'api']) {
    const definition = buildArchitectureDiagram(view, analysis)
    assert.equal(validateArchitectureDiagram(definition).valid, true)
    assert.match(definition, /^(?:flowchart LR|erDiagram)/)
  }
  assert.equal(validateArchitectureDiagram('flowchart LR\n click a "javascript:alert(1)"').valid, false)
})

test('keeps Mermaid labels readable and free of HTML entities', () => {
  const analysis = {
    architecture: {
      nodes: [
        { id: 'frontend', name: 'React (web) "client" | UI', status: 'confirmed' },
        { id: 'backend', name: 'Django: API [server]', status: 'confirmed' },
        { id: 'database', name: 'PostgreSQL {configured}', status: 'inferred' },
      ],
      relationships: [
        { fromId: 'frontend', toId: 'backend', label: '14 statically matched API route(s)', status: 'confirmed' },
        { fromId: 'backend', toId: 'database', label: '2 schema entity(ies); runtime connection unverified', status: 'inferred' },
      ],
      databaseSchema: {
        entities: [{ name: 'Trip (Booking)', file: 'backend/models.py', fields: [{ name: 'route[primary]', type: 'varchar(120) "quoted"', line: 3 }] }, { name: 'User', file: 'backend/models.py', fields: [] }],
        relationships: [{ from: 'Trip (Booking)', to: 'User', label: 'owner: ForeignKey (verified)', kind: 'ForeignKey', status: 'confirmed' }],
      },
      externalApis: [],
    },
    insights: { endpoints: [{ method: 'GET', path: '/api/trips/(active)/?q="a→b"', sourcePath: 'frontend/src/api/trips.js', line: 9, route: { view: 'TripView (list)', sourcePath: 'backend/urls.py', methodStatus: 'compatible' } }] },
  }

  const system = buildArchitectureDiagram('system', analysis)
  assert.match(system, /14 matched API routes — Static source match/)
  assert.match(system, /\["React \(web\) “client” \| UI"\]/)
  assert.match(system, /frontend -- "/)
  assert.match(system, /2 schema entities — Runtime unverified/)
  assert.doesNotMatch(system, /&#\d+;/)
  assert.equal(validateArchitectureDiagram(system).valid, true)

  const api = buildArchitectureDiagram('api', analysis)
  assert.match(api, /endpoint_0\["GET \/api\/trips\//)
  assert.match(api, /\(active\).*“a→b”/)
  assert.match(api, /frontend -- "Route and method match statically" --> endpoint_0/)
  assert.match(api, /view_0\["TripView \(list\)"\]/)
  assert.doesNotMatch(api, /&#\d+;/)
  assert.equal(validateArchitectureDiagram(api).valid, true)

  const database = buildArchitectureDiagram('database', analysis)
  assert.match(database, /Trip__Booking__0/)
  assert.match(database, /varchar_120_.*route_primary/)
  assert.match(database, /"owner: ForeignKey \(verified\)"/)
  assert.doesNotMatch(database, /&#\d+;/)
  assert.equal(validateArchitectureDiagram(database).valid, true)
})

test('builds screenshot-shaped evidence from a 14-file repository scan', () => {
  const files = {
    'frontend/package.json': '{"dependencies":{"react":"^19.0.0"}}',
    'frontend/src/main.jsx': 'createRoot(document.getElementById("root"))',
    'frontend/src/services/routes.js': "apiRequest('/api/trips/')",
    'backend/manage.py': 'from django.core.management import execute_from_command_line',
    'backend/config/urls.py': "urlpatterns = [path('', include('apps.core.urls'))]",
    'backend/apps/core/urls.py': "urlpatterns = [path('api/trips/', TripView.as_view())]",
    'backend/apps/core/views.py': 'class TripView(APIView):\n    def get(self, request):\n        pass',
    'backend/apps/core/models.py': 'class Trip(models.Model):\n    title = models.CharField(max_length=100)\n\nclass User(models.Model):\n    email = models.EmailField()\n\nclass Booking(models.Model):\n    trip = models.ForeignKey(Trip, on_delete=models.CASCADE)',
    'backend/apps/core/serializers.py': '',
    'backend/apps/core/tests.py': '',
    'backend/apps/core/admin.py': '',
    'backend/apps/core/apps.py': '',
    'backend/config/settings.py': "DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3'}}",
    'README.md': 'Repository analysis fixture',
  }
  const analysis = analyzeRepository({
    repository: { revision: '14-file-regression' },
    entries: Object.keys(files).map(path => ({ path, type: 'blob' })),
    files,
    manifests: { packageJson: JSON.parse(files['frontend/package.json']) },
  })
  assert.equal(analysis.scanCoverage.inspectedFiles, 14)
  assert.equal(analysis.insights.endpoints.length, 1)
  assert.equal(analysis.architecture.databaseSchema.entities.length, 3)
  const diagram = buildArchitectureDiagram('system', analysis)
  assert.match(diagram, /1 matched API route — Static source match/)
  assert.match(diagram, /3 schema entities — Runtime unverified/)
  assert.match(diagram, /frontend -- ".*" --> backend/)
  assert.equal(validateArchitectureDiagram(diagram).valid, true)
})

test('extracts Prisma models and SQL tables while keeping inferred Prisma relations distinct', () => {
  const files = {
    'db/schema.prisma': 'model Team {\n  id Int @id\n  members Member[]\n}\nmodel Member {\n  id Int @id\n  team Team @relation(fields: [teamId], references: [id])\n  teamId Int\n}',
    'db/legacy.sql': 'CREATE TABLE teams (\n  id INTEGER PRIMARY KEY,\n  name VARCHAR(80)\n);',
  }
  const result = analyzeRepository({ repository: {}, entries: Object.keys(files).map(path => ({ path, type: 'blob' })), files })
  const entities = result.architecture.databaseSchema.entities
  assert.deepEqual(entities.map(entity => entity.name), ['Team', 'Member', 'teams'])
  const relation = result.architecture.databaseSchema.relationships.find(item => item.kind === 'Prisma relation')
  assert.equal(relation.status, 'inferred')
  assert.equal(relation.cardinality, 'many')
  assert.equal(entities.find(entity => entity.name === 'teams').fields[0].type, 'INTEGER')
})

test('includes Python dependencies declared in pyproject.toml in the technology stack', () => {
  const source = '[project]\nname = "sample"\ndependencies = [\n  "fastapi>=0.110",\n  "sqlalchemy[asyncio]>=2",\n]\n'
  const result = analyzeRepository({ repository: {}, entries: [{ path: 'pyproject.toml', type: 'blob' }], files: { 'pyproject.toml': source }, manifests: { pyproject: source } })
  assert.ok(result.architecture.technologies.some(item => item.name === 'fastapi' && item.file === 'pyproject.toml'))
  assert.ok(result.architecture.technologies.some(item => item.name === 'sqlalchemy' && item.file === 'pyproject.toml'))
})
