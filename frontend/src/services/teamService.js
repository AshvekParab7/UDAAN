import { apiRequest } from './apiClient.js'

export const getTeams = () => apiRequest('/api/teams/')

const workspacePath = projectId => `/api/projects/drafts/${encodeURIComponent(projectId)}/team-workspace/`
export const getTeamWorkspace = projectId => apiRequest(workspacePath(projectId))
export const initializeTeamWorkspace = projectId => apiRequest(workspacePath(projectId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
export const updateTeamSize = (projectId, team_size) => apiRequest(workspacePath(projectId), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ team_size }) })
export const updateTeamMember = (projectId, memberId, member) => apiRequest(`${workspacePath(projectId)}members/${memberId}/`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(member) })
export const removeTeamMember = (projectId, memberId) => apiRequest(`${workspacePath(projectId)}members/${memberId}/`, { method: 'DELETE' })
export const updateTeamTask = (projectId, taskId, task) => apiRequest(`${workspacePath(projectId)}tasks/${taskId}/`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(task) })
export const generateAllocationProposal = projectId => apiRequest(`${workspacePath(projectId)}allocation-proposals/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
export const approveAllocationProposal = (projectId, proposalId, assignments) => apiRequest(`${workspacePath(projectId)}allocation-proposals/${proposalId}/approve/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignments }) })
export const previewRoadmapSync = projectId => apiRequest(`${workspacePath(projectId)}sync-roadmap/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preview: true }) })
export const applyRoadmapSync = projectId => apiRequest(`${workspacePath(projectId)}sync-roadmap/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) })
export const createTeamInvitations = (projectId, invitees) => apiRequest(`${workspacePath(projectId)}invitations/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invitees }) })
export const manageTeamInvitation = (projectId, invitationId, action) => apiRequest(`${workspacePath(projectId)}invitations/${invitationId}/`, { method: action === 'cancel' ? 'DELETE' : 'POST', ...(action === 'cancel' ? {} : { headers: { 'Content-Type': 'application/json' }, body: '{}' }) })
const publicInvitationPath = token => `/api/team/invitations/${encodeURIComponent(token)}/`
export const getPublicTeamInvitation = token => apiRequest(publicInvitationPath(token))
export const respondToTeamInvitation = (token, decision) => apiRequest(publicInvitationPath(token), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }) })
