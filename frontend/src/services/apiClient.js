const API_BASE_URL = ((typeof import.meta !== 'undefined' && import.meta?.env?.VITE_API_BASE_URL) || 'http://127.0.0.1:8000').replace(/\/$/, '')

export async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`, {
    headers: { Accept: 'application/json', ...options.headers },
    ...options,
  })
  const body = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(body?.error || `API request failed (${response.status})`)
    error.status = response.status
    error.fields = body?.fields
    error.code = body?.code
    error.assigned_tasks = body?.assigned_tasks
    throw error
  }
  return body
}
