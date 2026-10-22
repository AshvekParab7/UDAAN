"""
HealthScoreService — deterministic scoring from real project data only.
Never fabricates evidence. Missing data → lower score, confidence = 'low'.
"""
from __future__ import annotations

from typing import Any

from django.utils import timezone


# Weight of each signal as a fraction of 100
SIGNAL_WEIGHTS = {
    'idea_clarity':        0.10,
    'roadmap_coverage':    0.15,
    'team_alignment':      0.10,
    'repository_activity': 0.10,
    'code_to_plan_match':  0.25,
    'testing_stability':   0.20,
    'delivery_readiness':  0.10,
}

# Status bands
def _status_band(score: int) -> str:
    if score >= 80:
        return 'strong'
    if score >= 60:
        return 'on_track'
    if score >= 40:
        return 'at_risk'
    return 'needs_attention'


def _clamp(value: float, lo: float = 0.0, hi: float = 100.0) -> int:
    return int(max(lo, min(hi, round(value))))


class HealthScoreService:
    """Compute a Project Health Score from real Django model instances."""

    def __init__(self, project):
        """
        project — ProjectDraft instance, prefetch_related as needed.
        """
        self._project = project
        self._understanding = project.understanding or {}
        self._workflow = project.workflow or {}

        # Lazy-loaded related objects — set to None if missing
        try:
            self._repository = project.repository if hasattr(project, 'repository') else None
        except Exception:
            self._repository = None

        try:
            self._latest_assessment = project.roadmap_assessments.first()
        except Exception:
            self._latest_assessment = None

        try:
            self._tasks = list(project.team_tasks.filter(active=True))
        except Exception:
            self._tasks = []

        try:
            self._members = list(project.team_members.all())
        except Exception:
            self._members = []

        try:
            self._marketing_items = list(project.marketing_content.all())
        except Exception:
            self._marketing_items = []

    # ------------------------------------------------------------------
    # Signal 1 — Idea Clarity (10%)
    # ------------------------------------------------------------------
    def _score_idea_clarity(self) -> dict:
        fields = ['project_name', 'problem_statement', 'target_users', 'expected_outcome']
        filled = [f for f in fields if self._understanding.get(f, '').strip()]
        raw = len(filled) / len(fields) * 100
        return {
            'key': 'idea_clarity',
            'label': 'Idea Clarity',
            'weight': SIGNAL_WEIGHTS['idea_clarity'],
            'raw_score': _clamp(raw),
            'confidence': 'high' if len(filled) == len(fields) else ('medium' if filled else 'low'),
            'filled_fields': filled,
            'missing_fields': [f for f in fields if f not in filled],
            'explanation': (
                f'{len(filled)}/{len(fields)} understanding fields filled in.'
                if filled else 'No project understanding fields have been filled in yet.'
            ),
            'fix_link': '/projects/new/setup',
        }

    # ------------------------------------------------------------------
    # Signal 2 — Roadmap Coverage (15%)
    # ------------------------------------------------------------------
    def _score_roadmap_coverage(self) -> dict:
        flight_plan = self._workflow.get('flight_plan') or {}
        milestones = flight_plan.get('milestones') or []
        tasks_raw = []
        for milestone in milestones:
            for task in (milestone.get('tasks') or []):
                if isinstance(task, dict):
                    tasks_raw.append(task)
        milestone_score = min(len(milestones) / 3, 1.0) * 25  # up to 25pts for ≥3 milestones
        task_score = min(len(tasks_raw) / 6, 1.0) * 25        # up to 25pts for ≥6 tasks

        # Tasks with deadlines
        with_deadline = [t for t in tasks_raw if t.get('deadline') or t.get('due_date')]
        deadline_score = (len(with_deadline) / len(tasks_raw) * 25) if tasks_raw else 0

        # Tasks with effort estimates
        with_effort = [t for t in tasks_raw if t.get('effort_hours') or t.get('effort')]
        effort_score = (len(with_effort) / len(tasks_raw) * 25) if tasks_raw else 0

        raw = milestone_score + task_score + deadline_score + effort_score
        confidence = 'high' if milestones and len(tasks_raw) >= 4 else ('medium' if milestones else 'low')
        return {
            'key': 'roadmap_coverage',
            'label': 'Roadmap Coverage',
            'weight': SIGNAL_WEIGHTS['roadmap_coverage'],
            'raw_score': _clamp(raw),
            'confidence': confidence,
            'milestone_count': len(milestones),
            'task_count': len(tasks_raw),
            'tasks_with_deadline': len(with_deadline),
            'tasks_with_effort': len(with_effort),
            'explanation': (
                f'{len(milestones)} milestone(s), {len(tasks_raw)} task(s) in the flight plan.'
                if milestones else 'No flight plan has been generated yet.'
            ),
            'fix_link': '/flight-plan',
        }

    # ------------------------------------------------------------------
    # Signal 3 — Team Alignment (10%)
    # ------------------------------------------------------------------
    def _score_team_alignment(self) -> dict:
        member_count = len(self._members)
        task_count = len(self._tasks)
        assigned_tasks = [t for t in self._tasks if t.assigned_to_id is not None]
        joined_members = [m for m in self._members if m.user_id is not None]

        if member_count <= 1:
            # Solo project — alignment not applicable but give partial credit for being set up
            raw = 60.0 if member_count == 1 else 0.0
            confidence = 'medium' if member_count == 1 else 'low'
            explanation = 'Solo project — no team alignment required.' if member_count == 1 else 'No team members added yet.'
        else:
            assign_ratio = len(assigned_tasks) / task_count if task_count else 0.0
            join_ratio = len(joined_members) / member_count
            raw = (assign_ratio * 60 + join_ratio * 40)
            confidence = 'high' if assign_ratio > 0.7 and join_ratio >= 0.5 else ('medium' if assigned_tasks else 'low')
            explanation = (
                f'{len(assigned_tasks)}/{task_count} tasks assigned, '
                f'{len(joined_members)}/{member_count} members joined.'
            )
        return {
            'key': 'team_alignment',
            'label': 'Team Alignment',
            'weight': SIGNAL_WEIGHTS['team_alignment'],
            'raw_score': _clamp(raw),
            'confidence': confidence,
            'member_count': member_count,
            'joined_member_count': len(joined_members) if member_count > 1 else member_count,
            'assigned_task_count': len(assigned_tasks),
            'total_task_count': task_count,
            'explanation': explanation,
            'fix_link': '/team',
        }

    # ------------------------------------------------------------------
    # Signal 4 — Repository Activity (10%)
    # ------------------------------------------------------------------
    def _score_repository_activity(self) -> dict:
        repo = self._repository
        if repo is None:
            return {
                'key': 'repository_activity',
                'label': 'Repository Activity',
                'weight': SIGNAL_WEIGHTS['repository_activity'],
                'raw_score': 0,
                'confidence': 'low',
                'explanation': 'No repository connected.',
                'fix_link': '/repository',
            }

        pts = 0.0
        evidence = []

        # Has repo connected
        if repo.connection_status == 'connected':
            pts += 25
            evidence.append('Repository connected')

        # Technologies detected
        if repo.detected_technologies:
            pts += 25
            evidence.append(f'{len(repo.detected_technologies)} technology/technologies detected')

        # Has recent sync (within 30 days)
        if repo.last_synced_at:
            days_ago = (timezone.now() - repo.last_synced_at).days
            if days_ago <= 30:
                pts += 25
                evidence.append(f'Last synced {days_ago} day(s) ago')
            elif days_ago <= 90:
                pts += 10

        # Has latest analysis content (commit evidence)
        analysis = repo.latest_analysis or {}
        if analysis.get('evidenceFiles') or analysis.get('summary'):
            pts += 25
            evidence.append('Code analysis available')

        confidence = 'high' if pts >= 75 else ('medium' if pts >= 25 else 'low')
        return {
            'key': 'repository_activity',
            'label': 'Repository Activity',
            'weight': SIGNAL_WEIGHTS['repository_activity'],
            'raw_score': _clamp(pts),
            'confidence': confidence,
            'repo_full_name': repo.repo_full_name,
            'connection_status': repo.connection_status,
            'last_synced_at': repo.last_synced_at.isoformat() if repo.last_synced_at else None,
            'tech_count': len(repo.detected_technologies),
            'evidence': evidence,
            'explanation': ', '.join(evidence) if evidence else 'Repository connected but no analysis yet.',
            'fix_link': '/repository',
        }

    # ------------------------------------------------------------------
    # Signal 5 — Code-to-Plan Match (25%)
    # ------------------------------------------------------------------
    def _score_code_to_plan_match(self) -> dict:
        assessment = self._latest_assessment
        if assessment is None:
            return {
                'key': 'code_to_plan_match',
                'label': 'Code-to-Plan Match',
                'weight': SIGNAL_WEIGHTS['code_to_plan_match'],
                'raw_score': 0,
                'confidence': 'low',
                'explanation': 'No roadmap vs. repository comparison has been run yet.',
                'fix_link': '/repository',
            }

        summary = assessment.summary or {}
        task_assessments = assessment.task_assessments or {}
        total = len(task_assessments)

        if total == 0:
            return {
                'key': 'code_to_plan_match',
                'label': 'Code-to-Plan Match',
                'weight': SIGNAL_WEIGHTS['code_to_plan_match'],
                'raw_score': 0,
                'confidence': 'low',
                'explanation': 'Roadmap comparison ran but no tasks were assessed.',
                'fix_link': '/repository',
            }

        evidence_pct = summary.get('evidence_percentage', 0)
        verified_pct = summary.get('verified_percentage', 0)
        raw = evidence_pct * 0.6 + verified_pct * 0.4
        confidence = 'high' if verified_pct >= 30 else ('medium' if evidence_pct >= 20 else 'low')
        return {
            'key': 'code_to_plan_match',
            'label': 'Code-to-Plan Match',
            'weight': SIGNAL_WEIGHTS['code_to_plan_match'],
            'raw_score': _clamp(raw),
            'confidence': confidence,
            'total_tasks_assessed': total,
            'evidence_percentage': evidence_pct,
            'verified_percentage': verified_pct,
            'commit_sha': assessment.commit_sha[:8] if assessment.commit_sha else '',
            'explanation': (
                f'{evidence_pct}% of roadmap tasks have code evidence, {verified_pct}% verified.'
            ),
            'fix_link': '/repository',
        }

    # ------------------------------------------------------------------
    # Signal 6 — Testing & Stability (20%)
    # ------------------------------------------------------------------
    def _score_testing_stability(self) -> dict:
        assessment = self._latest_assessment
        if assessment is None:
            return {
                'key': 'testing_stability',
                'label': 'Testing & Stability',
                'weight': SIGNAL_WEIGHTS['testing_stability'],
                'raw_score': 0,
                'confidence': 'low',
                'explanation': 'No repository analysis available — test coverage unknown.',
                'fix_link': '/repository',
            }

        analysis = (self._repository.latest_analysis if self._repository else {}) or {}
        findings = analysis.get('findings') or []
        summary = analysis.get('summary') or {}

        pts = 0.0
        evidence = []

        # Penalise for critical/high findings (never claim stable without evidence)
        critical_count = sum(1 for f in findings if isinstance(f, dict) and f.get('severity', '').lower() in ('critical', 'high'))
        medium_count = sum(1 for f in findings if isinstance(f, dict) and f.get('severity', '').lower() == 'medium')

        if not findings:
            # No findings data — low confidence, partial score for having analysis
            if analysis:
                pts = 30
                evidence.append('Code analysis available but no test findings data')
        else:
            base = 80.0
            base -= critical_count * 20
            base -= medium_count * 8
            pts = max(0, base)
            evidence.append(f'{critical_count} critical, {medium_count} medium finding(s)')

        # Bonus for summary quality
        if summary.get('qualityScore') or summary.get('testCoverage'):
            pts = min(100, pts + 10)
            evidence.append('Quality metrics present')

        confidence = 'high' if findings else ('medium' if analysis else 'low')
        return {
            'key': 'testing_stability',
            'label': 'Testing & Stability',
            'weight': SIGNAL_WEIGHTS['testing_stability'],
            'raw_score': _clamp(pts),
            'confidence': confidence,
            'critical_findings': critical_count,
            'medium_findings': medium_count,
            'evidence': evidence,
            'explanation': (
                ', '.join(evidence) if evidence
                else 'No repository analysis run yet.'
            ),
            'fix_link': '/repository',
        }

    # ------------------------------------------------------------------
    # Signal 7 — Delivery Readiness (10%)
    # ------------------------------------------------------------------
    def _score_delivery_readiness(self) -> dict:
        pts = 0.0
        evidence = []

        # Deadline set
        if self._project.deadline:
            pts += 25
            evidence.append(f'Deadline: {self._project.deadline.isoformat()}')

        # MVP scope defined (description / expected_outcome)
        expected_outcome = self._understanding.get('expected_outcome', '').strip()
        if len(expected_outcome) > 30:
            pts += 25
            evidence.append('MVP outcome defined')

        # Marketing content exists
        if self._marketing_items:
            pts += 25
            evidence.append(f'{len(self._marketing_items)} marketing draft(s)')

        # Project description complete (problem_statement non-trivial)
        problem_statement = self._understanding.get('problem_statement', '').strip()
        if len(problem_statement) > 50:
            pts += 25
            evidence.append('Problem statement written')

        confidence = 'high' if pts >= 75 else ('medium' if pts >= 25 else 'low')
        return {
            'key': 'delivery_readiness',
            'label': 'Delivery Readiness',
            'weight': SIGNAL_WEIGHTS['delivery_readiness'],
            'raw_score': _clamp(pts),
            'confidence': confidence,
            'deadline': self._project.deadline.isoformat() if self._project.deadline else None,
            'marketing_item_count': len(self._marketing_items),
            'evidence': evidence,
            'explanation': (
                ', '.join(evidence) if evidence
                else 'No deadline, marketing content, or outcome description found.'
            ),
            'fix_link': '/marketing-studio',
        }

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def compute(self) -> dict[str, Any]:
        """Return the full health score dict."""
        signals = [
            self._score_idea_clarity(),
            self._score_roadmap_coverage(),
            self._score_team_alignment(),
            self._score_repository_activity(),
            self._score_code_to_plan_match(),
            self._score_testing_stability(),
            self._score_delivery_readiness(),
        ]

        # Weighted score
        weighted_total = sum(
            s['raw_score'] * s['weight'] for s in signals
        )
        overall_score = _clamp(weighted_total)

        # Evidence coverage = fraction of signals with confidence != 'low'
        evidenced = sum(1 for s in signals if s['confidence'] != 'low')
        evidence_coverage = _clamp(evidenced / len(signals) * 100)

        return {
            'score': overall_score,
            'status': _status_band(overall_score),
            'evidence_coverage': evidence_coverage,
            'signals': {s['key']: s for s in signals},
            'computed_at': timezone.now().isoformat(),
        }
