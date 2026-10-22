import json
import time
import asyncio

from django.http import StreamingHttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.idea_views import authorized_project_drafts
from apps.projects.models import ProjectDraft

from .agent import build_smoke_plan, build_full_plan, launch_run
from .models import TestRun, TestStep, TestEvent


def _owned_project_or_none(request, project_id):
    """Return the project if the user can access it, else None."""
    if not project_id:
        return None
    try:
        return authorized_project_drafts(request).get(pk=project_id)
    except Exception:
        return None


def _run_to_dict(run: TestRun) -> dict:
    return {
        'id': str(run.id),
        'project_id': str(run.project_id) if run.project_id else None,
        'target_url': run.target_url,
        'objective': run.objective,
        'mode': run.mode,
        'status': run.status,
        'test_plan': run.test_plan,
        'results_summary': run.results_summary,
        'passed_count': run.results_summary.get('passed', 0) if run.results_summary else 0,
        'failed_count': run.results_summary.get('failed', 0) if run.results_summary else 0,
        'started_at': run.started_at.isoformat() if run.started_at else None,
        'finished_at': run.finished_at.isoformat() if run.finished_at else None,
        'created_at': run.created_at.isoformat(),
    }


def _step_to_dict(step: TestStep) -> dict:
    return {
        'id': step.id,
        'index': step.index,
        'description': step.description,
        'action_type': step.action_type,
        'expected': step.expected,
        'actual': step.actual,
        'status': step.status,
        'error_message': step.error_message,
        'duration_ms': step.duration_ms,
        'started_at': step.started_at.isoformat() if step.started_at else None,
        'finished_at': step.finished_at.isoformat() if step.finished_at else None,
    }


def _event_to_dict(event: TestEvent) -> dict:
    return {
        'seq': event.seq,
        'event_type': event.event_type,
        'message': event.message,
        'data': event.data,
        'timestamp': event.timestamp.isoformat(),
    }


class TestRunCollectionView(APIView):
    """
    GET  — list runs for a project (or all runs for the user).
    POST — create a new run and start the agent.
    """

    def get(self, request):
        project_id = request.query_params.get('project')
        if project_id:
            project = _owned_project_or_none(request, project_id)
            if project is None:
                return Response({'runs': []})
            runs = TestRun.objects.filter(project=project)[:20]
        else:
            if request.user.is_authenticated:
                runs = TestRun.objects.filter(created_by=request.user)[:20]
            else:
                runs = TestRun.objects.none()
        return Response({'runs': [_run_to_dict(r) for r in runs]})

    def post(self, request):
        target_url = (request.data.get('target_url') or '').strip()
        if not target_url:
            return Response({'error': 'target_url is required.'}, status=400)
        if not (target_url.startswith('http://') or target_url.startswith('https://')):
            return Response({'error': 'target_url must start with http:// or https://.'}, status=400)

        objective = (request.data.get('objective') or '').strip()
        mode      = request.data.get('mode', 'smoke')
        if mode not in ('smoke', 'full'):
            mode = 'smoke'

        project_id = request.data.get('project_id')
        project = _owned_project_or_none(request, project_id) if project_id else None

        # Build test plan
        if mode == 'full':
            plan = build_full_plan(target_url, objective)
        else:
            plan = build_smoke_plan(target_url, objective)

        run = TestRun.objects.create(
            project=project,
            created_by=request.user if request.user.is_authenticated else None,
            target_url=target_url,
            objective=objective,
            mode=mode,
            status='queued',
            test_plan=plan,
        )

        # Start agent in background thread
        launch_run(str(run.id))

        return Response(_run_to_dict(run), status=status.HTTP_201_CREATED)


class TestRunDetailView(APIView):
    """GET — full run detail including steps."""

    def get(self, request, run_id):
        run = get_object_or_404(TestRun, pk=run_id)
        # Permission: must own the project or be the creator
        if run.project_id:
            project = _owned_project_or_none(request, run.project_id)
            if project is None and (not request.user.is_authenticated or run.created_by_id != request.user.pk):
                return Response({'error': 'Not found.'}, status=404)
        data = _run_to_dict(run)
        data['steps'] = [_step_to_dict(s) for s in run.steps.all()]
        return Response(data)


class TestRunControlView(APIView):
    """POST — pause | resume | cancel a run."""

    def post(self, request, run_id):
        run = get_object_or_404(TestRun, pk=run_id)
        action = request.data.get('action', '')
        if action == 'cancel':
            if run.status in ('queued', 'starting', 'running', 'paused'):
                run.status = 'cancelled'
                run.finished_at = timezone.now()
                run.save(update_fields=['status', 'finished_at', 'updated_at'])
            return Response(_run_to_dict(run))
        elif action == 'pause':
            if run.status == 'running':
                run.status = 'paused'
                run.save(update_fields=['status', 'updated_at'])
            return Response(_run_to_dict(run))
        elif action == 'resume':
            if run.status == 'paused':
                run.status = 'running'
                run.save(update_fields=['status', 'updated_at'])
            return Response(_run_to_dict(run))
        return Response({'error': f'Unknown action: {action}'}, status=400)


