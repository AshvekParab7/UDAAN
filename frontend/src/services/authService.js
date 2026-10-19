import { apiRequest } from './apiClient.js'
import { readSavedProjects } from './projectStorage.js'

export const getAuthStatus = () => apiRequest('/api/auth/status/')
export const getDeveloperProfile = () => apiRequest('/api/profile/developer/')
export const updateDeveloperProfile = profile => apiRequest('/api/profile/developer/', {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile),
})
export const logoutAccount = () => apiRequest('/api/auth/logout/', { method: 'POST' })
export async function startGitHubLogin({ refresh = false, returnTo = '/profile', projectIds = [] } = {}) {
  const query = new URLSearchParams()
  if (refresh) query.set('refresh', '1')
  query.set('return_to', returnTo)
  const claimIds = projectIds.length ? projectIds : readSavedProjects().map(project => project.id)
  if (claimIds.length) query.set('project_ids', claimIds.slice(0, 50).join(','))
  const result = await apiRequest(`/api/auth/github/start/?${query}`)
  return result.authorization_url
}
