import { Routes, Route, Navigate } from 'react-router-dom'
import MainDashboard from '../pages/MainDashboard.jsx'
import MyProjects from '../pages/MyProjects.jsx'
import TeamWorkspace from '../pages/TeamWorkspace.jsx'
import TeamInvitationAccept from '../pages/TeamInvitationAccept.jsx'
import Repository from '../pages/Repository.jsx'
import IdeaAnalysis from '../pages/IdeaAnalysis.jsx'
import FlightPlan from '../pages/FlightPlan.jsx'
import ProjectSetup from '../pages/ProjectSetup.jsx'
import Learning from '../pages/Learning.jsx'
import MarketingStudio from '../pages/MarketingStudio.jsx'
import DeveloperProfile from '../pages/DeveloperProfile.jsx'

export default function App() {
  return <Routes>
    <Route path="/" element={<MainDashboard />} />
    <Route path="/login" element={<DeveloperProfile />} />
    <Route path="/profile" element={<DeveloperProfile />} />
    <Route path="/projects" element={<MyProjects />} />
    <Route path="/projects/new/setup" element={<ProjectSetup />} />
    <Route path="/projects/new/repository" element={<Navigate to="/projects/new/setup" replace />} />
    <Route path="/projects/new/analysis" element={<IdeaAnalysis />} />
    <Route path="/flight-plan" element={<FlightPlan />} />
    <Route path="/team" element={<TeamWorkspace />} />
    <Route path="/learning" element={<Learning />} />
    <Route path="/marketing-studio" element={<MarketingStudio />} />
    <Route path="/reports" element={<Navigate to="/marketing-studio" replace />} />
    <Route path="/team/invite/:token" element={<TeamInvitationAccept />} />
    <Route path="/repository" element={<Repository />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>
}
