import test from 'node:test'
import assert from 'node:assert/strict'
import { generateMarketingContent, listMarketingContent, saveMarketingContent } from './marketingService.js'

test('marketing service uses backend endpoints, workspace isolation header, and structured requests', async () => {
  const previousFetch = globalThis.fetch
  const previousStorage = globalThis.localStorage
  const values = new Map()
  globalThis.localStorage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) }
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options })
    return { ok: true, status: 200, json: async () => ({ result: { approach: 'Clear facts.', items: [] }, results: [] }) }
  }
  try {
    await generateMarketingContent({ mode: 'social', inputs: { topic: 'A student app' } })
    await listMarketingContent({ project: 'custom', type: 'social', q: 'campus' })
    await saveMarketingContent({ title: 'Draft', body: 'Editable copy', content_type: 'social' })
    assert.match(calls[0].url, /\/api\/marketing\/generate\/$/)
    assert.match(calls[1].url, /project=custom.*type=social.*q=campus/)
    assert.match(calls[2].url, /\/api\/marketing\/content\/$/)
    assert.match(calls[0].options.headers['X-Marketing-Workspace'], /^[0-9a-f-]{36}$/i)
    assert.equal(calls[0].options.headers['Content-Type'], 'application/json')
    assert.equal(values.get('udaan:marketing-workspace'), calls[0].options.headers['X-Marketing-Workspace'])
  } finally {
    globalThis.fetch = previousFetch
    if (previousStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previousStorage
  }
})
