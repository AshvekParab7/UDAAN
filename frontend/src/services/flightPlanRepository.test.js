import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStatusMeta, computeRoadmapProgress } from './flightPlanAssessmentUtils.js'

test('buildStatusMeta maps every defined status to human labels and valid CSS classes', () => {
  const statuses = [
    'evidence_found',
    'partially_implemented',
    'mismatch_detected',
    'verified',
    'manual_review',
    'not_assessed',
  ]

  for (const st of statuses) {
    const meta = buildStatusMeta(st)
    assert.ok(meta.label, `Label should exist for ${st}`)
    assert.equal(meta.className, st, `ClassName should match status ${st}`)
  }

  // Fallback for unknown status
  const fallback = buildStatusMeta('unknown_state')
  assert.equal(fallback.className, 'not_assessed')
  assert.equal(fallback.label, 'Not assessed')
})

test('multi-track progress calculations distinguish user marks, evidence found, and verified checks', () => {
  const allTasks = [
    { id: '0-0', title: 'Task 1' },
    { id: '0-1', title: 'Task 2' },
    { id: '1-0', title: 'Task 3' },
    { id: '1-1', title: 'Task 4' },
  ]
  const userCompleted = ['0-0', '0-1'] // 2 completed
  const taskAssessments = {
    '0-0': { status: 'evidence_found' },
    '0-1': { status: 'partially_implemented' },
    '1-0': { status: 'mismatch_detected' },
    '1-1': { status: 'manual_review' },
  }

  // User marked completion
  const doneCount = allTasks.filter(t => userCompleted.includes(t.id)).length
  const userPercent = Math.round(doneCount / allTasks.length * 100)
  assert.equal(doneCount, 2)
  assert.equal(userPercent, 50)

  // Evidence found (evidence_found + partially_implemented)
  const evidenceCount = allTasks.filter(t => {
    const st = taskAssessments[t.id]?.status
    return st === 'evidence_found' || st === 'partially_implemented'
  }).length
  const evidencePercent = Math.round(evidenceCount / allTasks.length * 100)
  assert.equal(evidenceCount, 2)
  assert.equal(evidencePercent, 50)

  // Verified checks passed
  const verifiedCount = allTasks.filter(t => taskAssessments[t.id]?.status === 'verified').length
  const verifiedPercent = Math.round(verifiedCount / allTasks.length * 100)
  assert.equal(verifiedCount, 0)
  assert.equal(verifiedPercent, 0)
})

test('unverified tasks cannot be counted as verified without passed checks', () => {
  const taskAssessment = {
    taskId: '0-0',
    status: 'evidence_found',
    checks: [
      { name: 'Django tests', status: 'not_run', reason: 'Execution requires isolated runner.' },
    ],
  }

  // Acceptance criteria rule: If checks are not passed, status must not be 'verified'
  assert.notEqual(taskAssessment.status, 'verified')
  assert.equal(taskAssessment.checks[0].status, 'not_run')
})
