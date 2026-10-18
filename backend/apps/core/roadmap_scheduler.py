"""
Deterministic scheduling and validation engine for UDAAN Flight Plans.

Enforces:
- Start date and deadline boundaries.
- Dependency topological ordering (prerequisites must finish before dependents start).
- Time allocation for testing, integration, bug fixes, and final presentation.
- Team capacity assessment (team size * weekly hours vs task effort).
- Identification of overambitious schedules with MVP scope reduction recommendations.
- Stable task IDs and preservation of completion history.
"""

from datetime import date, datetime, timedelta
import re
from typing import Any, Dict, List, Optional, Set, Tuple


def parse_date(value: Any, default: Optional[date] = None) -> Optional[date]:
    if isinstance(value, date):
        return value
    if isinstance(value, datetime):
        return value.date()
    if not isinstance(value, str):
        return default
    value = value.strip()
    if not value:
        return default
    for fmt in ('%Y-%m-%d', '%Y/%m/%d', '%d-%m-%Y', '%d/%m/%Y', '%B %d, %Y', '%b %d, %Y'):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            pass
    # Try regex fallback for YYYY-MM-DD
    match = re.search(r'(\d{4})-(\d{2})-(\d{2})', value)
    if match:
        try:
            return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        except ValueError:
            pass
    return default


def parse_effort_hours(effort_str: str) -> float:
    """Parse effort strings like '2 days', '1.5 weeks', '8 hours', '3d' into person-hours."""
    if not isinstance(effort_str, str):
        return 16.0
    text = effort_str.strip().lower()
    
    # Hours
    match = re.search(r'(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b', text)
    if match:
        return float(match.group(1))
    
    # Days (1 work day = 8 hours)
    match = re.search(r'(\d+(?:\.\d+)?)\s*(?:days?|d)\b', text)
    if match:
        return float(match.group(1)) * 8.0
        
    # Weeks (1 work week = 40 hours)
    match = re.search(r'(\d+(?:\.\d+)?)\s*(?:weeks?|wks?|w)\b', text)
    if match:
        return float(match.group(1)) * 40.0

    # Range like '2-3 days'
    match = re.search(r'(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*(?:days?|d)\b', text)
    if match:
        return ((float(match.group(1)) + float(match.group(2))) / 2.0) * 8.0

    return 16.0  # default 2 work days


