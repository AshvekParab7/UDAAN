export function buildStatusMeta(status) {
  switch (status) {
    case 'evidence_found':
      return { label: 'Evidence found', className: 'evidence_found' }
    case 'partially_implemented':
      return { label: 'Partially implemented', className: 'partially_implemented' }
    case 'mismatch_detected':
      return { label: 'Blocked / Mismatch', className: 'mismatch_detected' }
    case 'verified':
      return { label: 'Verified', className: 'verified' }
    case 'manual_review':
      return { label: 'Needs manual review', className: 'manual_review' }
    case 'not_assessed':
    default:
      return { label: 'Not assessed', className: 'not_assessed' }
  }
}

export function computeRoadmapProgress(allTasks = [], userCompleted = [], taskAssessments = {}) {
  const taskCount = allTasks.length
  if (!taskCount) {
    return {
      doneCount: 0,
      percent: 0,
      evidenceCount: 0,
      evidencePercent: 0,
      verifiedCount: 0,
      verifiedPercent: 0,
    }
  }

  const doneCount = allTasks.filter(t => userCompleted.includes(t.id)).length
  const percent = Math.round(doneCount / taskCount * 100)

  const evidenceCount = allTasks.filter(t => {
    const st = taskAssessments[t.id]?.status
    return st === 'evidence_found' || st === 'partially_implemented'
  }).length
  const evidencePercent = Math.round(evidenceCount / taskCount * 100)

  const verifiedCount = allTasks.filter(t => taskAssessments[t.id]?.status === 'verified').length
  const verifiedPercent = Math.round(verifiedCount / taskCount * 100)

  return {
    doneCount,
    percent,
    evidenceCount,
    evidencePercent,
    verifiedCount,
    verifiedPercent,
  }
}
