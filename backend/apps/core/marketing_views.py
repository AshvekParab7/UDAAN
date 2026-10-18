import uuid

from django.db.models import Q
from django.shortcuts import get_object_or_404
from rest_framework import serializers, status
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.projects.models import MarketingContentItem, ProjectDraft, ProjectRepository
from apps.roadmaps.models import ProjectTask
from .gemini_service import GeminiConfigurationError, GeminiRequestError, generate_marketing_content


def workspace_key(request):
    raw = request.headers.get('X-Marketing-Workspace', '')
    try:
        return str(uuid.UUID(raw))
    except (ValueError, AttributeError, TypeError):
        return ''


def user_projects(request):
    return ProjectDraft.objects.filter(owner=request.user) if request.user.is_authenticated else ProjectDraft.objects.filter(owner__isnull=True)


def marketing_project_context(project):
    understanding = project.understanding or {}
    try:
        repository = project.repository
    except ProjectRepository.DoesNotExist:
        repository = None
    plan = (project.workflow or {}).get('flight_plan') or {}
    milestones = []
    for milestone in (plan.get('milestones') or [])[:12]:
        milestones.append({
            'milestone': str(milestone.get('title') or '')[:180],
            'status': str(milestone.get('status') or 'planned')[:40],
            'planned_tasks': [str(task.get('title') if isinstance(task, dict) else task)[:180] for task in (milestone.get('tasks') or [])[:12]],
        })
    completed_tasks = list(ProjectTask.objects.filter(project=project, status='completed').values('title', 'milestone')[:30])
    verified_tasks = []
    assessment = project.roadmap_assessments.first()
    if assessment:
        for row in (assessment.task_assessments or {}).values():
            if row.get('status') == 'verified':
                verified_tasks.append({
                    'task': str(row.get('taskTitle') or '')[:180],
                    'evidence': [str(entry.get('text') or '')[:250] for entry in (row.get('evidence') or [])[:3]],
                    'revision': str(row.get('commit_sha') or assessment.commit_sha)[:64],
                })
    technologies = []
    if repository:
        for technology in (repository.detected_technologies or [])[:20]:
            if isinstance(technology, dict):
                technologies.append({'name': str(technology.get('name') or '')[:100], 'evidence': str(technology.get('evidence') or '')[:180]})
            elif isinstance(technology, str):
                technologies.append({'name': technology[:100], 'evidence': 'Listed in connected repository metadata.'})
    return {
        'project_name': str(understanding.get('project_name') or '')[:160],
        'project_type': project.project_type,
        'idea': str(project.idea or '')[:1200],
        'problem': str(understanding.get('problem_statement') or '')[:800],
        'target_audience': str(understanding.get('target_users') or '')[:500],
        'desired_outcome': str(understanding.get('expected_outcome') or '')[:500],
        'technologies': technologies,
        'roadmap': milestones,
        'workspace_marked_completed_tasks': completed_tasks,
        'independently_verified_tasks': verified_tasks[:20],
        'repository': {
            'name': repository.repo_full_name,
            'revision': repository.last_synced_sha,
            'synced_at': repository.last_synced_at.isoformat() if repository.last_synced_at else None,
            'source_evidence_paths': (repository.latest_analysis or {}).get('evidenceFiles', [])[:25],
        } if repository else None,
        'claim_notes': 'Roadmap entries are plans. Workspace-completed task states are user-recorded progress, not independent proof. Only verified tasks include check-backed verification status.',
    }


class MarketingGenerationInput(serializers.Serializer):
    mode = serializers.ChoiceField(choices=['social', 'showcase', 'repurpose', 'campaign', 'tool', 'refine'])
    project_id = serializers.UUIDField(required=False, allow_null=True)
    inputs = serializers.DictField()

    def validate_inputs(self, value):
        if len(str(value)) > 12000:
            raise serializers.ValidationError('Marketing inputs are too long.')
        limits = {'topic': 2400, 'objective': 600, 'audience': 600, 'tone': 80, 'length': 80,
                  'keywords': 500, 'cta': 500, 'extra_instructions': 1800, 'context_override': 7000,
                  'source_content': 8000, 'source_title': 240, 'template': 80}
        for key, limit in limits.items():
            item = value.get(key, '')
            if not isinstance(item, str) or len(item) > limit:
                raise serializers.ValidationError({key: f'Use text of up to {limit} characters.'})
        if 'formats' in value and (not isinstance(value['formats'], list) or len(value['formats']) > 8 or any(not isinstance(item, str) or len(item) > 80 for item in value['formats'])):
            raise serializers.ValidationError({'formats': 'Choose up to eight valid output formats.'})
        if self.initial_data.get('mode') == 'repurpose' and not value.get('formats'):
            raise serializers.ValidationError({'formats': 'Select at least one output format.'})
        if value.get('campaign_days', 7) not in (7, 30):
            raise serializers.ValidationError({'campaign_days': 'Campaign length must be 7 or 30 days.'})
        return value


