import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './app/App.jsx'
import './styles/index.css'
import './pages/MainDashboard.css'
import './pages/MyProjects.css'
import './pages/TeamWorkspace.css'
import './pages/IdeaAnalysis.css'
import './pages/FlightPlan.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)

