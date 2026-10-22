from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView
from django.shortcuts import get_object_or_404

from apps.core.idea_views import authorized_project_drafts
from apps.projects.models import ProjectDraft

from .models import ProjectHealthSnapshot, ProjectPassport
from .service import HealthScoreService


def _owned_project(request, draft_id):
    return get_object_or_404(authorized_project_drafts(request), pk=draft_id)


def _snapshot_to_dict(snapshot):
    return {
        'id': snapshot.id,
        'score': snapshot.score,
        'status': snapshot.signals.get('status', ''),
        'evidence_coverage': snapshot.evidence_coverage,
        'signals': snapshot.signals,
        'computed_at': snapshot.computed_at.isoformat(),
    }


class HealthScoreView(APIView):
    """
    GET  — return the latest snapshot (or compute on-the-fly if none).
    POST — force a fresh computation and store a new snapshot.
    """

    def _compute_and_save(self, project):
        service = HealthScoreService(project)
        result = service.compute()
        snapshot = ProjectHealthSnapshot.objects.create(
            project=project,
            score=result['score'],
            signals=result,
            evidence_coverage=result['evidence_coverage'],
        )
        return snapshot, result

    def get(self, request, draft_id):
        project = _owned_project(request, draft_id)
        snapshot = project.health_snapshots.first()
        if snapshot is None:
            snapshot, _ = self._compute_and_save(project)
        return Response(_snapshot_to_dict(snapshot), status=status.HTTP_200_OK)

    def post(self, request, draft_id):
        project = _owned_project(request, draft_id)
        snapshot, result = self._compute_and_save(project)
        return Response(_snapshot_to_dict(snapshot), status=status.HTTP_201_CREATED)


class HealthActionsView(APIView):
    """
    GET — return the top 3 deterministic recommended actions based on real signal data.
    Optionally uses Gemini to enrich descriptions if configured; falls back silently.
    """

    def get(self, request, draft_id):
        project = _owned_project(request, draft_id)
        snapshot = project.health_snapshots.first()

        if snapshot is None:
            service = HealthScoreService(project)
            result = service.compute()
            signals = result.get('signals', {})
        else:
            signals = snapshot.signals.get('signals', snapshot.signals) or {}

        actions = _build_actions(signals)
        return Response({'actions': actions[:3]}, status=status.HTTP_200_OK)


def _build_actions(signals: dict) -> list:
    """Deterministic action candidates from real signal data."""
    candidates = []

    def _add(key, title, why, link, priority, effort, impact_pts):
        candidates.append({
            'signal_key': key,
            'title': title,
            'why': why,
            'link': link,
            'priority': priority,
            'effort': effort,
            'impact_estimate': impact_pts,
        })

    sig = signals

    # Idea Clarity
    ic = sig.get('idea_clarity', {})
    missing = ic.get('missing_fields', [])
    if ic.get('raw_score', 100) < 75 and missing:
        field_labels = {'project_name': 'project name', 'problem_statement': 'problem statement',
                        'target_users': 'target users', 'expected_outcome': 'expected outcome'}
        label_list = ', '.join(field_labels.get(f, f) for f in missing[:2])
        _add('idea_clarity',
             f'Fill in the {label_list}',
             f'{len(missing)} understanding field(s) are empty. Clarity is the foundation for everything else.',
             '/projects/new/setup', 'high', '5 min', 8)

    # Roadmap Coverage
    rc = sig.get('roadmap_coverage', {})
    if rc.get('raw_score', 100) < 60:
        if rc.get('milestone_count', 0) == 0:
            _add('roadmap_coverage', 'Generate your Flight Plan',
                 'No milestones or tasks found. A flight plan is needed to score roadmap, team alignment, and code match.',
                 '/flight-plan', 'high', '10 min', 12)
        else:
            _add('roadmap_coverage', 'Add deadlines to your roadmap tasks',
                 f'Only {rc.get("tasks_with_deadline", 0)}/{rc.get("task_count", 0)} tasks have deadlines.',
                 '/flight-plan', 'medium', '15 min', 6)

    # Team Alignment
    ta = sig.get('team_alignment', {})
    if ta.get('raw_score', 100) < 50 and ta.get('member_count', 0) > 1:
        unassigned = ta.get('total_task_count', 0) - ta.get('assigned_task_count', 0)
        _add('team_alignment', 'Assign unassigned tasks to team members',
             f'{unassigned} task(s) have no owner — assign them in Team Workspace.',
             '/team', 'medium', '10 min', 7)

    # Repository Activity
    ra = sig.get('repository_activity', {})
    if ra.get('raw_score', 100) < 50:
        if ra.get('connection_status') is None:
            _add('repository_activity', 'Connect your GitHub repository',
                 'No repository linked. Connecting unlocks code analysis, plan matching, and stability checks.',
                 '/repository', 'high', '5 min', 20)
        else:
            _add('repository_activity', 'Re-sync your repository',
                 'Repository is connected but the analysis is out of date.',
                 '/repository', 'medium', '2 min', 8)

    # Code-to-Plan Match
    cp = sig.get('code_to_plan_match', {})
    if cp.get('raw_score', 100) < 40:
        _add('code_to_plan_match', 'Run a roadmap vs. code comparison',
             'No comparison has been run. Running it reveals which tasks are implemented and which are missing.',
             '/repository', 'high', '3 min', 18)

    # Testing & Stability
    ts = sig.get('testing_stability', {})
    if ts.get('raw_score', 100) < 50:
        critical = ts.get('critical_findings', 0)
        if critical > 0:
            _add('testing_stability', f'Address {critical} critical finding(s)',
                 f'{critical} critical issue(s) detected in repository analysis.',
                 '/repository', 'high', '1-4 hrs', 14)
        else:
            _add('testing_stability', 'Run a fresh code analysis',
                 'No repository analysis available — test coverage and stability are unknown.',
                 '/repository', 'medium', '5 min', 10)

    # Delivery Readiness
    dr = sig.get('delivery_readiness', {})
    if dr.get('raw_score', 100) < 50:
        if not dr.get('deadline'):
            _add('delivery_readiness', 'Set a project deadline',
                 'No deadline is configured. Without a deadline, delivery readiness cannot be assessed.',
                 '/projects', 'medium', '2 min', 6)
        elif not dr.get('marketing_item_count', 0):
            _add('delivery_readiness', 'Create launch marketing content',
                 'No marketing content created yet. Launch materials are part of delivery readiness.',
                 '/marketing-studio', 'low', '20 min', 5)

    # Sort: high → medium → low, then by impact descending
    priority_order = {'high': 0, 'medium': 1, 'low': 2}
    candidates.sort(key=lambda a: (priority_order.get(a['priority'], 3), -a['impact_estimate']))
    return candidates