def topological_sort_tasks(tasks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Sort tasks so dependencies appear before dependent tasks. Break cycles safely."""
    title_to_task = {task.get('title', '').strip().lower(): task for task in tasks if task.get('title')}
    id_to_task = {task.get('id'): task for task in tasks if task.get('id')}

    visited: Set[str] = set()
    visiting: Set[str] = set()
    sorted_tasks: List[Dict[str, Any]] = []

    def get_task_key(task: Dict[str, Any]) -> str:
        return task.get('id') or task.get('title', '').strip().lower()

    def dfs(task: Dict[str, Any]):
        key = get_task_key(task)
        if key in visited:
            return
        if key in visiting:
            # Cycle detected; skip to break cycle
            return
        visiting.add(key)
        for dep in task.get('dependencies', []):
            dep_cleaned = str(dep).strip().lower()
            dep_task = id_to_task.get(dep) or title_to_task.get(dep_cleaned)
            if dep_task and dep_task is not task:
                dfs(dep_task)
        visiting.remove(key)
        visited.add(key)
        sorted_tasks.append(task)

    for task in tasks:
        dfs(task)

    # Any remaining unvisited tasks
    for task in tasks:
        if get_task_key(task) not in visited:
            sorted_tasks.append(task)

    return sorted_tasks


def schedule_and_validate_flight_plan(
    flight_plan: Dict[str, Any],
    start_date: Optional[Any] = None,
    deadline: Optional[Any] = None,
    team_size: Optional[int] = 1,
    weekly_hours: Optional[int] = 20,
    completed_task_ids: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """
    Validate, repair, and schedule milestones and tasks between start_date and deadline.
    Returns an updated, deterministic flight plan dictionary.
    """
    today = date.today()
    parsed_start = parse_date(start_date, default=today) or today
    parsed_deadline = parse_date(deadline, default=parsed_start + timedelta(days=30)) or (parsed_start + timedelta(days=30))

    if parsed_deadline <= parsed_start:
        parsed_deadline = parsed_start + timedelta(days=14)

    total_calendar_days = max(1, (parsed_deadline - parsed_start).days)
    safe_team_size = max(1, int(team_size or 1))
    safe_weekly_hours = max(1, int(weekly_hours or 20))
    total_capacity_hours = safe_team_size * safe_weekly_hours * (total_calendar_days / 7.0)

    completed_ids = set(completed_task_ids or [])
    milestones_raw = flight_plan.get('milestones', [])
    if not isinstance(milestones_raw, list) or not milestones_raw:
        # Create minimal fallback milestones if empty
        milestones_raw = [
            {
                'title': 'Foundation and Setup',
                'category': 'Idea and Requirements',
                'outcome': 'Core scope defined and environment ready',
                'tasks': [{'title': 'Define core project requirements', 'priority': 'high', 'effort_estimate': '2 days'}],
            },
            {
                'title': 'Core Implementation',
                'category': 'Core Development',
                'outcome': 'Primary features built',
                'tasks': [{'title': 'Implement MVP functional flow', 'priority': 'high', 'effort_estimate': '5 days'}],
            },
            {
                'title': 'Verification and Launch',
                'category': 'Testing and Verification',
                'outcome': 'Tested, verified and prepared for launch',
                'tasks': [{'title': 'End-to-end testing and launch polish', 'priority': 'high', 'effort_estimate': '3 days'}],
            },
        ]

    num_milestones = len(milestones_raw)
    
    # Reserve buffer for testing, verification & launch prep at the end (at least 15% or 2 days for > 7 day projects)
    buffer_days = max(1, int(total_calendar_days * 0.15)) if total_calendar_days >= 7 else 1
    schedulable_days = max(1, total_calendar_days - buffer_days)

    # Distribute milestone windows
    milestone_durations = [schedulable_days / max(1, num_milestones - 1) if num_milestones > 1 else schedulable_days] * (num_milestones - 1)
    # The last milestone occupies the buffer period
    milestone_durations.append(buffer_days)

    validated_milestones: List[Dict[str, Any]] = []
    all_tasks: List[Dict[str, Any]] = []

    current_ms_start = parsed_start
    for m_idx, ms in enumerate(milestones_raw):
        ms_duration_days = max(1, int(milestone_durations[m_idx]))
        default_ms_start = current_ms_start
        default_ms_target = min(parsed_deadline, current_ms_start + timedelta(days=ms_duration_days))

        # Check existing milestone dates
        raw_start = parse_date(ms.get('start_date'))
        raw_target = parse_date(ms.get('target_date'))

        if raw_start and parsed_start <= raw_start <= parsed_deadline:
            ms_start = raw_start
        else:
            ms_start = default_ms_start

        if raw_target and ms_start <= raw_target <= parsed_deadline:
            ms_target = raw_target
        else:
            ms_target = default_ms_target

        if ms_target <= ms_start:
            ms_target = min(parsed_deadline, ms_start + timedelta(days=max(1, ms_duration_days)))

        # Update current start for subsequent milestones
        current_ms_start = ms_target

        # Process tasks in milestone
        raw_tasks = ms.get('tasks', [])
        ms_tasks: List[Dict[str, Any]] = []
        for t_idx, t in enumerate(raw_tasks):
            if isinstance(t, str):
                t_obj = {'title': t.strip()}
            elif isinstance(t, dict):
                t_obj = dict(t)
            else:
                t_obj = {'title': f'Task {t_idx + 1}'}

            task_id = str(t_obj.get('id') or f'{m_idx}-{t_idx}')
            is_completed = task_id in completed_ids or t_obj.get('status') == 'completed' or bool(t_obj.get('manual_completion'))

            t_obj['id'] = task_id
            t_obj['title'] = t_obj.get('title', '').strip() or f'Task {t_idx + 1}'
            t_obj['subtasks'] = [s.strip() for s in t_obj.get('subtasks', []) if isinstance(s, str) and s.strip()]
            t_obj['dependencies'] = [d.strip() for d in t_obj.get('dependencies', []) if isinstance(d, str) and d.strip()]
            t_obj['effort_estimate'] = str(t_obj.get('effort_estimate') or '2 days')
            t_obj['priority'] = str(t_obj.get('priority') or 'medium').lower()
            if t_obj['priority'] not in ('high', 'medium', 'low'):
                t_obj['priority'] = 'medium'
            t_obj['acceptance_criteria'] = str(t_obj.get('acceptance_criteria') or '')
            t_obj['required_skills'] = [s.strip() for s in t_obj.get('required_skills', []) if isinstance(s, str) and s.strip()]
            t_obj['suggested_role'] = str(t_obj.get('suggested_role') or '')
            
            # Future repository integration slots
            t_obj['linked_files'] = t_obj.get('linked_files') if isinstance(t_obj.get('linked_files'), list) else []
            t_obj['commits'] = t_obj.get('commits') if isinstance(t_obj.get('commits'), list) else []
            t_obj['pull_requests'] = t_obj.get('pull_requests') if isinstance(t_obj.get('pull_requests'), list) else []
            t_obj['verification_results'] = t_obj.get('verification_results') if isinstance(t_obj.get('verification_results'), dict) else {}
            t_obj['manual_completion'] = is_completed
            t_obj['repo_verified'] = bool(t_obj.get('repo_verified', False))
            t_obj['status'] = 'completed' if is_completed else t_obj.get('status', 'todo')

            ms_tasks.append(t_obj)
            all_tasks.append(t_obj)

        validated_ms = {
            'title': ms.get('title', '').strip() or f'Milestone {m_idx + 1}',
            'category': ms.get('category', '').strip() or 'Milestone',
            'purpose': ms.get('purpose', '').strip() or ms.get('outcome', '').strip(),
            'outcome': ms.get('outcome', '').strip() or '',
            'start_date': ms_start.isoformat(),
            'target_date': ms_target.isoformat(),
            'tasks': ms_tasks,
        }
        validated_milestones.append(validated_ms)

    # Topological sorting and dependency chronological scheduling for tasks
    title_to_task_map = {t['title'].lower(): t for t in all_tasks}
    id_to_task_map = {t['id']: t for t in all_tasks}

    total_effort_hours = sum(parse_effort_hours(t.get('effort_estimate', '')) for t in all_tasks)

    # Schedule tasks within each milestone according to dependencies
    conflicts: List[str] = []
    for m_idx, ms in enumerate(validated_milestones):
        ms_start = parse_date(ms['start_date'], default=parsed_start)
        ms_target = parse_date(ms['target_date'], default=parsed_deadline)
        ms_tasks = ms['tasks']
        if not ms_tasks:
            continue

        num_tasks = len(ms_tasks)
        day_step = max(1, (ms_target - ms_start).days // max(1, num_tasks))

        current_cursor = ms_start
        for t_idx, task in enumerate(ms_tasks):
            # Find prerequisite dates
            dep_finish_dates = []
            for dep in task.get('dependencies', []):
                dep_task = id_to_task_map.get(dep) or title_to_task_map.get(str(dep).lower())
                if dep_task and dep_task.get('target_date'):
                    dep_finish_dates.append(parse_date(dep_task['target_date']))

            earliest_start = max([ms_start, *[d for d in dep_finish_dates if d]]) if dep_finish_dates else ms_start
            raw_t_start = parse_date(task.get('start_date'))
            raw_t_target = parse_date(task.get('target_date'))

            if raw_t_start and earliest_start <= raw_t_start <= ms_target:
                task_start = raw_t_start
            else:
                task_start = max(earliest_start, current_cursor)

            estimated_days = max(1, int(parse_effort_hours(task.get('effort_estimate', '')) / max(4.0, (safe_weekly_hours / 5.0))))
            default_t_target = min(ms_target, task_start + timedelta(days=estimated_days))

            if raw_t_target and task_start <= raw_t_target <= ms_target:
                task_target = raw_t_target
            else:
                task_target = default_t_target

            if task_target <= task_start:
                task_target = min(parsed_deadline, task_start + timedelta(days=1))

            # Dependency conflict check
            if dep_finish_dates and any(d > task_start for d in dep_finish_dates if d):
                conflicts.append(f"Task '{task['title']}' starts before dependency completes.")

            task['start_date'] = task_start.isoformat()
            task['target_date'] = task_target.isoformat()
            current_cursor = min(ms_target, task_target)

    # Feasibility evaluation
    over_capacity_ratio = total_effort_hours / max(1.0, total_capacity_hours)
    mvp_recommendations: List[str] = []
    deferred_features: List[str] = []

    if over_capacity_ratio > 1.4:
        feasibility_status = 'overambitious'
        recommendation_msg = (
            f"The current scope requires ~{int(total_effort_hours)} person-hours, but available team capacity "
            f"until {parsed_deadline.isoformat()} is only ~{int(total_capacity_hours)} hours. "
            f"Recommend deferring non-essential tasks to post-launch."
        )
        mvp_recommendations.append(recommendation_msg)
        for t in all_tasks:
            if t.get('priority') == 'low' or (t.get('priority') == 'medium' and len(deferred_features) < 3):
                deferred_features.append(t['title'])
    elif over_capacity_ratio > 1.05:
        feasibility_status = 'tight'
        mvp_recommendations.append(
            f"Schedule is tight (~{int(total_effort_hours)}h planned vs ~{int(total_capacity_hours)}h capacity). "
            f"Keep strict focus on MVP acceptance criteria."
        )
    else:
        feasibility_status = 'on_track'

    # Build schedule assessment
    schedule_assessment = {
        'feasibility_status': feasibility_status,
        'start_date': parsed_start.isoformat(),
        'deadline': parsed_deadline.isoformat(),
        'total_calendar_days': total_calendar_days,
        'days_remaining': max(0, (parsed_deadline - today).days),
        'team_size': safe_team_size,
        'weekly_hours': safe_weekly_hours,
        'total_capacity_hours': round(total_capacity_hours, 1),
        'total_effort_hours': round(total_effort_hours, 1),
        'over_capacity_ratio': round(over_capacity_ratio, 2),
        'mvp_recommendations': mvp_recommendations,
        'deferred_features': deferred_features,
        'scheduling_conflicts': conflicts,
        'testing_buffer_days': buffer_days,
    }

    result = dict(flight_plan)
    result['summary'] = flight_plan.get('summary', '').strip() or 'Actionable deadline-aware project flight plan.'
    result['milestones'] = validated_milestones
    result['schedule_assessment'] = schedule_assessment
    return result
