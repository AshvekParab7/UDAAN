import test from 'node:test'
import assert from 'node:assert/strict'
import { apiRequest, getCsrfToken, setCsrfToken } from './apiClient.js'

test('apiClient sets and includes X-CSRFToken on mutating requests', async () => {
  const originalFetch = globalThis.fetch
  setCsrfToken('test-csrf-token-123')
  assert.equal(getCsrfToken(), 'test-csrf-token-123')

  let capturedOptions = null
  globalThis.fetch = async (_url, options) => {
    capturedOptions = options
    return {
      ok: true,
      status: 200,
      headers: { get: name => name.toLowerCase() === 'x-csrftoken' ? 'refreshed-token-456' : null },
      json: async () => ({ status: 'ok' }),
    }
  }

  try {
    const res = await apiRequest('/api/projects/drafts/test-id/team-workspace/sync-roadmap/', {
      method: 'POST',
      body: JSON.stringify({ preview: true }),
    })
    assert.deepEqual(res, { status: 'ok' })
    assert.equal(capturedOptions.headers['X-CSRFToken'], 'test-csrf-token-123')
    assert.equal(capturedOptions.credentials, 'include')
    // Check that refreshed token from header was captured
    assert.equal(getCsrfToken(), 'refreshed-token-456')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('apiClient parses detail and message from error responses when error key is absent', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    headers: { get: () => null },
    json: async () => ({ detail: 'CSRF Failed: CSRF cookie not set.' }),
  })

  try {
    await assert.rejects(
      () => apiRequest('/api/test/', { method: 'POST' }),
      err => {
        assert.equal(err.status, 403)
        assert.equal(err.message, 'CSRF Failed: CSRF cookie not set.')
        return true
      }
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
