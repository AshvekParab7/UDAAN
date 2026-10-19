from rest_framework import serializers, status
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.exceptions import NotFound
from django.shortcuts import get_object_or_404
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
# pyrefly: ignore[missing-import]
from apps.projects.models import ProjectDraft, ProjectStageGeneration, ProjectRepository, RoadmapAssessment, ProjectLearningState
from .stage_generation import STAGE_ORDER, enqueue_stage_generation, mark_draft_generation_changes, serialize_generation, stage_input_hash, stage_prerequisite_ready
from .roadmap_matcher import compare_roadmap_with_repository


def authorized_project_drafts(request):
    if request.user.is_authenticated:
        user_email = (request.user.email or '').strip()
        query = Q(owner=request.user) | Q(team_members__user=request.user)
        if user_email:
            query |= Q(team_members__email__iexact=user_email)
        return ProjectDraft.objects.filter(query).distinct()
    return ProjectDraft.objects.filter(owner__isnull=True)

from .gemini_service import (
    GeminiConfigurationError,
    GeminiRequestError,
    analyze_idea,
    explain_repository_finding,
    explain_roadmap_task_assessment,
    generate_idea_stage,
    tutor_learning_question,
    recommend_learning_path,
)


class IdeaAnalysisInputSerializer(serializers.Serializer):
    idea = serializers.CharField(max_length=4000, allow_blank=False, trim_whitespace=True)
    project_type = serializers.ChoiceField(choices=['Startup', 'Hackathon', 'College Project', 'Personal Project'])
    attachment_name = serializers.CharField(max_length=255, required=False, allow_blank=True)
    attachment_text = serializers.CharField(max_length=20000, required=False, allow_blank=True)
    project_name = serializers.CharField(max_length=160, required=False, allow_blank=True)
    problem_statement = serializers.CharField(max_length=1200, required=False, allow_blank=True)
    target_users = serializers.CharField(max_length=600, required=False, allow_blank=True)
    expected_outcome = serializers.CharField(max_length=800, required=False, allow_blank=True)


