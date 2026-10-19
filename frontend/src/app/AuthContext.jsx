import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { getAuthStatus } from '../services/authService.js'

const AuthContext = createContext(null)
export function AuthProvider({ children }) {
  const [auth, setAuth] = useState({ loading: true, authenticated: false, github_configured: false, profile: null, user: null })
  const refresh = useCallback(async () => {
    try { setAuth({ ...await getAuthStatus(), loading: false }) }
    catch { setAuth(current => ({ ...current, loading: false })) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  const value = useMemo(() => ({ auth, refresh, setAuth }), [auth, refresh])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
