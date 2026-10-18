const projectsKey = 'udaan:projects'

export function readSavedProjects() {
  try {
    const projects = JSON.parse(localStorage.getItem(projectsKey) || '[]')
    return Array.isArray(projects) ? projects : []
  } catch {
    return []
  }
}

export function saveIdeaProject({ draft, understanding, workflow }) {
  const projects = readSavedProjects()
  const id = draft.projectId || (globalThis.crypto?.randomUUID?.() ?? `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, char => { const random = Math.random() * 16 | 0; return (char === 'x' ? random : (random & 3 | 8)).toString(16) }))
  const project = {
    id, name: understanding.project_name.trim(),
    description: understanding.problem_statement.trim() || draft.idea,
    category: draft.projectType, status: 'planning', statusLabel: 'Planning',
    level: 'Level 1: Idea Shaped', xp: '0 / 1,200 XP', progress: 8,
    milestone: workflow.flight_plan?.milestones?.[0]?.title || 'Ready to begin',
    stack: [], team: ['TS'], updated: 'Created just now', tone: 'forest',
    idea: draft.idea, attachment: draft.attachment || null, understanding, workflow,
    startDate: draft.startDate || draft.start_date || new Date().toISOString().split('T')[0],
    deadline: draft.deadline || null,
    teamSize: draft.teamSize || draft.team_size || 1,
    weeklyHours: draft.weeklyHours || draft.weekly_hours || 20,
    scheduleMetadata: draft.scheduleMetadata || draft.schedule_metadata || workflow.flight_plan?.schedule_assessment || {},
    createdAt: new Date().toISOString(),
  }
  localStorage.setItem(projectsKey, JSON.stringify([project, ...projects.filter(item => item.id !== id)]))
  return project
}

export function updateSavedProject(projectId, update) {
  const projects = readSavedProjects()
  let updatedProject = null
  const nextProjects = projects.map(project => {
    if (project.id !== projectId) return project
    updatedProject = typeof update === 'function' ? update(project) : { ...project, ...update }
    return updatedProject
  })
  if (updatedProject) localStorage.setItem(projectsKey, JSON.stringify(nextProjects))
  return updatedProject
}
