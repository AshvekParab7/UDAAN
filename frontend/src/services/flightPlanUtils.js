export function createStarterFlightPlan(projectName = 'your project') {
  return {
    summary: `A practical first roadmap for shaping, building, and validating ${projectName}. Adjust each step as you learn more.`,
    milestones: [
      {
        title: 'Define the first version',
        outcome: 'Agree on the first useful version and how you will know it works.',
        tasks: ['Choose the main user and problem to solve', 'Write down the essential first-version features', 'Set one clear success measure'],
      },
      {
        title: 'Validate the approach',
        outcome: 'Check the riskiest assumptions before committing to a full build.',
        tasks: ['List the assumptions that could change the direction', 'Review existing alternatives and constraints', 'Talk to potential users or test a simple concept'],
      },
      {
        title: 'Build the first working version',
        outcome: 'Deliver an end-to-end version of the core experience.',
        tasks: ['Sketch the main user flow', 'Build the smallest complete core flow', 'Test the flow and fix the most important issues'],
      },
      {
        title: 'Review and plan the next iteration',
        outcome: 'Use feedback and results to decide what to improve next.',
        tasks: ['Share the first version with target users', 'Collect feedback against the success measure', 'Prioritize the next improvements'],
      },
    ],
  }
}

export function hasActionableFlightPlan(plan) {
  return Array.isArray(plan?.milestones)
    && plan.milestones.length > 0
    && plan.milestones.some(milestone => Array.isArray(milestone.tasks) && milestone.tasks.some(task => (typeof task === 'string' && task.trim()) || (task && typeof task.title === 'string' && task.title.trim())))
}

export function formatDisplayDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (Number.isNaN(d.valueOf())) return dateStr
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function getDaysRemaining(deadlineStr) {
  if (!deadlineStr) return null
  const d = new Date(deadlineStr)
  if (Number.isNaN(d.valueOf())) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(d)
  target.setHours(0, 0, 0, 0)
  const diffTime = target - today
  const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24))
  return {
    days: diffDays,
    isOverdue: diffDays < 0,
    isDueToday: diffDays === 0,
    label:
      diffDays < 0
        ? `${Math.abs(diffDays)} day${Math.abs(diffDays) === 1 ? '' : 's'} overdue`
        : diffDays === 0
        ? 'Due today'
        : `${diffDays} day${diffDays === 1 ? '' : 's'} remaining`,
  }
}

export function getTimelineProgress(startDateStr, deadlineStr) {
  if (!startDateStr || !deadlineStr) return null
  const start = new Date(startDateStr).getTime()
  const end = new Date(deadlineStr).getTime()
  const now = Date.now()
  if (end <= start) return 100
  const elapsed = now - start
  const total = end - start
  const pct = Math.max(0, Math.min(100, Math.round((elapsed / total) * 100)))
  return pct
}

export function isTaskOverdue(task, isCompleted) {
  if (isCompleted) return false
  if (!task?.target_date) return false
  const target = new Date(task.target_date)
  if (Number.isNaN(target.valueOf())) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  target.setHours(0, 0, 0, 0)
  return target < today
}
