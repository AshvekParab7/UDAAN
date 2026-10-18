import { apiRequest } from './apiClient.js'

export const getProjects = () => apiRequest('/api/projects/')