class TestRunEventsView(APIView):
    """
    GET — Server-Sent Events stream of agent events for a run.

    Uses Django's async StreamingHttpResponse so that each yielded chunk
    is sent to the client immediately without waiting for the generator
    to finish. This works with daphne, uvicorn, or gunicorn-sync.

    The frontend opens this as an EventSource. The agent writes TestEvent rows;
    this view polls for new rows every 400ms and streams them.
    """

    authentication_classes = []
    permission_classes = [AllowAny]

    async def get(self, request, run_id):
        # Import in async context
        from django.db import close_old_connections
        from asgiref.sync import sync_to_async

        @sync_to_async
        def get_run():
            return TestRun.objects.get(pk=run_id)

        @sync_to_async
        def refresh_status(run):
            run.refresh_from_db(fields=['status'])
            return run.status

        @sync_to_async
        def get_new_events(run, last_seq):
            return list(
                TestEvent.objects.filter(run=run, seq__gt=last_seq).order_by('seq')
            )

        try:
            run = await get_run()
        except TestRun.DoesNotExist:
            async def not_found():
                yield 'event: error\ndata: {"error":"Run not found"}\n\n'
            return StreamingHttpResponse(not_found(), content_type='text/event-stream')

        async def event_generator():
            last_seq = -1
            idle_rounds = 0
            max_idle = 150  # 150 × 0.4s = 60s max idle

            while True:
                try:
                    run_status = await refresh_status(run)
                except Exception:
                    break

                new_events = await get_new_events(run, last_seq)
                for ev in new_events:
                    payload = json.dumps(_event_to_dict(ev))
                    yield f'event: agent\ndata: {payload}\n\n'
                    last_seq = ev.seq
                    idle_rounds = 0

                if run_status in ('completed', 'failed', 'cancelled'):
                    # Drain any remaining events then close
                    remaining = await get_new_events(run, last_seq)
                    for ev in remaining:
                        payload = json.dumps(_event_to_dict(ev))
                        yield f'event: agent\ndata: {payload}\n\n'
                    yield f'event: done\ndata: {{"status":"{run_status}"}}\n\n'
                    break

                idle_rounds += 1
                if idle_rounds >= max_idle:
                    yield 'event: timeout\ndata: {}\n\n'
                    break

                # Heartbeat comment every 10s to keep connection alive
                if idle_rounds % 25 == 0:
                    yield ': heartbeat\n\n'

                await asyncio.sleep(0.4)

        response = StreamingHttpResponse(
            event_generator(),
            content_type='text/event-stream',
        )
        response['Cache-Control'] = 'no-cache, no-transform'
        response['X-Accel-Buffering'] = 'no'
        response['Access-Control-Allow-Origin'] = request.META.get('HTTP_ORIGIN', '*')
        response['Access-Control-Allow-Credentials'] = 'true'
        return response


class TestRunEventsPollingView(APIView):
    """
    GET — Polling fallback for SSE.
    Returns events after a given sequence number. Used as a fallback
    when EventSource/SSE is not streaming properly (e.g. dev server WSGI mode).

    Query params:
      after_seq — return events with seq > this value (default -1)
    """

    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request, run_id):
        run = get_object_or_404(TestRun, pk=run_id)
        try:
            after_seq = int(request.query_params.get('after_seq', -1))
        except (TypeError, ValueError):
            after_seq = -1

        events = list(
            TestEvent.objects.filter(run=run, seq__gt=after_seq).order_by('seq')[:50]
        )
        run.refresh_from_db(fields=['status', 'results_summary'])
        return Response({
            'events': [_event_to_dict(e) for e in events],
            'run_status': run.status,
            'results_summary': run.results_summary,
            'last_seq': events[-1].seq if events else after_seq,
        })


class TestPlanPreviewView(APIView):
    """POST — return the test plan that would be generated without starting a run."""

    def post(self, request):
        target_url = (request.data.get('target_url') or '').strip()
        objective  = (request.data.get('objective') or '').strip()
        mode       = request.data.get('mode', 'smoke')
        if mode == 'full':
            plan = build_full_plan(target_url or 'https://example.com', objective)
        else:
            plan = build_smoke_plan(target_url or 'https://example.com', objective)
        return Response({'plan': plan, 'mode': mode})
