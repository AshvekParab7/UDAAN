import test from 'node:test'
import assert from 'node:assert/strict'
import { getAuthStatus, startGitHubLogin, updateDeveloperProfile } from './authService.js'

test('auth service uses session-backed API requests and starts a state-protected GitHub flow', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return { ok: true, status: 200, json: async () => url.includes('/github/start/') ? { authorization_url: 'https://github.com/login/oauth/authorize?state=example' } : { authenticated: false } }
  }
  try {
    const status = await getAuthStatus()
    assert.equal(status.authenticated, false)
    const destination = await startGitHubLogin({ returnTo: '/team/invite/token-123', projectIds: ['project-id'] })
    assert.match(destination, /^https:\/\/github\.com\/login\/oauth\/authorize/)
    assert.equal(calls[0].options.credentials, 'include')
    const query = new URL(calls[1].url).searchParams
    assert.equal(query.get('return_to'), '/team/invite/token-123')
    assert.equal(query.get('project_ids'), 'project-id')
  } finally { globalThis.fetch = originalFetch }
})

test('profile edits use PATCH and structured JSON without sending provider credentials', async () => {
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (_url, options) => { request = options; return { ok: true, status: 200, json: async () => ({ skills: ['React'] }) } }
  try {
    await updateDeveloperProfile({ skills: ['React'] })
    assert.equal(request.method, 'PATCH')
    assert.deepEqual(JSON.parse(request.body), { skills: ['React'] })
    assert.equal(request.credentials, 'include')
    assert.equal(Object.keys(request.headers).some(key => /authorization|github.*token/i.test(key)), false)
  } finally { globalThis.fetch = originalFetch }
})