class MarketingGenerateView(APIView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'marketing_ai'

    def post(self, request):
        serializer = MarketingGenerationInput(data=request.data)
        if not serializer.is_valid():
            return Response({'error': 'Check the content request and try again.', 'fields': serializer.errors}, status=status.HTTP_400_BAD_REQUEST)
        values = serializer.validated_data
        project = None
        if values.get('project_id'):
            project = get_object_or_404(user_projects(request), pk=values['project_id'])
        context = marketing_project_context(project) if project else None
        if values['inputs'].get('context_override'):
            context = {**(context or {}), 'user_edited_context': values['inputs']['context_override']}
        try:
            result = generate_marketing_content(mode=values['mode'], inputs=values['inputs'], project_context=context)
        except GeminiConfigurationError as error:
            return Response({'error': str(error), 'code': 'gemini_not_configured'}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        except GeminiRequestError as error:
            return Response({'error': str(error), 'code': 'generation_failed', 'retryable': error.retryable}, status=status.HTTP_502_BAD_GATEWAY)
        return Response({'result': result, 'project_context_used': bool(project)}, status=status.HTTP_200_OK)


class MarketingContentSerializer(serializers.ModelSerializer):
    project_name = serializers.SerializerMethodField()

    class Meta:
        model = MarketingContentItem
        fields = ['id', 'title', 'body', 'content_type', 'platform', 'project', 'project_name', 'generation_inputs', 'status', 'created_at', 'updated_at']
        read_only_fields = ['id', 'project', 'project_name', 'created_at', 'updated_at']

    def get_project_name(self, obj):
        return (obj.project.understanding or {}).get('project_name') if obj.project_id else None

    def validate(self, attrs):
        if len(str(attrs)) > 14000:
            raise serializers.ValidationError('Saved content is too large.')
        return attrs


class MarketingContentCollectionView(APIView):
    def _queryset(self, request):
        if request.user.is_authenticated:
            key = workspace_key(request)
            visibility = Q(owner=request.user)
            if key:
                visibility |= Q(owner__isnull=True, browser_key=key)
            return MarketingContentItem.objects.filter(visibility).select_related('project')
        key = workspace_key(request)
        return MarketingContentItem.objects.filter(owner__isnull=True, browser_key=key).select_related('project') if key else MarketingContentItem.objects.none()

    def get(self, request):
        items = self._queryset(request)
        project_id = request.query_params.get('project')
        content_type = request.query_params.get('type')
        platform = request.query_params.get('platform')
        query = request.query_params.get('q', '').strip()[:120]
        if project_id == 'custom': items = items.filter(project__isnull=True)
        elif project_id: items = items.filter(project_id=project_id)
        if content_type: items = items.filter(content_type=content_type[:40])
        if platform: items = items.filter(platform__icontains=platform[:80])
        if query: items = items.filter(Q(title__icontains=query) | Q(body__icontains=query))
        return Response({'results': MarketingContentSerializer(items[:200], many=True).data})

    def post(self, request):
        payload = request.data.copy()
        project_id = payload.pop('project_id', None)
        project = get_object_or_404(user_projects(request), pk=project_id) if project_id else None
        key = '' if request.user.is_authenticated else workspace_key(request)
        if not request.user.is_authenticated and not key:
            return Response({'error': 'A valid marketing workspace identifier is required.'}, status=status.HTTP_400_BAD_REQUEST)
        serializer = MarketingContentSerializer(data=payload)
        if not serializer.is_valid():
            return Response({'error': 'Check the saved content and try again.', 'fields': serializer.errors}, status=status.HTTP_400_BAD_REQUEST)
        item = serializer.save(owner=request.user if request.user.is_authenticated else None, project=project, browser_key=key)
        return Response(MarketingContentSerializer(item).data, status=status.HTTP_201_CREATED)


class MarketingContentDetailView(APIView):
    def _item(self, request, item_id):
        if request.user.is_authenticated:
            key = workspace_key(request)
            visibility = Q(owner=request.user)
            if key:
                visibility |= Q(owner__isnull=True, browser_key=key)
            items = MarketingContentItem.objects.filter(visibility)
        else:
            key = workspace_key(request)
            items = MarketingContentItem.objects.filter(owner__isnull=True, browser_key=key) if key else MarketingContentItem.objects.none()
        return get_object_or_404(items, pk=item_id)

    def patch(self, request, item_id):
        item = self._item(request, item_id)
        serializer = MarketingContentSerializer(item, data=request.data, partial=True)
        if not serializer.is_valid():
            return Response({'error': 'Check the content changes and try again.', 'fields': serializer.errors}, status=status.HTTP_400_BAD_REQUEST)
        updated = serializer.save()
        if request.user.is_authenticated and not updated.owner_id:
            updated.owner = request.user
            updated.browser_key = ''
            updated.save(update_fields=['owner', 'browser_key', 'updated_at'])
        return Response(serializer.data)

    def delete(self, request, item_id):
        self._item(request, item_id).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
