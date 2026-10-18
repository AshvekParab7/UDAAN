import { apiRequest } from './apiClient.js'

export function analyzeIdeaDraft(draft) {
  return apiRequest('/api/ideas/analyze/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idea: draft.idea,
      project_type: draft.projectType,
      attachment_name: draft.attachment?.name ?? '',
      attachment_text: draft.attachment?.text ?? '',
      project_name: draft.projectName ?? '',
      problem_statement: draft.problemStatement ?? '',
      target_users: draft.targetUsers ?? '',
      expected_outcome: draft.expectedOutcome ?? '',
    }),
  })
}
