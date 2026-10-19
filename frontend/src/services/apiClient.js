const API_BASE_URL = ((typeof import.meta !== 'undefined' && import.meta?.env?.VITE_API_BASE_URL) || (typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:8000')).replace(/\/$/, '')

let memoryCsrfToken = ''

export function getCsrfToken() {
  if (typeof document !== 'undefined') {
    const cookieToken = document.cookie.split('; ').find(val => val.startsWith('csrftoken='))?.split('=').slice(1).join('=')
    if (cookieToken) {
      const decoded = decodeURIComponent(cookieToken)
      memoryCsrfToken = decoded
      return decoded
    }
  }
  if (memoryCsrfToken) return memoryCsrfToken
  if (typeof sessionStorage !== 'undefined') {
    const stored = sessionStorage.getItem('udaan:csrftoken')
    if (stored) {
      memoryCsrfToken = stored
      return stored
    }
  }
  return ''
}

export function setCsrfToken(token) {
  if (token && typeof token === 'string') {
    memoryCsrfToken = token
    if (typeof sessionStorage !== 'undefined') {
      try { sessionStorage.setItem('udaan:csrftoken', token) } catch {}
    }
  }
}

export async function ensureCsrfToken() {
  let token = getCsrfToken()
  if (token) return token
  if (typeof fetch === 'undefined') return ''
  try {
    const res = await fetch(`${API_BASE_URL}/api/auth/csrf/`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    const headerToken = res.headers?.get?.('X-CSRFToken')
    if (headerToken) setCsrfToken(headerToken)
    const data = await res.json().catch(() => null)
    if (data?.csrf_token) setCsrfToken(data.csrf_token)
  } catch {}
  return getCsrfToken()
}

export async function apiRequest(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase()
  const isMutating = method !== 'GET' && method !== 'HEAD'
  let csrf = getCsrfToken()

  if (isMutating && !csrf && typeof document !== 'undefined') {
    csrf = await ensureCsrfToken()
  }

  const { headers: optHeaders, ...restOptions } = options
  const response = await fetch(`${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`, {
    credentials: 'include',
    ...restOptions,
    headers: {
      Accept: 'application/json',
      ...(isMutating && csrf ? { 'X-CSRFToken': csrf } : {}),
      ...optHeaders,
    },
  })

  const headerCsrf = response.headers?.get?.('X-CSRFToken')
  if (headerCsrf) setCsrfToken(headerCsrf)

  const body = response.status === 204 ? null : await response.json().catch(() => null)
  if (body?.csrf_token) setCsrfToken(body.csrf_token)

  if (!response.ok) {
    const message = body?.error || body?.detail || body?.message || `API request failed (${response.status})`
    const error = new Error(message)
    error.status = response.status
    error.fields = body?.fields
    error.code = body?.code
    error.assigned_tasks = body?.assigned_tasks
    throw error
  }
  return body
}
