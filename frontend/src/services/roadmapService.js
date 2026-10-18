import { apiRequest } from './apiClient.js'

export const getRoadmaps = () => apiRequest('/api/roadmaps/')
