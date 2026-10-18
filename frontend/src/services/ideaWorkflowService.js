import { apiRequest } from './apiClient.js'

export function generateIdeaStage({ stage, draft, projectDetails }) {
  const candidateId = draft.projectId || draft.id
  const projectId = typeof candidateId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidateId) ? candidateId : undefined
  return apiRequest('/api/ideas/workflow-stage/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage, idea: draft.idea, project_type: draft.projectType, project_id: projectId, project_details: projectDetails }),
  })
}

export function queueIdeaStageGeneration({ projectId, stage, retry = false, replaceEdited = false }) {
  return apiRequest(`/api/projects/drafts/${encodeURIComponent(projectId)}/stages/${stage}/generation/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ retry, replace_edited: replaceEdited }),
  })
}

export function getIdeaStageGeneration(projectId, stage) {
  return apiRequest(`/api/projects/drafts/${encodeURIComponent(projectId)}/stages/${stage}/generation/`)
}

const text = value => typeof value === 'string' && value.trim().length > 0
const strings = value => Array.isArray(value) && value.every(text)
const nonemptyStrings = value => strings(value) && value.length > 0
const invalid = stage => { throw new Error(`The ${stage} response was incomplete. Retry or complete the sections manually.`) }

export function validateResearchPlan(result) {
  const fields = ['commonly_available_features', 'gaps_opportunities', 'potential_users', 'research_questions', 'assumptions_to_verify', 'recommended_validation_actions', 'preliminary_hypotheses']
  if (!result || typeof result !== 'object' || !text(result.market_problem_context) || !text(result.existing_solutions_competitors) || !text(result.evidence_note)) invalid('research')
  if (!fields.every(key => nonemptyStrings(result[key])) || !Array.isArray(result.sources) || result.sources.length > 0) invalid('research')
  return result
}

export function validateFeasibility(result) {
  const scope = result?.mvp_scope
  if (!result || !text(result.summary) || !text(result.technical_feasibility) || !text(result.resources_and_effort) || !text(result.market_demand_note)
    || !nonemptyStrings(result.advantages) || !nonemptyStrings(result.limitations) || !nonemptyStrings(result.validation_checklist)
    || !scope || !nonemptyStrings(scope.essential_features) || !nonemptyStrings(scope.postpone) || !text(scope.scope_rationale)
    || !Array.isArray(result.risks_and_mitigations) || !result.risks_and_mitigations.length || !result.risks_and_mitigations.every(item => text(item.risk) && text(item.mitigation))) invalid('feasibility')
  return result
}

export function validateFlightPlan(result) {
  const taskValid = task => text(task.title) && strings(task.subtasks) && strings(task.dependencies) && text(task.effort_estimate) && ['high', 'medium', 'low'].includes(task.priority) && text(task.acceptance_criteria) && strings(task.required_skills) && text(task.suggested_role)
  if (!result || !text(result.summary) || !Array.isArray(result.milestones) || !result.milestones.length || !result.milestones.every(milestone => text(milestone.title) && text(milestone.category) && text(milestone.outcome) && Array.isArray(milestone.tasks) && milestone.tasks.length && milestone.tasks.every(taskValid))) invalid('flight plan')
  return result
}

export function replanProjectRoadmap(projectId, payload) {
  return apiRequest(`/api/projects/drafts/${encodeURIComponent(projectId)}/replan/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function saveProjectDraft(draft, understanding, workflow, currentStage, editedStages = []) {
  if (!draft?.projectId) return null
  return apiRequest(`/api/projects/drafts/${encodeURIComponent(draft.projectId)}/`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: draft.projectId,
      idea: draft.idea,
      project_type: draft.projectType,
      attachment: draft.attachment || null,
      understanding,
      workflow,
      current_stage: currentStage,
      start_date: draft.startDate || draft.start_date || null,
      deadline: draft.deadline || null,
      team_size: draft.teamSize || draft.team_size || 1,
      weekly_hours: draft.weeklyHours || draft.weekly_hours || 20,
      schedule_metadata: draft.scheduleMetadata || draft.schedule_metadata || {},
      edited_stages: editedStages,
    }),
  })
}

export function fetchProjectDraft(projectId) {
  return apiRequest(`/api/projects/drafts/${encodeURIComponent(projectId)}/`)
}
