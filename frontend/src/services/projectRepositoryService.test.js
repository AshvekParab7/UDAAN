import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseRepositoryUrl,
  fetchRepositoryTree,
  syncAndAnalyzeRepository,
} from './projectRepositoryService.js'

test('parseRepositoryUrl accepts standard and short GitHub repository strings', () => {
  const parsed1 = parseRepositoryUrl('https://github.com/octocat/Hello-World')
  assert.equal(parsed1.owner, 'octocat')
  assert.equal(parsed1.name, 'Hello-World')

  const parsed2 = parseRepositoryUrl('octocat/Hello-World')
  assert.equal(parsed2.owner, 'octocat')
  assert.equal(parsed2.name, 'Hello-World')

  assert.throws(() => parseRepositoryUrl(''), /Enter a GitHub repository URL/)
  assert.throws(() => parseRepositoryUrl('https://gitlab.com/owner/repo'), /Only GitHub repositories/)
})

test('fetchRepositoryTree returns empty structure without throwing when GitHub returns HTTP 409 empty repo', async () => {
  const originalFetch = globalThis.fetch
  try {
    // Mock fetch returning HTTP 409 Conflict with "Git Repository is empty."
    globalThis.fetch = async () => ({
      status: 409,
      ok: false,
      json: async () => ({ message: 'Git Repository is empty.' }),
      headers: { get: () => null },
    })

    const result = await fetchRepositoryTree('dummy-owner', 'empty-repo', 'main')
    assert.equal(result.empty, true)
    assert.deepEqual(result.entries, [])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('syncAndAnalyzeRepository handles empty repository with HTTP 409 gracefully without throwing', async () => {
  const originalFetch = globalThis.fetch
  try {
    // Mock metadata returning 200, but tree endpoint returning 409
    globalThis.fetch = async (url) => {
      const urlStr = String(url)
      if (urlStr.includes('/git/trees/')) {
        return {
          status: 409,
          ok: false,
          json: async () => ({ message: 'Git Repository is empty.' }),
          headers: { get: () => null },
        }
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({
          name: 'empty-test-repo',
          full_name: 'test-org/empty-test-repo',
          html_url: 'https://github.com/test-org/empty-test-repo',
          default_branch: 'main',
          language: null,
          visibility: 'public',
          size: 0,
        }),
        headers: { get: () => null },
      }
    }

    const syncResult = await syncAndAnalyzeRepository('test-org', 'empty-test-repo')
    assert.equal(syncResult.repository.isEmpty, true)
    assert.deepEqual(syncResult.entries, [])
    assert.equal(syncResult.analysis.findings.length, 0)
    assert.equal(syncResult.analysis.evidenceFiles.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})
