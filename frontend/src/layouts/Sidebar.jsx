import { AlertCircle, BookOpen, ChevronDown, Code2, FolderOpen, Gauge, LogOut, Megaphone, Rocket, ShieldCheck, UserRound, Users, X } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import './Sidebar.css'
import { Link } from 'react-router-dom'
import { useAuth } from '../app/AuthContext.jsx'
import { logoutAccount } from '../services/authService.js'

const navigation = [
  { label: 'Overview', icon: Gauge, to: '/' },
  { label: 'My Projects', icon: FolderOpen, to: '/projects' },
  { label: 'Flight Plan', icon: Rocket, to: '/flight-plan' },
  { label: 'Repository', icon: Code2, to: '/repository' },
  { label: 'Issues & Fixes', icon: AlertCircle, to: '/issues' },
  { label: 'Team Workspace', icon: Users, to: '/team' },
  { label: 'Learning', icon: BookOpen, to: '/learning' },
  { label: 'Verification & Readiness', icon: ShieldCheck, to: '/verification' },
  { label: 'Marketing Studio', icon: Megaphone, to: '/marketing-studio' },
  { label: 'Developer profile', icon: UserRound, to: '/profile' },
]

export default function Sidebar({ open = false, onClose = () => {} }) {
  const { auth, refresh } = useAuth()
  const displayName = auth.user?.name || 'Connect GitHub'
  const initials = displayName.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase()
  const avatarUrl = auth.profile?.avatar_url || ''
  const logout = async () => { try { await logoutAccount(); await refresh() } catch { /* Current API session will expire normally. */ } }
  return <>
    {open && <button className="ud-sidebar-backdrop" aria-label="Close navigation" onClick={onClose} />}
    <aside className={`ud-sidebar ${open ? 'is-open' : ''}`} aria-label="UDAAN workspace navigation">
      <div className="ud-sidebar-main">
        <div className="ud-sidebar-header">
          <NavLink className="ud-brand" to="/" onClick={onClose} aria-label="UDAAN home">
          <span className="ud-brand-mark"><Rocket size={18} /></span>
          <span className="ud-brand-name">UDAAN</span>
          </NavLink>
          <button className="ud-close-nav" aria-label="Close navigation" onClick={onClose}><X size={18} /></button>
        </div>
        <button className="ud-workspace" type="button" aria-label="Current workspace: My workspace">
          <span className="ud-workspace-avatar" aria-hidden="true">M</span>
          <span className="ud-workspace-copy"><span className="ud-workspace-top"><span>WORKSPACE</span><span className="ud-tier">Free plan</span></span>
            <span className="ud-workspace-bottom">My workspace</span></span>
          <ChevronDown className="ud-workspace-chevron" size={15} aria-hidden="true" />
        </button>
        <nav className="ud-nav" aria-label="Main navigation">
          {navigation.map(({ label, icon: Icon, to }) => <NavLink key={label} to={to} end={to === '/'} onClick={onClose}>
            <Icon size={17} strokeWidth={1.8} /><span>{label}</span>
          </NavLink>)}
        </nav>
      </div>
      <div className="ud-profile">
        <div className="ud-avatar" aria-hidden="true">{avatarUrl ? <img src={avatarUrl} alt="" /> : (initials || 'U')}</div><div className="ud-profile-copy"><strong>{displayName}</strong><Link to="/profile" onClick={onClose}>{auth.authenticated ? 'Developer profile' : 'Sign in with GitHub'}</Link></div>
        {auth.authenticated && <button className="ud-icon-button" type="button" aria-label="Sign out" onClick={() => void logout()}><LogOut size={17} /></button>}
      </div>
    </aside>
  </>
}