class HealthHistoryView(APIView):
    """GET — last N snapshots for a project (default 10)."""

    def get(self, request, draft_id):
        project = _owned_project(request, draft_id)
        limit = min(int(request.query_params.get('limit', 10)), 50)
        snapshots = project.health_snapshots.all()[:limit]
        return Response({
            'history': [
                {
                    'score': s.score,
                    'status': s.signals.get('status', ''),
                    'evidence_coverage': s.evidence_coverage,
                    'computed_at': s.computed_at.isoformat(),
                }
                for s in snapshots
            ]
        }, status=status.HTTP_200_OK)


class PassportView(APIView):
    """
    GET    — retrieve or create a passport record for a project.
    POST   — update disclosed_fields or toggle is_published.
    DELETE — unpublish and reset.
    """

    def _get_or_create_passport(self, project):
        passport, _ = ProjectPassport.objects.get_or_create(project=project)
        return passport

    def _passport_data(self, passport, request):
        from django.conf import settings
        base = getattr(settings, 'FRONTEND_BASE_URL', 'http://localhost:5173').rstrip('/')
        public_url = f'{base}/passport/{passport.public_id}'
        snapshot = passport.project.health_snapshots.first()
        return {
            'id': str(passport.public_id),
            'is_published': passport.is_published,
            'disclosed_fields': passport.disclosed_fields,
            'published_at': passport.published_at.isoformat() if passport.published_at else None,
            'public_url': public_url,
            'score': snapshot.score if snapshot else None,
            'status': snapshot.signals.get('status', '') if snapshot else '',
        }

    def get(self, request, draft_id):
        project = _owned_project(request, draft_id)
        passport = self._get_or_create_passport(project)
        return Response(self._passport_data(passport, request), status=status.HTTP_200_OK)

    def post(self, request, draft_id):
        project = _owned_project(request, draft_id)
        passport = self._get_or_create_passport(project)

        if 'is_published' in request.data:
            new_published = bool(request.data['is_published'])
            passport.is_published = new_published
            if new_published and not passport.published_at:
                passport.published_at = timezone.now()
            elif not new_published:
                passport.published_at = None

        if 'disclosed_fields' in request.data:
            disclosed = request.data['disclosed_fields']
            if not isinstance(disclosed, list):
                return Response({'error': 'disclosed_fields must be a list.'}, status=status.HTTP_400_BAD_REQUEST)
            allowed = {'score', 'signals', 'evidence_coverage', 'team_size', 'tech_stack', 'project_name', 'problem_statement'}
            clean = [f for f in disclosed if isinstance(f, str) and f in allowed]
            passport.disclosed_fields = clean

        passport.save()
        return Response(self._passport_data(passport, request), status=status.HTTP_200_OK)

    def delete(self, request, draft_id):
        project = _owned_project(request, draft_id)
        passport = self._get_or_create_passport(project)
        passport.is_published = False
        passport.published_at = None
        passport.save(update_fields=['is_published', 'published_at', 'updated_at'])
        return Response({'message': 'Passport unpublished.'}, status=status.HTTP_200_OK)


class PublicPassportView(APIView):
    """GET — public read-only view; no authentication required."""

    authentication_classes = []
    permission_classes = []

    def get(self, request, public_id):
        passport = get_object_or_404(ProjectPassport, public_id=public_id, is_published=True)
        project = passport.project
        snapshot = project.health_snapshots.first()
        disclosed = set(passport.disclosed_fields or [])

        data: dict = {
            'project_name': project.understanding.get('project_name', 'Untitled project'),
            'published_at': passport.published_at.isoformat() if passport.published_at else None,
        }

        if 'score' in disclosed and snapshot:
            data['score'] = snapshot.score
            data['status'] = snapshot.signals.get('status', '')

        if 'evidence_coverage' in disclosed and snapshot:
            data['evidence_coverage'] = snapshot.evidence_coverage

        if 'signals' in disclosed and snapshot:
            # Provide only public-safe signal summaries (no internal DB keys)
            raw_signals = snapshot.signals.get('signals', {}) or {}
            data['signals'] = {
                k: {
                    'label': v.get('label', k),
                    'raw_score': v.get('raw_score', 0),
                    'confidence': v.get('confidence', 'low'),
                    'explanation': v.get('explanation', ''),
                }
                for k, v in raw_signals.items()
            }

        if 'problem_statement' in disclosed:
            data['problem_statement'] = project.understanding.get('problem_statement', '')

        if 'tech_stack' in disclosed:
            try:
                repo = project.repository
                data['tech_stack'] = repo.detected_technologies if repo else []
            except Exception:
                data['tech_stack'] = []

        if 'team_size' in disclosed:
            data['team_size'] = project.team_size

        return Response(data, status=status.HTTP_200_OK)