class IdeaAnalysisView(APIView):
    authentication_classes = []
    permission_classes = []

    def post(self, request):
        serializer = IdeaAnalysisInputSerializer(data=request.data)
        if not serializer.is_valid():
            return Response({'error': 'Check the idea details and try again.', 'fields': serializer.errors}, status=status.HTTP_400_BAD_REQUEST)

        try:
            result = analyze_idea(**serializer.validated_data)
        except GeminiConfigurationError as error:
            return Response({'error': str(error)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        except GeminiRequestError as error:
            return Response({'error': str(error)}, status=status.HTTP_502_BAD_GATEWAY)

        return Response({'analysis': result}, status=status.HTTP_200_OK)


class IdeaWorkflowInputSerializer(serializers.Serializer):
    stage = serializers.ChoiceField(choices=['research', 'feasibility', 'flight_plan'])
    idea = serializers.CharField(max_length=4000, allow_blank=False, trim_whitespace=True)
    project_type = serializers.ChoiceField(choices=['Startup', 'Hackathon', 'College Project', 'Personal Project'])
    project_id = serializers.UUIDField(required=False)
    project_details = serializers.JSONField(required=False, default=dict)

    def validate_project_details(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError('Project details must be an object.')
        if len(str(value)) > 50000:
            raise serializers.ValidationError('Project details are too long.')
        return value


class IdeaWorkflowStageView(APIView):
    def post(self, request):
        serializer = IdeaWorkflowInputSerializer(data=request.data)
        if not serializer.is_valid():
            return Response({'error': 'Check the project details and try again.', 'fields': serializer.errors}, status=status.HTTP_400_BAD_REQUEST)
        try:
            values = dict(serializer.validated_data)
            project_id = values.pop('project_id', None)
            if project_id:
                drafts = authorized_project_drafts(request)
                saved_project = get_object_or_404(drafts, pk=project_id)
                supplied_details = values.pop('project_details', {})
                saved_details = {'understanding': saved_project.understanding, **saved_project.workflow}
                # Attachments are transient input material; saved project fields remain authoritative.
                if supplied_details.get('attachment'):
                    saved_details['attachment'] = supplied_details['attachment']
                if saved_project.start_date:
                    saved_details['start_date'] = saved_project.start_date.isoformat()
                if saved_project.deadline:
                    saved_details['deadline'] = saved_project.deadline.isoformat()
                saved_details['team_size'] = saved_project.team_size
                saved_details['weekly_hours'] = saved_project.weekly_hours
                for key in ('start_date', 'deadline', 'team_size', 'weekly_hours', 'completed_task_ids'):
                    if supplied_details.get(key) is not None:
                        saved_details[key] = supplied_details[key]
                values['idea'] = saved_project.idea
                values['project_type'] = saved_project.project_type
                values['project_details'] = saved_details
            result = generate_idea_stage(**values)
        except GeminiConfigurationError as error:
            return Response({'error': str(error)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        except GeminiRequestError as error:
            return Response({'error': str(error)}, status=status.HTTP_502_BAD_GATEWAY)
        return Response({'result': result}, status=status.HTTP_200_OK)


class ProjectRepositorySerializer(serializers.ModelSerializer):
    class Meta:
        model = ProjectRepository
        fields = [
            'id', 'repo_owner', 'repo_name', 'repo_full_name', 'repo_url',
            'selected_branch', 'connection_status', 'last_synced_sha',
            'last_synced_at', 'detected_technologies', 'latest_analysis',
            'is_empty', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']


class RoadmapAssessmentSerializer(serializers.ModelSerializer):
    class Meta:
        model = RoadmapAssessment
        fields = [
            'id', 'project', 'repository', 'commit_sha', 'branch',
            'summary', 'task_assessments', 'milestone_assessments',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']


class ProjectDraftSerializer(serializers.ModelSerializer):
    project_type = serializers.ChoiceField(choices=['Startup', 'Hackathon', 'College Project', 'Personal Project'])
    current_stage = serializers.ChoiceField(choices=['understanding', 'research', 'feasibility', 'launch_timing', 'timing', 'flight_plan'])
    repository = serializers.SerializerMethodField()
    latest_assessment = serializers.SerializerMethodField()
    team_size = serializers.IntegerField(min_value=1, max_value=50, required=False, allow_null=True)

    class Meta:
        model = ProjectDraft
        fields = [
            'id', 'idea', 'project_type', 'attachment', 'understanding',
            'workflow', 'current_stage', 'start_date', 'deadline',
            'team_size', 'weekly_hours', 'schedule_metadata',
            'repository', 'latest_assessment',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']

    def validate(self, attrs):
        start = attrs.get('start_date') or (self.instance.start_date if self.instance else None)
        deadline = attrs.get('deadline') or (self.instance.deadline if self.instance else None)
        if deadline and start and deadline <= start:
            raise serializers.ValidationError({'deadline': 'The deadline must be strictly after the start date.'})
        return attrs

    def get_repository(self, obj):
        try:
            if hasattr(obj, 'repository') and obj.repository:
                return ProjectRepositorySerializer(obj.repository).data
        except Exception:
            pass
        return None

    def get_latest_assessment(self, obj):
        try:
            assessment = obj.roadmap_assessments.first()
            if assessment:
                return RoadmapAssessmentSerializer(assessment).data
        except Exception:
            pass
        return None

    def validate_idea(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError('An idea is required.')
        return value

    def validate_understanding(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError('Understanding must be an object.')
        return value

    def validate_workflow(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError('Workflow must be an object.')
        if len(str(value)) > 100000:
            raise serializers.ValidationError('Workflow is too large.')
        return value


class ProjectDraftView(APIView):
    """Browser drafts have UUID bearer access until user auth is implemented."""

    def _drafts_for_request(self, request):
        return authorized_project_drafts(request)

    def get(self, request, draft_id):
        draft = get_object_or_404(self._drafts_for_request(request), pk=draft_id)
        return Response(ProjectDraftSerializer(draft).data)

    def put(self, request, draft_id):
        payload = request.data.copy()
        edited_stages = payload.pop('edited_stages', [])
        allowed_edits = {'understanding', *STAGE_ORDER}
        if not isinstance(edited_stages, list) or any(stage not in allowed_edits for stage in edited_stages):
            return Response({'error': 'Edited stages must be a list of valid stage names.'}, status=status.HTTP_400_BAD_REQUEST)
        with transaction.atomic():
            existing = self._drafts_for_request(request).select_for_update().filter(pk=draft_id).first()
            if not existing and ProjectDraft.objects.filter(pk=draft_id).exists():
                raise NotFound
            previous_workflow = existing.workflow if existing else {}
            serializer = ProjectDraftSerializer(existing, data=payload)
            if not serializer.is_valid():
                return Response({'error': 'Check the project draft and try again.', 'fields': serializer.errors}, status=status.HTTP_400_BAD_REQUEST)
            next_workflow = serializer.validated_data.get('workflow') or {}
            if existing:
                for stage in STAGE_ORDER:
                    if stage in edited_stages or next_workflow.get(stage) == previous_workflow.get(stage):
                        continue
                    generation = ProjectStageGeneration.objects.filter(project=existing, stage=stage, has_generated_result=True).first()
                    if generation:
                        next_workflow[stage] = previous_workflow.get(stage)
                serializer.validated_data['workflow'] = next_workflow
            draft = serializer.save(owner=(existing.owner if existing and existing.owner_id else (request.user if request.user.is_authenticated else None)), id=draft_id)
            # pyrefly: ignore[missing-import]
            from apps.core.team_workspace import ensure_member_slots
            ensure_member_slots(draft, current_user=request.user)
            mark_draft_generation_changes(draft, previous_workflow, edited_stages)
        return Response(ProjectDraftSerializer(draft).data, status=status.HTTP_200_OK if existing else status.HTTP_201_CREATED)


class ProjectDraftCollectionView(APIView):
    """List only account-owned drafts; anonymous projects stay in browser storage and UUID access."""
    def get(self, request):
        if not request.user.is_authenticated:
            return Response({'results': []})
        drafts = authorized_project_drafts(request).select_related('repository')
        return Response({'results': ProjectDraftSerializer(drafts, many=True).data})


class ProjectLearningStateSerializer(serializers.ModelSerializer):
    class Meta:
        model = ProjectLearningState
        fields = ['step_status', 'step_concepts', 'saved_resources', 'recently_viewed', 'task_feedback', 'learning_path', 'path_task_key', 'path_context_hash', 'updated_at']
        read_only_fields = ['learning_path', 'path_task_key', 'path_context_hash', 'updated_at']

    def validate(self, attrs):
        if len(str(attrs)) > 40000:
            raise serializers.ValidationError('Learning progress is too large.')
        return attrs

    def validate_step_status(self, value):
        if not isinstance(value, dict) or len(value) > 300 or any(status not in ('not_started', 'in_progress', 'completed') for status in value.values()):
            raise serializers.ValidationError('Learning step progress must contain valid statuses.')
        return value

    def validate_step_concepts(self, value):
        if not isinstance(value, dict) or len(value) > 300 or any(not isinstance(key, str) or len(key) > 160 or not isinstance(concept, str) or len(concept) > 180 for key, concept in value.items()):
            raise serializers.ValidationError('Learning step concepts are invalid.')
        return value

    def validate_saved_resources(self, value):
        if not isinstance(value, list) or len(value) > 200 or any(not isinstance(item, str) or len(item) > 160 for item in value):
            raise serializers.ValidationError('Saved resources must be a list of resource identifiers.')
        return list(dict.fromkeys(value))

    def validate_recently_viewed(self, value):
        if not isinstance(value, list) or len(value) > 50 or any(not isinstance(item, str) or len(item) > 160 for item in value):
            raise serializers.ValidationError('Recently viewed must be a list of resource identifiers.')
        return list(dict.fromkeys(value))[-20:]

    def validate_task_feedback(self, value):
        if not isinstance(value, dict) or len(value) > 300 or len(str(value)) > 20000:
            raise serializers.ValidationError('Task learning feedback is too large.')
        return value


def owned_project(request, draft_id):
    return get_object_or_404(authorized_project_drafts(request), pk=draft_id)


class ProjectLearningStateView(APIView):
    def get(self, request, draft_id):
        project = owned_project(request, draft_id)
        state, _ = ProjectLearningState.objects.get_or_create(project=project)
        return Response(ProjectLearningStateSerializer(state).data)

    def put(self, request, draft_id):
        project = owned_project(request, draft_id)
        state, _ = ProjectLearningState.objects.get_or_create(project=project)
        serializer = ProjectLearningStateSerializer(state, data=request.data)
        if not serializer.is_valid():
            return Response({'error': 'Check the learning progress and try again.', 'fields': serializer.errors}, status=status.HTTP_400_BAD_REQUEST)
        serializer.save()
        return Response(serializer.data)


class ProjectLearningTutorView(APIView):
    def post(self, request, draft_id):
        project = owned_project(request, draft_id)
        question = request.data.get('question', '')
        level = request.data.get('level', 'beginner')
        code_context = request.data.get('code_context', '')
        task = request.data.get('task') or {}
        if not isinstance(question, str) or not question.strip() or len(question) > 1500:
            return Response({'error': 'Enter a question of up to 1,500 characters.'}, status=status.HTTP_400_BAD_REQUEST)
        if level not in ('beginner', 'intermediate', 'advanced') or not isinstance(code_context, str) or len(code_context) > 5000 or not isinstance(task, dict) or len(str(task)) > 3000:
            return Response({'error': 'Check the tutor context and try again.'}, status=status.HTTP_400_BAD_REQUEST)
        repo = None
        try:
            repo = project.repository
        except ProjectRepository.DoesNotExist:
            pass
        context = {
            'name': (project.understanding or {}).get('project_name', ''),
            'description': (project.understanding or {}).get('problem_statement', '') or project.idea,
            'technologies': repo.detected_technologies if repo else [],
            'repository': repo.latest_analysis if repo else {},
        }
        try:
            answer = tutor_learning_question(project=context, task=task, question=question.strip(), level=level, code_context=code_context)
        except GeminiConfigurationError as error:
            return Response({'error': str(error), 'code': 'gemini_unavailable'}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        except GeminiRequestError as error:
            return Response({'error': str(error), 'code': 'tutor_failed'}, status=status.HTTP_502_BAD_GATEWAY)
        return Response({'answer': answer, 'repository_evidence_available': bool(repo and repo.latest_analysis)})


class ProjectLearningRecommendationsView(APIView):
    def post(self, request, draft_id):
        project = owned_project(request, draft_id)
        task_key = request.data.get('task_key', '')
        resources = request.data.get('resources', [])
        if not isinstance(task_key, str) or len(task_key) > 20 or not isinstance(resources, list) or len(resources) > 40:
            return Response({'error': 'Check the learning request and try again.'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            milestone_index, task_index = [int(part) for part in task_key.split('-', 1)]
            task = project.workflow['flight_plan']['milestones'][milestone_index]['tasks'][task_index]
        except (ValueError, TypeError, KeyError, IndexError):
            return Response({'error': 'The selected roadmap task is no longer available.'}, status=status.HTTP_404_NOT_FOUND)
        clean_resources = []
        for resource in resources:
            if not isinstance(resource, dict) or not isinstance(resource.get('id'), str) or not isinstance(resource.get('title'), str):
                return Response({'error': 'Learning resource metadata is invalid.'}, status=status.HTTP_400_BAD_REQUEST)
            clean_resources.append({'id': resource['id'][:160], 'title': resource['title'][:180], 'topics': [str(x)[:80] for x in resource.get('topics', [])[:8]] if isinstance(resource.get('topics', []), list) else []})
        try:
            repo = project.repository
        except ProjectRepository.DoesNotExist:
            repo = None
        context = {
            'name': (project.understanding or {}).get('project_name', ''),
            'description': (project.understanding or {}).get('problem_statement', '') or project.idea,
            'project_type': project.project_type,
            'technologies': repo.detected_technologies if repo else [],
            'repository_analysis_summary': (repo.latest_analysis or {}).get('summary', {}) if repo else {},
        }
        completed_concepts = request.data.get('completed_concepts', [])
        if not isinstance(completed_concepts, list) or len(completed_concepts) > 80 or any(not isinstance(value, str) or len(value) > 180 for value in completed_concepts):
            return Response({'error': 'Completed learning concepts are invalid.'}, status=status.HTTP_400_BAD_REQUEST)
        import hashlib
        import json
        from django.db import transaction
        context_hash = hashlib.sha256(json.dumps({'project': context, 'task': task, 'resources': clean_resources}, sort_keys=True, ensure_ascii=False, default=str).encode('utf-8')).hexdigest()
        state, _ = ProjectLearningState.objects.get_or_create(project=project)
        if state.path_task_key == task_key and state.path_context_hash == context_hash and isinstance(state.learning_path, list) and state.learning_path:
            return Response({'steps': state.learning_path, 'task': task, 'task_key': task_key, 'repository_evidence_available': bool(repo and repo.latest_analysis), 'cached': True})
        try:
            steps = recommend_learning_path(project=context, task=task, resources=clean_resources, completed_concepts=completed_concepts)
        except GeminiConfigurationError as error:
            return Response({'error': str(error), 'code': 'gemini_unavailable'}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        except GeminiRequestError as error:
            return Response({'error': str(error), 'code': 'recommendations_failed'}, status=status.HTTP_502_BAD_GATEWAY)
        for step in steps:
            concept_key = f"{task_key}:{step['concept'].casefold()}"
            step['id'] = f"learn-{hashlib.sha256(concept_key.encode('utf-8')).hexdigest()[:16]}"
        with transaction.atomic():
            locked = ProjectLearningState.objects.select_for_update().get(project=project)
            # A concurrent generation may already have persisted the same project context.
            if locked.path_task_key != task_key or locked.path_context_hash != context_hash:
                locked.learning_path = steps
                locked.path_task_key = task_key
                locked.path_context_hash = context_hash
                locked.save(update_fields=['learning_path', 'path_task_key', 'path_context_hash', 'updated_at'])
            else:
                steps = locked.learning_path
        return Response({'steps': steps, 'task': task, 'task_key': task_key, 'repository_evidence_available': bool(repo and repo.latest_analysis), 'cached': False})


class ProjectStageGenerationView(APIView):
    def _draft(self, request, draft_id):
        return get_object_or_404(authorized_project_drafts(request), pk=draft_id)

    def get(self, request, draft_id, stage):
        if stage not in STAGE_ORDER:
            raise NotFound
        draft = self._draft(request, draft_id)
        job = ProjectStageGeneration.objects.filter(project=draft, stage=stage).first()
        if not job:
            return Response({'stage': stage, 'status': 'not_started', 'result': (draft.workflow or {}).get(stage), 'error': '', 'manually_edited': False, 'has_generated_result': False, 'requires_confirmation': False, 'stale_inputs': False})
        stale_inputs = stage_input_hash(draft, stage) != job.input_hash
        return Response(serialize_generation(job, draft, requires_confirmation=bool(stale_inputs and job.manually_edited and job.has_generated_result), stale_inputs=stale_inputs))

    def post(self, request, draft_id, stage):
        if stage not in STAGE_ORDER:
            raise NotFound
        draft = self._draft(request, draft_id)
        retry = request.data.get('retry', False)
        replace_edited = request.data.get('replace_edited', False)
        if not isinstance(retry, bool) or not isinstance(replace_edited, bool):
            return Response({'error': 'Retry and replace_edited must be boolean values.'}, status=status.HTTP_400_BAD_REQUEST)
        if not stage_prerequisite_ready(draft, stage):
            return Response({'error': 'The previous stage must be saved before this report can be prepared.', 'code': 'prerequisite_pending'}, status=status.HTTP_409_CONFLICT)
        job, requires_confirmation = enqueue_stage_generation(draft.id, stage, retry=retry, replace_edited=replace_edited)
        draft.refresh_from_db()
        stale_inputs = stage_input_hash(draft, stage) != job.input_hash
        return Response(serialize_generation(job, draft, requires_confirmation=requires_confirmation, stale_inputs=stale_inputs), status=status.HTTP_202_ACCEPTED)


class RepositoryEvidenceSerializer(serializers.Serializer):
    file = serializers.CharField(max_length=240)
    line = serializers.IntegerField(required=False, allow_null=True, min_value=1)
    text = serializers.CharField(max_length=700, allow_blank=True)


class RepositoryFindingExplanationSerializer(serializers.Serializer):
    repository = serializers.CharField(max_length=160, allow_blank=True)
    title = serializers.CharField(max_length=180)
    category = serializers.CharField(max_length=80)
    severity = serializers.CharField(max_length=30)
    impact = serializers.CharField(max_length=1000, allow_blank=True)
    recommendation = serializers.CharField(max_length=1000, allow_blank=True)
    evidence = RepositoryEvidenceSerializer(many=True, allow_empty=False)

    def validate_evidence(self, value):
        if len(value) > 6:
            raise serializers.ValidationError('Provide no more than six evidence references.')
        return value


class RepositoryFindingExplanationView(APIView):
    """AI may clarify supplied deterministic evidence; it cannot create scan findings."""
    authentication_classes = []
    permission_classes = []
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'repository_ai'

    def post(self, request):
        serializer = RepositoryFindingExplanationSerializer(data=request.data)
        if not serializer.is_valid():
            return Response({'error': 'Provide a valid finding and its source evidence.', 'fields': serializer.errors}, status=status.HTTP_400_BAD_REQUEST)
        try:
            values = serializer.validated_data
            finding = {key: values[key] for key in ('title', 'category', 'severity', 'impact', 'recommendation', 'evidence')}
            explanation = explain_repository_finding(repository=values['repository'], finding=finding)
        except GeminiConfigurationError as error:
            return Response({'error': str(error), 'code': 'gemini_not_configured'}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        except GeminiRequestError as error:
            return Response({'error': str(error)}, status=status.HTTP_502_BAD_GATEWAY)
        return Response({'explanation': explanation}, status=status.HTTP_200_OK)


class ProjectRepositoryInputSerializer(serializers.Serializer):
    owner = serializers.CharField(max_length=160, required=False, allow_blank=True)
    repo_owner = serializers.CharField(max_length=160, required=False, allow_blank=True)
    name = serializers.CharField(max_length=160, required=False, allow_blank=True)
    repo_name = serializers.CharField(max_length=160, required=False, allow_blank=True)
    repo_url = serializers.CharField(max_length=500, required=False, allow_blank=True)
    selected_branch = serializers.CharField(max_length=160, required=False, allow_blank=True)
    connection_status = serializers.ChoiceField(
        choices=['connected', 'empty', 'sync_failed', 'disconnected'],
        default='connected'
    )
    last_synced_sha = serializers.CharField(max_length=64, required=False, allow_blank=True)
    last_synced_at = serializers.DateTimeField(required=False, allow_null=True)
    detected_technologies = serializers.ListField(
        child=serializers.DictField(),
        required=False,
        default=list
    )
    is_empty = serializers.BooleanField(required=False, default=False)

    def validate(self, attrs):
        owner = (attrs.get('repo_owner') or attrs.get('owner') or '').strip()
        name = (attrs.get('repo_name') or attrs.get('name') or '').strip()
        if not owner or not name:
            raise serializers.ValidationError('Both repository owner and repository name are required.')
        attrs['owner'] = owner
        attrs['name'] = name
        return attrs


class ProjectRepositoryView(APIView):
    """Manage GitHub repository association for a project draft."""

    def _drafts_for_request(self, request):
        return authorized_project_drafts(request)

    def get(self, request, draft_id):
        draft = get_object_or_404(self._drafts_for_request(request), pk=draft_id)
        if not hasattr(draft, 'repository') or not draft.repository:
            return Response({'error': 'No repository connected to this project.'}, status=status.HTTP_404_NOT_FOUND)
        return Response(ProjectRepositorySerializer(draft.repository).data, status=status.HTTP_200_OK)

    def post(self, request, draft_id):
        draft = get_object_or_404(self._drafts_for_request(request), pk=draft_id)
        serializer = ProjectRepositoryInputSerializer(data=request.data)
        if not serializer.is_valid():
            return Response({'error': 'Check the repository details and try again.', 'fields': serializer.errors}, status=status.HTTP_400_BAD_REQUEST)

        data = serializer.validated_data
        owner = data['owner']
        name = data['name']
        defaults = {
            'repo_owner': owner,
            'repo_name': name,
            'repo_full_name': f'{owner}/{name}',
            'repo_url': data.get('repo_url') or f'https://github.com/{owner}/{name}',
            'selected_branch': data.get('selected_branch', ''),
            'connection_status': data.get('connection_status', 'connected'),
            'last_synced_sha': data.get('last_synced_sha', ''),
            'last_synced_at': data.get('last_synced_at') or timezone.now(),
            'detected_technologies': data.get('detected_technologies', []),
            'is_empty': data.get('is_empty', False),
        }

        repo, created = ProjectRepository.objects.update_or_create(
            project=draft,
            defaults=defaults,
        )
        return Response(ProjectRepositorySerializer(repo).data, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)

    def delete(self, request, draft_id):
        draft = get_object_or_404(self._drafts_for_request(request), pk=draft_id)
        if hasattr(draft, 'repository') and draft.repository:
            draft.repository.delete()
            return Response({'message': 'Repository disconnected.'}, status=status.HTTP_200_OK)
        return Response({'error': 'No repository connected to this project.'}, status=status.HTTP_404_NOT_FOUND)


class UserRepositoriesView(APIView):
    """List connected repositories accessible to the requesting user."""

    def get(self, request):
        if request.user.is_authenticated:
            repos = ProjectRepository.objects.filter(project__in=authorized_project_drafts(request))
        else:
            repos = ProjectRepository.objects.filter(project__owner__isnull=True)
        return Response({'repositories': ProjectRepositorySerializer(repos, many=True).data}, status=status.HTTP_200_OK)


class ProjectRepositoryAnalysisView(APIView):
    """Save or retrieve the latest repository analysis for a project's repository."""

    def _drafts_for_request(self, request):
        return authorized_project_drafts(request)

    def get(self, request, draft_id):
        draft = get_object_or_404(self._drafts_for_request(request), pk=draft_id)
        if not hasattr(draft, 'repository') or not draft.repository:
            return Response({'error': 'No repository connected to this project.'}, status=status.HTTP_404_NOT_FOUND)
        return Response({
            'repository': ProjectRepositorySerializer(draft.repository).data,
            'analysis': draft.repository.latest_analysis,
        }, status=status.HTTP_200_OK)

    def post(self, request, draft_id):
        draft = get_object_or_404(self._drafts_for_request(request), pk=draft_id)
        if not hasattr(draft, 'repository') or not draft.repository:
            return Response({'error': 'No repository connected to this project.'}, status=status.HTTP_400_BAD_REQUEST)

        analysis = request.data.get('analysis')
        if not isinstance(analysis, dict):
            return Response({'error': 'Analysis data must be a dictionary object.'}, status=status.HTTP_400_BAD_REQUEST)

        repo = draft.repository
        repo.latest_analysis = analysis
        commit_sha = request.data.get('commit_sha') or analysis.get('revision')
        if commit_sha and isinstance(commit_sha, str):
            repo.last_synced_sha = commit_sha
        repo.last_synced_at = timezone.now()
        repo.save(update_fields=['latest_analysis', 'last_synced_sha', 'last_synced_at', 'updated_at'])

        return Response({
            'message': 'Repository analysis saved.',
            'repository': ProjectRepositorySerializer(repo).data,
        }, status=status.HTTP_200_OK)


class RoadmapCompareRepositoryView(APIView):
    """
    Compare the project's Flight Plan against actual repository evidence.
    Creates and persists a RoadmapAssessment record tied to a specific revision.
    """

    def _drafts_for_request(self, request):
        return authorized_project_drafts(request)

    def post(self, request, draft_id):
        draft = get_object_or_404(self._drafts_for_request(request), pk=draft_id)
        if not hasattr(draft, 'repository') or not draft.repository:
            return Response({
                'error': 'No repository is connected to this project. Connect a repository first.',
                'code': 'no_repository',
            }, status=status.HTTP_400_BAD_REQUEST)

        repo = draft.repository
        flight_plan = (draft.workflow or {}).get('flight_plan')
        if not flight_plan or not isinstance(flight_plan, dict) or not flight_plan.get('milestones'):
            # Fallback to starter plan if flight_plan not generated yet
            from .stage_generation import STAGE_ORDER
            flight_plan = {
                'summary': 'Roadmap for ' + str(draft.idea)[:60],
                'milestones': [
                    {
                        'title': 'Core implementation',
                        'tasks': ['Set up project and repository', 'Build core flow', 'Verify integration'],
                    }
                ],
            }

        # Allow caller to pass refreshed analysis, or use existing repo latest_analysis
        analysis = request.data.get('analysis') or repo.latest_analysis or {}
        commit_sha = request.data.get('commit_sha') or repo.last_synced_sha or analysis.get('revision') or ''

        repo_info = {
            'repo_owner': repo.repo_owner,
            'repo_name': repo.repo_name,
            'repo_full_name': repo.repo_full_name,
            'selected_branch': repo.selected_branch,
            'last_synced_sha': commit_sha,
            'is_empty': repo.is_empty or not analysis.get('evidenceFiles'),
        }

        # Run deterministic evidence matching
        comparison = compare_roadmap_with_repository(
            flight_plan=flight_plan,
            repository_info=repo_info,
            analysis=analysis,
            commit_sha=commit_sha,
        )

        # Persist RoadmapAssessment
        assessment = RoadmapAssessment.objects.create(
            project=draft,
            repository=repo,
            commit_sha=comparison['commit_sha'],
            branch=comparison['branch'],
            summary=comparison['summary'],
            task_assessments=comparison['task_assessments'],
            milestone_assessments=comparison['milestone_assessments'],
        )

        return Response(RoadmapAssessmentSerializer(assessment).data, status=status.HTTP_201_CREATED)


class RoadmapAssessmentView(APIView):
    """Retrieve the latest or revision-specific RoadmapAssessment for a project draft."""

    def _drafts_for_request(self, request):
        return authorized_project_drafts(request)

    def get(self, request, draft_id):
        draft = get_object_or_404(self._drafts_for_request(request), pk=draft_id)
        commit_sha = request.query_params.get('commit_sha')
        qs = draft.roadmap_assessments.all()
        if commit_sha:
            qs = qs.filter(commit_sha=commit_sha)
        assessment = qs.first()
        if not assessment:
            return Response({'error': 'No roadmap assessment found for this project.'}, status=status.HTTP_404_NOT_FOUND)
        return Response(RoadmapAssessmentSerializer(assessment).data, status=status.HTTP_200_OK)


class RoadmapTaskAssessmentCorrectionView(APIView):
    """
    Allow user to confirm, reject, or correct a proposed task assessment (keep human control).
    """

    def _drafts_for_request(self, request):
        return authorized_project_drafts(request)

    def patch(self, request, draft_id, task_id):
        draft = get_object_or_404(self._drafts_for_request(request), pk=draft_id)
        assessment = draft.roadmap_assessments.first()
        if not assessment:
            return Response({'error': 'No roadmap assessment exists to update.'}, status=status.HTTP_404_NOT_FOUND)

        task_assessments = dict(assessment.task_assessments or {})
        if task_id not in task_assessments:
            return Response({'error': f'Task {task_id} not found in assessment.'}, status=status.HTTP_404_NOT_FOUND)

        current = dict(task_assessments[task_id])
        new_status = request.data.get('status')
        valid_statuses = [
            'not_assessed', 'evidence_found', 'partially_implemented',
            'mismatch_detected', 'verified', 'manual_review',
        ]
        if new_status and new_status not in valid_statuses:
            return Response({'error': f'Status must be one of: {", ".join(valid_statuses)}'}, status=status.HTTP_400_BAD_REQUEST)

        # If user attempts to mark 'verified', ensure checks passed or user explicitly overrides with verified note
        if new_status == 'verified' and not request.data.get('verified_check_passed'):
            return Response({
                'error': 'Tasks can only be marked Verified if their acceptance criteria checks actually passed.',
                'code': 'unverified_forbidden',
            }, status=status.HTTP_400_BAD_REQUEST)

        user_override = {
            'status': new_status or current['status'],
            'notes': str(request.data.get('notes') or '').strip()[:500],
            'confirmed': bool(request.data.get('confirmed', True)),
            'timestamp': timezone.now().isoformat(),
        }

        if new_status:
            current['status'] = new_status
            status_labels = {
                'not_assessed': 'Not assessed',
                'evidence_found': 'Evidence found',
                'partially_implemented': 'Partially implemented',
                'mismatch_detected': 'Blocked or mismatch detected',
                'verified': 'Verified',
                'manual_review': 'Needs manual review',
            }
            current['statusLabel'] = status_labels.get(new_status, new_status)

        current['user_override'] = user_override
        task_assessments[task_id] = current
        assessment.task_assessments = task_assessments

        # Recalculate summary counts
        summary = dict(assessment.summary or {})
        counts = {s: 0 for s in valid_statuses}
        for item in task_assessments.values():
            st = item.get('status', 'not_assessed')
            counts[st] = counts.get(st, 0) + 1

        for s, c in counts.items():
            summary[f'{s}_count'] = c
        total = len(task_assessments)
        evidence_backed = counts['evidence_found'] + counts['partially_implemented']
        summary['evidence_percentage'] = round(evidence_backed / total * 100) if total else 0
        summary['verified_percentage'] = round(counts['verified'] / total * 100) if total else 0
        assessment.summary = summary

        assessment.save(update_fields=['task_assessments', 'summary', 'updated_at'])
        return Response(RoadmapAssessmentSerializer(assessment).data, status=status.HTTP_200_OK)


class RoadmapTaskExplanationSerializer(serializers.Serializer):
    repository = serializers.CharField(max_length=160, allow_blank=True, default='')
    task = serializers.DictField()
    assessment = serializers.DictField()


class RoadmapTaskExplanationView(APIView):
    """
    Explain a roadmap task assessment using Gemini, strictly grounded in provided deterministic evidence.
    """
    authentication_classes = []
    permission_classes = []
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'repository_ai'

    def post(self, request):
        serializer = RoadmapTaskExplanationSerializer(data=request.data)
        if not serializer.is_valid():
            return Response({'error': 'Provide valid task and assessment details.', 'fields': serializer.errors}, status=status.HTTP_400_BAD_REQUEST)

        values = serializer.validated_data
        try:
            explanation = explain_roadmap_task_assessment(
                repository=values['repository'],
                task=values['task'],
                assessment=values['assessment'],
            )
        except GeminiConfigurationError as error:
            return Response({'error': str(error), 'code': 'gemini_not_configured'}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        except GeminiRequestError as error:
            return Response({'error': str(error)}, status=status.HTTP_502_BAD_GATEWAY)

        return Response({'explanation': explanation}, status=status.HTTP_200_OK)


class ProjectReplanSerializer(serializers.Serializer):
    completed_task_ids = serializers.ListField(child=serializers.CharField(), required=False, default=list)
    start_date = serializers.DateField(required=False, allow_null=True)
    deadline = serializers.DateField(required=False, allow_null=True)
    team_size = serializers.IntegerField(min_value=1, required=False, allow_null=True)
    weekly_hours = serializers.IntegerField(min_value=1, max_value=168, required=False, allow_null=True)
    current_plan = serializers.JSONField(required=False, default=dict)


class ProjectReplanView(APIView):
    def _drafts_for_request(self, request):
        return authorized_project_drafts(request)

    def post(self, request, draft_id):
        draft = get_object_or_404(self._drafts_for_request(request), pk=draft_id)
        serializer = ProjectReplanSerializer(data=request.data)
        if not serializer.is_valid():
            return Response({'error': 'Invalid replan input.', 'fields': serializer.errors}, status=status.HTTP_400_BAD_REQUEST)

        data = serializer.validated_data
        completed_task_ids = data.get('completed_task_ids', [])
        start_date = data.get('start_date') or draft.start_date or timezone.now().date()
        deadline = data.get('deadline') or draft.deadline
        team_size = data.get('team_size') or draft.team_size or 1
        weekly_hours = data.get('weekly_hours') or draft.weekly_hours or 20

        if not deadline:
            return Response({'error': 'A project deadline is required to replan.'}, status=status.HTTP_400_BAD_REQUEST)
        if deadline <= start_date:
            return Response({'error': 'The deadline must be strictly after the start date.'}, status=status.HTTP_400_BAD_REQUEST)

        current_plan = data.get('current_plan') or (draft.workflow or {}).get('flight_plan') or {}
        
        project_details = {
            'understanding': draft.understanding or {},
            'feasibility': (draft.workflow or {}).get('feasibility') or {},
            'existing_flight_plan': current_plan,
            'completed_task_ids': completed_task_ids,
            'start_date': start_date.isoformat(),
            'deadline': deadline.isoformat(),
            'team_size': team_size,
            'weekly_hours': weekly_hours,
        }

        from .roadmap_scheduler import schedule_and_validate_flight_plan

        ai_plan = None
        try:
            ai_plan = generate_idea_stage(
                stage='flight_plan',
                idea=draft.idea,
                project_type=draft.project_type,
                project_details=project_details,
            )
        except Exception:
            pass

        base_plan = ai_plan or current_plan
        proposed_plan = schedule_and_validate_flight_plan(
            base_plan,
            start_date=start_date,
            deadline=deadline,
            team_size=team_size,
            weekly_hours=weekly_hours,
            completed_task_ids=completed_task_ids,
        )

        all_new_tasks = [t for m in proposed_plan.get('milestones', []) for t in m.get('tasks', [])]
        completed_count = len([t for t in all_new_tasks if t.get('id') in completed_task_ids or t.get('status') == 'completed'])
        rescheduled_count = len(all_new_tasks) - completed_count

        comparison = {
            'completed_tasks_preserved': completed_count,
            'remaining_tasks_rescheduled': rescheduled_count,
            'total_milestones': len(proposed_plan.get('milestones', [])),
            'deadline': deadline.isoformat(),
            'days_remaining': proposed_plan.get('schedule_assessment', {}).get('days_remaining', 0),
            'feasibility_status': proposed_plan.get('schedule_assessment', {}).get('feasibility_status', 'on_track'),
            'mvp_recommendations': proposed_plan.get('schedule_assessment', {}).get('mvp_recommendations', []),
            'deferred_features': proposed_plan.get('schedule_assessment', {}).get('deferred_features', []),
        }

        return Response({
            'proposed_plan': proposed_plan,
            'comparison': comparison,
        }, status=status.HTTP_200_OK)
