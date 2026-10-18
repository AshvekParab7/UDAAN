import { apiRequest } from './apiClient.js'

export const listLearningProjects = () => apiRequest('/api/projects/')
export const getLearningProject = projectId => apiRequest(`/api/projects/drafts/${encodeURIComponent(projectId)}/`)
export const getLearningState = projectId => apiRequest(`/api/projects/drafts/${encodeURIComponent(projectId)}/learning/`)
export const saveLearningState = (projectId, state) => apiRequest(`/api/projects/drafts/${encodeURIComponent(projectId)}/learning/`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state),
})
export const getLearningRecommendations = (projectId, taskKey, resources, completedConcepts = []) => apiRequest(`/api/projects/drafts/${encodeURIComponent(projectId)}/learning/recommendations/`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_key: taskKey, resources, completed_concepts: completedConcepts }),
})
export const askLearningTutor = (projectId, payload) => apiRequest(`/api/projects/drafts/${encodeURIComponent(projectId)}/learning/tutor/`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
})
