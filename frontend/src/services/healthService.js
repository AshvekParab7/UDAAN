import { apiRequest } from './apiClient.js'

const path = projectId => `/api/projects/drafts/${encodeURIComponent(projectId)}/health/`

export const getHealthScore   = projectId => apiRequest(path(projectId))
export const refreshHealthScore = projectId => apiRequest(path(projectId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
export const getHealthActions = projectId => apiRequest(`${path(projectId)}actions/`)
export const getHealthHistory = (projectId, limit = 10) => apiRequest(`${path(projectId)}history/?limit=${limit}`)
export const getPassport      = projectId => apiRequest(`${path(projectId)}passport/`)
export const updatePassport   = (projectId, data) => apiRequest(`${path(projectId)}passport/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
export const deletePassport   = projectId => apiRequest(`${path(projectId)}passport/`, { method: 'DELETE' })
export const getPublicPassport = publicId => apiRequest(`/api/passport/${encodeURIComponent(publicId)}/`)

export function statusLabel(band) {
  return { strong: 'Strong', on_track: 'On Track', at_risk: 'At Risk', needs_attention: 'Needs Attention' }[band] ?? 'Unknown'
}

/** Returns a semantic colour key: green | blue | amber | red | grey */
export function statusClass(band) {
  return { strong: 'green', on_track: 'blue', at_risk: 'amber', needs_attention: 'red' }[band] ?? 'grey'
}
