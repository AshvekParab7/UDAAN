import test from 'node:test'
import assert from 'node:assert/strict'
import { getLearningState, saveLearningState, getLearningRecommendations, askLearningTutor, listLearningProjects } from './learningService.js'

test('learning service reads account project list and per-project persisted progress', async () => {
  const calls = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options })
    return { ok: true, status: 200, json: async () => ({ results: [], step_status: { step: 'completed' } }) }
  }
  try {
    await listLearningProjects()
    await getLearningState('draft-id')
    assert.match(calls[0].url, /\/api\/projects\/$/)
    assert.match(calls[1].url, /draft-id\/learning\/$/)
  } finally { globalThis.fetch = previousFetch }
})

test('learning service persists progress and sends only project context to AI endpoints', async () => {
  const calls = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options })
    return { ok: true, status: 200, json: async () => ({ steps: [], answer: {} }) }
  }
  try {
    await saveLearningState('draft-id', { step_status: { basics: 'in_progress' }, saved_resources: ['react-quickstart'], recently_viewed: [], task_feedback: {} })
    await getLearningRecommendations('draft-id', '0-1', [{ id: 'react-quickstart', title: 'Quick Start', topics: ['React'] }])
    await askLearningTutor('draft-id', { question: 'Explain state', level: 'beginner', task: { title: 'Build a page' } })
    assert.match(calls[0].url, /draft-id\/learning\/$/)
    assert.equal(calls[0].options.method, 'PUT')
    assert.equal(JSON.parse(calls[0].options.body).step_status.basics, 'in_progress')
    assert.match(calls[1].url, /learning\/recommendations\/$/)
    assert.equal(JSON.parse(calls[1].options.body).task_key, '0-1')
    assert.match(calls[2].url, /learning\/tutor\/$/)
    assert.equal(JSON.parse(calls[2].options.body).question, 'Explain state')
  } finally { globalThis.fetch = previousFetch }
})
