import json
import os
from unittest.mock import patch

from django.test import SimpleTestCase, TestCase
from rest_framework.test import APIClient
from apps.projects.models import ProjectDraft, ProjectRepository, RoadmapAssessment, ProjectLearningState, MarketingContentItem
from apps.teams.models import TeamMember
from apps.roadmaps.models import ProjectTask

from .gemini_service import GeminiConfigurationError, GeminiRequestError, _parse_json_candidate, generate_idea_stage, _validate_stage_result


def valid_result(stage):
    if stage == 'research':
        return {
            'market_problem_context': 'Context', 'existing_solutions_competitors': 'Unverified alternatives',
            'commonly_available_features': ['Search'], 'gaps_opportunities': ['Test an accessibility need'],
            'potential_users': ['Commuters'], 'research_questions': ['What do they use?'],
            'assumptions_to_verify': ['Riders have reliable mobile data.'],
            'recommended_validation_actions': ['Interview commuters'], 'preliminary_hypotheses': ['Availability may matter'],
            'sources': [], 'evidence_note': 'No live web research was performed; statements are unverified hypotheses.',
        }
    if stage == 'feasibility':
        return {
            'summary': 'Preliminary assessment', 'technical_feasibility': 'A simple web app appears buildable with common tools.',
            'advantages': ['Fast to prototype'], 'limitations': ['Demand is unknown'],
            'risks_and_mitigations': [{'risk': 'Data exposure', 'mitigation': 'Minimize stored data'}],
            'mvp_scope': {'essential_features': ['Request a ride'], 'postpone': ['Dynamic pricing'], 'scope_rationale': 'Focus on core flow.'},
            'resources_and_effort': 'A developer; estimate depends on team experience.',
            'validation_checklist': ['Test booking flow'], 'market_demand_note': 'Technical buildability does not validate demand.',
        }
    return {
        'summary': 'A short roadmap', 'milestones': [{
            'title': 'Requirements', 'category': 'Idea and Requirements', 'outcome': 'Scope defined',
            'tasks': [{'title': 'Define MVP', 'subtasks': ['List core flow'], 'dependencies': [], 'effort_estimate': '1-2 days', 'priority': 'high', 'acceptance_criteria': 'Scope documented', 'required_skills': ['Product'], 'suggested_role': 'Product lead'}],
        }],
    }


class GeminiWorkflowTests(SimpleTestCase):
    @patch.dict(os.environ, {'GEMINI_API_KEY': ''})
    def test_missing_gemini_key_returns_actionable_configuration_error(self):
        with self.assertRaisesRegex(GeminiConfigurationError, 'GEMINI_API_KEY'):
            generate_idea_stage(stage='research', idea='An idea', project_type='Startup', project_details={})

    @patch.dict(os.environ, {'GEMINI_API_KEY': ''})
    def test_missing_key_is_reported_as_service_unavailable(self):
        response = APIClient().post('/api/ideas/workflow-stage/', {
            'stage': 'research', 'idea': 'An idea', 'project_type': 'Startup',
        }, format='json')
        self.assertEqual(response.status_code, 503)
        self.assertIn('GEMINI_API_KEY', response.json()['error'])

    def test_parser_uses_final_text_not_thought_parts(self):
        result = _parse_json_candidate({
            'candidates': [{
                'content': {'parts': [
                    {'text': 'thinking through the idea', 'thought': True},
                    {'text': json.dumps({'summary': 'Focus', 'questions': [], 'assumptions': [], 'validation_steps': []})},
                ]},
                'finishReason': 'STOP',
            }],
        })
        self.assertEqual(result['summary'], 'Focus')

    @patch.dict(os.environ, {'GEMINI_API_KEY': 'test-key', 'GEMINI_MODEL': 'primary-model', 'GEMINI_FALLBACK_MODELS': 'fallback-model'})
    @patch('apps.core.gemini_service.time.sleep')
    @patch('apps.core.gemini_service._generate_content')
    def test_busy_primary_retries_then_uses_fallback(self, generate, _sleep):
        output = valid_result('research')
        body = {'candidates': [{'content': {'parts': [{'text': json.dumps(output)}]}, 'finishReason': 'STOP'}]}
        generate.side_effect = [GeminiRequestError('high demand', retryable=True), GeminiRequestError('still busy', retryable=True), body]
        result = generate_idea_stage(stage='research', idea='Taxi booking', project_type='Startup', project_details={})
        self.assertEqual(result, output)
        self.assertEqual([call.args[1] for call in generate.call_args_list], ['primary-model', 'primary-model', 'fallback-model'])

    @patch('apps.core.idea_views.generate_idea_stage')
    def test_each_stage_endpoint_returns_structured_result(self, generate):
        client = APIClient()
        for stage in ('research', 'feasibility', 'flight_plan'):
            generate.return_value = {'stage': stage, 'summary': 'editable draft'}
            response = client.post('/api/ideas/workflow-stage/', {
                'stage': stage,
                'idea': 'A taxi booking app',
                'project_type': 'Startup',
                'project_details': {'understanding': {'project_name': 'Taxi'}},
            }, format='json', HTTP_HOST='127.0.0.1')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['result']['stage'], stage)

    def test_stage_response_validation_rejects_incomplete_reports(self):
        for stage in ('research', 'feasibility', 'flight_plan'):
            _validate_stage_result(stage, valid_result(stage))
            with self.assertRaises(GeminiRequestError):
                _validate_stage_result(stage, {'summary': 'partial'})


class ProjectDraftPersistenceTests(TestCase):
    def test_draft_create_and_refresh_read(self):
        client = APIClient()
        import uuid
        draft_id = uuid.uuid4()
        payload = {
            'id': str(draft_id), 'idea': 'A taxi booking app', 'project_type': 'Startup',
            'understanding': {'project_name': 'Taxi'},
            'workflow': {'research': valid_result('research'), 'feasibility': valid_result('feasibility'), 'flight_plan': valid_result('flight_plan')},
            'current_stage': 'flight_plan',
        }
        saved = client.put(f'/api/projects/drafts/{draft_id}/', payload, format='json')
        self.assertEqual(saved.status_code, 201)
        loaded = client.get(f'/api/projects/drafts/{draft_id}/')
        self.assertEqual(loaded.status_code, 200)
        self.assertEqual(loaded.json()['workflow'], payload['workflow'])
        self.assertEqual(loaded.json()['current_stage'], 'flight_plan')

    def test_anonymous_cannot_access_account_owned_draft(self):
        from django.contrib.auth import get_user_model
        from apps.projects.models import ProjectDraft
        user = get_user_model().objects.create_user(username='owner', password='secret')
        draft = ProjectDraft.objects.create(owner=user, idea='Private plan', project_type='Startup')
        response = APIClient().get(f'/api/projects/drafts/{draft.id}/')
        self.assertEqual(response.status_code, 404)


class ProjectLearningTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.draft = ProjectDraft.objects.create(
            idea='Build a travel booking web app', project_type='College Project',
            understanding={'project_name': 'Travel planner', 'problem_statement': 'Make trip planning easier.'},
            workflow={'flight_plan': {'milestones': [{'title': 'Build API', 'tasks': [
                {'title': 'Create booking endpoint', 'required_skills': ['Django REST Framework'], 'acceptance_criteria': 'Endpoint returns a booking.'},
            ]}]}},
        )
        self.state_url = f'/api/projects/drafts/{self.draft.id}/learning/'

    def test_learning_state_is_created_and_progress_persists(self):
        initial = self.client.get(self.state_url)
        self.assertEqual(initial.status_code, 200)
        self.assertEqual(initial.json()['step_status'], {})
        update = self.client.put(self.state_url, {
            'step_status': {'rest-api-basics': 'completed'}, 'step_concepts': {'rest-api-basics': 'REST API basics'}, 'saved_resources': ['drf-quickstart'],
            'recently_viewed': ['drf-quickstart'], 'task_feedback': {'0-0': {'applied': True, 'worked': False}},
        }, format='json')
        self.assertEqual(update.status_code, 200)
        refreshed = self.client.get(self.state_url).json()
        self.assertEqual(refreshed['step_status']['rest-api-basics'], 'completed')
        self.assertEqual(refreshed['step_concepts']['rest-api-basics'], 'REST API basics')
        self.assertEqual(refreshed['saved_resources'], ['drf-quickstart'])
        self.assertTrue(refreshed['task_feedback']['0-0']['applied'])

    def test_invalid_learning_progress_is_rejected(self):
        response = self.client.put(self.state_url, {
            'step_status': {'step': 'done'}, 'step_concepts': {'step': 'Basics'}, 'saved_resources': [], 'recently_viewed': [], 'task_feedback': {},
        }, format='json')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(ProjectLearningState.objects.filter(project=self.draft).first().step_status, {})

    def test_learning_state_respects_project_owner(self):
        from django.contrib.auth import get_user_model
        owner = get_user_model().objects.create_user(username='learning-owner', password='secret')
        self.draft.owner = owner
        self.draft.save()
        self.assertEqual(APIClient().get(self.state_url).status_code, 404)
        owner_client = APIClient()
        owner_client.force_authenticate(owner)
        self.assertEqual(owner_client.get(self.state_url).status_code, 200)

    @patch('apps.core.idea_views.recommend_learning_path')
    def test_recommendations_use_a_real_saved_task_and_catalog_ids(self, recommend):
        recommend.return_value = [{'concept': 'REST endpoints', 'objective': 'Understand requests.', 'why': 'Supports this task.', 'prerequisites': [], 'resource_ids': ['drf-quickstart'], 'minutes': 30, 'exercise': 'Sketch a request.'}]
        url = f'/api/projects/drafts/{self.draft.id}/learning/recommendations/'
        response = self.client.post(url, {'task_key': '0-0', 'completed_concepts': ['HTTP basics'], 'resources': [{'id': 'drf-quickstart', 'title': 'Quickstart', 'topics': ['api']}]}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['task']['title'], 'Create booking endpoint')
        self.assertEqual(response.json()['steps'][0]['resource_ids'], ['drf-quickstart'])
        self.assertTrue(response.json()['steps'][0]['id'].startswith('learn-'))
        self.assertEqual(recommend.call_args.kwargs['resources'][0]['id'], 'drf-quickstart')
        self.assertEqual(recommend.call_args.kwargs['completed_concepts'], ['HTTP basics'])
        cached = self.client.post(url, {'task_key': '0-0', 'completed_concepts': ['HTTP basics'], 'resources': [{'id': 'drf-quickstart', 'title': 'Quickstart', 'topics': ['api']}]}, format='json')
        self.assertEqual(cached.status_code, 200)
        self.assertTrue(cached.json()['cached'])
        recommend.assert_called_once()

    def test_recommendations_reject_unknown_roadmap_task(self):
        url = f'/api/projects/drafts/{self.draft.id}/learning/recommendations/'
        response = self.client.post(url, {'task_key': '8-4', 'resources': []}, format='json')
        self.assertEqual(response.status_code, 404)

    @patch.dict(os.environ, {'GEMINI_API_KEY': ''})
    def test_tutor_reports_missing_gemini_without_breaking_learning_state(self):
        url = f'/api/projects/drafts/{self.draft.id}/learning/tutor/'
        response = self.client.post(url, {'question': 'What is an API?', 'level': 'beginner', 'task': {}}, format='json')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()['code'], 'gemini_unavailable')

    @patch('apps.core.idea_views.tutor_learning_question')
    def test_tutor_returns_validated_structured_answer(self, tutor):
        tutor.return_value = {'explanation': 'A web API.', 'example': 'GET /bookings', 'exercise': 'Trace a request.', 'quiz': []}
        url = f'/api/projects/drafts/{self.draft.id}/learning/tutor/'
        response = self.client.post(url, {'question': 'What is an API?', 'level': 'beginner', 'task': {'title': 'Create booking endpoint'}}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['answer']['explanation'], 'A web API.')

    def test_project_collection_does_not_list_anonymous_drafts(self):
        response = self.client.get('/api/projects/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['results'], [])

    def test_project_collection_lists_only_authenticated_users_saved_projects(self):
        from django.contrib.auth import get_user_model
        owner = get_user_model().objects.create_user(username='project-list-owner', password='secret')
        owned = ProjectDraft.objects.create(owner=owner, idea='Owner project', project_type='Startup', understanding={'project_name': 'Owned project'})
        ProjectDraft.objects.create(idea='Another browser draft', project_type='Startup')
        client = APIClient()
        client.force_authenticate(owner)
        response = client.get('/api/projects/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual([item['id'] for item in response.json()['results']], [str(owned.id)])


class TeamWorkspaceTests(TestCase):
    def make_project(self, size=3):
        workflow = {'flight_plan': {'milestones': [{'title': 'Build', 'target_date': '2026-12-01', 'tasks': [
            {'title': 'Build API', 'subtasks': ['Create endpoint'], 'effort_estimate': '2 days', 'priority': 'high', 'required_skills': ['Python'], 'acceptance_criteria': 'API responds.'},
            {'title': 'Build UI', 'effort_estimate': '5 hours', 'priority': 'medium'},
        ]}]}}
        return ProjectDraft.objects.create(idea='A team project', project_type='Startup', team_size=size,
            deadline='2026-12-15', understanding={'project_name': 'Team test'}, workflow=workflow)

    def test_default_workspace_has_only_the_creator_regardless_of_capacity(self):
        client = APIClient()
        for size in (1, 3, 5):
            project = self.make_project(size)
            for _ in range(2):
                response = client.get(f'/api/projects/drafts/{project.id}/team-workspace/')
                self.assertEqual(response.status_code, 200)
                self.assertEqual(len(response.json()['members']), 1)
                self.assertEqual(response.json()['project']['team_size'], size)
                self.assertEqual(response.json()['project']['joined_count'], 1)
            self.assertTrue(TeamMember.objects.get(project=project, slot=1).is_creator)
            self.assertEqual(TeamMember.objects.filter(project=project).count(), 1)

    def test_roadmap_sync_leaves_assignments_unchanged_until_a_review_is_approved(self):
        client = APIClient()
        project = self.make_project(3)
        workspace_url = f'/api/projects/drafts/{project.id}/team-workspace/'
        client.get(workspace_url)
        sync = client.post(workspace_url + 'sync-roadmap/', {'confirm': True}, format='json')
        self.assertEqual(sync.status_code, 200)
        self.assertEqual(ProjectTask.objects.filter(project=project, active=True).count(), 2)
        task = ProjectTask.objects.filter(project=project, active=True).first()
        self.assertIsNone(task.assigned_to_id)
        member = TeamMember.objects.get(project=project, is_creator=True)
        member.skills = ['Python']
        member.save(update_fields=['skills'])
        proposal = client.post(workspace_url + 'allocation-proposals/', {}, format='json')
        self.assertEqual(proposal.status_code, 201)
        task.refresh_from_db()
        self.assertIsNone(task.assigned_to_id)
        approved = client.post(workspace_url + f"allocation-proposals/{proposal.json()['id']}/approve/", {'assignments': [
            {'task_id': row['task_id'], 'member_id': member.id if row['task_id'] == task.id else None} for row in proposal.json()['assignments']
        ]}, format='json')
        self.assertEqual(approved.status_code, 200)
        task.refresh_from_db()
        self.assertEqual(task.assigned_to_id, member.id)
        response = client.patch(workspace_url + f'tasks/{task.id}/', {'status': 'completed', 'effort_hours': 8}, format='json')
        self.assertEqual(response.status_code, 200)
        persisted = client.get(workspace_url).json()
        self.assertEqual(sum(member['completed_tasks'] for member in persisted['members']), 1)
        self.assertEqual(next(t for t in persisted['tasks'] if t['id'] == task.id)['effort_hours'], 8)

    def test_changing_capacity_does_not_remove_joined_members_or_task_assignments(self):
        client = APIClient()
        project = self.make_project(3)
        workspace_url = f'/api/projects/drafts/{project.id}/team-workspace/'
        client.get(workspace_url)
        client.post(workspace_url + 'sync-roadmap/', {'confirm': True}, format='json')
        member_two = TeamMember.objects.create(project=project, slot=2, name='Accepted teammate', email='teammate@example.com')
        task = ProjectTask.objects.filter(project=project).first()
        task.assigned_to = member_two
        task.save(update_fields=['assigned_to'])
        response = client.patch(workspace_url, {'team_size': 1}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(TeamMember.objects.filter(project=project).count(), 2)
        task.refresh_from_db()
        self.assertEqual(task.assigned_to_id, member_two.id)

    def test_invitation_is_pending_until_secure_link_is_accepted_and_rejects_duplicates(self):
        client = APIClient()
        project = self.make_project(3)
        workspace_url = f'/api/projects/drafts/{project.id}/team-workspace/'
        response = client.post(workspace_url + 'invitations/', {'invitees': [
            {'email': 'member@example.com', 'name': 'Teammate', 'role': 'Designer', 'skills': ['Figma']},
            {'email': 'second@example.com'},
        ]}, format='json')
        self.assertEqual(response.status_code, 201)
        invitation = response.json()['invitations'][0]
        self.assertEqual(invitation['delivery'], 'link_only')
        self.assertTrue(invitation['invite_link'].startswith('http://127.0.0.1:5173/team/invite/'))
        self.assertEqual(TeamMember.objects.filter(project=project).count(), 1)
        workspace = client.get(workspace_url).json()
        self.assertEqual(len(workspace['members']), 1)
        self.assertEqual(len([item for item in workspace['invitations'] if item['status'] == 'pending']), 2)
        duplicate = client.post(workspace_url + 'invitations/', {'invitees': [{'email': 'MEMBER@example.com'}]}, format='json')
        self.assertEqual(duplicate.status_code, 409)
        token = invitation['invite_link'].rsplit('/', 1)[-1]
        public_url = f'/api/team/invitations/{token}/'
        self.assertEqual(client.get(public_url).status_code, 200)
        self.assertEqual(client.post(public_url, {'decision': 'accept'}, format='json').status_code, 401)
        from django.contrib.auth import get_user_model
        invitee = get_user_model().objects.create_user(username='member-invitee', email='member@example.com', password='safe-test-password')
        client.force_authenticate(invitee)
        accepted = client.post(public_url, {'decision': 'accept'}, format='json')
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(accepted.json()['status'], 'accepted')
        self.assertEqual(TeamMember.objects.filter(project=project).count(), 2)
        self.assertEqual(client.get(workspace_url).json()['project']['joined_count'], 2)

    def test_expired_invitation_cannot_be_accepted(self):
        from datetime import timedelta
        from django.utils import timezone
        from apps.teams.models import TeamInvitation
        client = APIClient()
        project = self.make_project(2)
        response = client.post(f'/api/projects/drafts/{project.id}/team-workspace/invitations/', {
            'invitees': [{'email': 'late@example.com'}],
        }, format='json')
        invitation = TeamInvitation.objects.get(project=project)
        invitation.expires_at = timezone.now() - timedelta(seconds=1)
        invitation.save(update_fields=['expires_at'])
        token = response.json()['invitations'][0]['invite_link'].rsplit('/', 1)[-1]
        public_url = f'/api/team/invitations/{token}/'
        self.assertEqual(client.get(public_url).status_code, 410)
        self.assertEqual(client.post(public_url, {'decision': 'accept'}, format='json').status_code, 410)
        self.assertEqual(TeamMember.objects.filter(project=project).count(), 1)

    def test_declining_an_invitation_does_not_create_a_member(self):
        from apps.teams.models import TeamInvitation
        client = APIClient()
        project = self.make_project(2)
        response = client.post(f'/api/projects/drafts/{project.id}/team-workspace/invitations/', {
            'invitees': [{'email': 'decline@example.com'}],
        }, format='json')
        token = response.json()['invitations'][0]['invite_link'].rsplit('/', 1)[-1]
        declined = client.post(f'/api/team/invitations/{token}/', {'decision': 'decline'}, format='json')
        self.assertEqual(declined.json()['status'], 'declined')
        self.assertEqual(TeamMember.objects.filter(project=project).count(), 1)
        self.assertEqual(TeamInvitation.objects.get(project=project).status, 'declined')

    def test_member_details_persist_and_member_removal_requires_task_reassignment(self):
        client = APIClient()
        project = self.make_project(3)
        base = f'/api/projects/drafts/{project.id}/team-workspace/'
        invited = client.post(base + 'invitations/', {'invitees': [{'email': 'designer@example.com'}]}, format='json')
        token = invited.json()['invitations'][0]['invite_link'].rsplit('/', 1)[-1]
        from django.contrib.auth import get_user_model
        invitee = get_user_model().objects.create_user(username='designer-invitee', email='designer@example.com', password='safe-test-password')
        client.force_authenticate(invitee)
        accepted = client.post(f'/api/team/invitations/{token}/', {'decision': 'accept'}, format='json')
        member_id = accepted.json()['member']['id']
        saved = client.patch(base + f'members/{member_id}/', {
            'name': 'Asha', 'role': 'Product designer', 'skills': ['Figma', 'Research'],
        }, format='json')
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(client.get(base).json()['members'][1]['name'], 'Asha')
        client.post(base + 'sync-roadmap/', {'confirm': True}, format='json')
        task = ProjectTask.objects.filter(project=project, active=True).first()
        client.patch(base + f'tasks/{task.id}/', {'assigned_to': member_id}, format='json')
        blocked = client.delete(base + f'members/{member_id}/')
        self.assertEqual(blocked.status_code, 409)
        for assigned_task in ProjectTask.objects.filter(project=project, active=True, assigned_to_id=member_id):
            client.patch(base + f'tasks/{assigned_task.id}/', {'assigned_to': None}, format='json')
        removed = client.delete(base + f'members/{member_id}/')
        self.assertEqual(removed.status_code, 204)
        task.refresh_from_db()
        self.assertIsNone(task.assigned_to_id)
        client.force_authenticate(user=None)
        final_workspace = client.get(base).json()
        self.assertEqual(final_workspace['project']['team_size'], 3)
        self.assertEqual(len(final_workspace['members']), 1)

    def test_capacity_reserves_pending_invitations_and_cancel_frees_it(self):
        client = APIClient()
        project = self.make_project(2)
        url = f'/api/projects/drafts/{project.id}/team-workspace/'
        sent = client.post(url + 'invitations/', {'invitees': [{'email': 'only-slot@example.com'}]}, format='json')
        self.assertEqual(sent.status_code, 201)
        full = client.post(url + 'invitations/', {'invitees': [{'email': 'too-many@example.com'}]}, format='json')
        self.assertEqual(full.status_code, 409)
        self.assertEqual(full.json()['code'], 'capacity_exceeded')
        invitation_id = sent.json()['invitations'][0]['id']
        self.assertEqual(client.delete(url + f'invitations/{invitation_id}/').status_code, 204)
        next_invite = client.post(url + 'invitations/', {'invitees': [{'email': 'next@example.com'}]}, format='json')
        self.assertEqual(next_invite.status_code, 201)

    def test_resend_rotates_secure_token_and_returns_a_new_link_without_mail(self):
        client = APIClient()
        project = self.make_project(2)
        base = f'/api/projects/drafts/{project.id}/team-workspace/invitations/'
        created = client.post(base, {'invitees': [{'email': 'resend@example.com'}]}, format='json')
        invitation = created.json()['invitations'][0]
        refreshed = client.post(base + f"{invitation['id']}/", {}, format='json')
        self.assertEqual(refreshed.status_code, 200)
        self.assertEqual(refreshed.json()['delivery'], 'link_only')
        old_token = invitation['invite_link'].rsplit('/', 1)[-1]
        new_token = refreshed.json()['invite_link'].rsplit('/', 1)[-1]
        self.assertNotEqual(old_token, new_token)
        self.assertEqual(client.get(f'/api/team/invitations/{old_token}/').status_code, 404)
        self.assertEqual(client.get(f'/api/team/invitations/{new_token}/').status_code, 200)

    @patch('apps.core.team_workspace.send_mail', return_value=1)
    @patch.dict(os.environ, {'EMAIL_HOST': 'smtp.example.test', 'DEFAULT_FROM_EMAIL': 'team@example.test'})
    def test_configured_mail_delivery_is_reported_only_after_backend_succeeds(self, send_mail):
        from django.test import override_settings
        client = APIClient()
        project = self.make_project(2)
        with override_settings(EMAIL_BACKEND='django.core.mail.backends.smtp.EmailBackend', EMAIL_HOST='smtp.example.test', DEFAULT_FROM_EMAIL='team@example.test'):
            response = client.post(f'/api/projects/drafts/{project.id}/team-workspace/invitations/', {
                'invitees': [{'email': 'mail@example.com'}],
            }, format='json')
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()['invitations'][0]['delivery'], 'sent')
        send_mail.assert_called_once()

    @patch('apps.core.team_workspace.send_mail', side_effect=OSError('SMTP unavailable'))
    def test_failed_email_delivery_returns_link_without_claiming_sent(self, _send_mail):
        from django.test import override_settings
        client = APIClient()
        project = self.make_project(2)
        with override_settings(EMAIL_BACKEND='django.core.mail.backends.smtp.EmailBackend', EMAIL_HOST='smtp.example.test', DEFAULT_FROM_EMAIL='team@example.test'):
            response = client.post(f'/api/projects/drafts/{project.id}/team-workspace/invitations/', {
                'invitees': [{'email': 'delivery-fail@example.com'}],
            }, format='json')
        invite = response.json()['invitations'][0]
        self.assertEqual(response.status_code, 201)
        self.assertEqual(invite['delivery'], 'failed')
        self.assertTrue(invite['invite_link'])

    def test_authenticated_team_members_can_read_project_but_unrelated_users_cannot(self):
        from django.contrib.auth import get_user_model
        project = self.make_project(2)
        owner_client = APIClient()
        invitation = owner_client.post(f'/api/projects/drafts/{project.id}/team-workspace/invitations/', {'invitees': [{'email': 'joiner@example.com'}]}, format='json').json()['invitations'][0]
        token = invitation['invite_link'].rsplit('/', 1)[-1]
        joiner = get_user_model().objects.create_user(username='authorized-joiner', email='joiner@example.com')
        joined_client = APIClient()
        joined_client.force_authenticate(joiner)
        accepted = joined_client.post(f'/api/team/invitations/{token}/', {'decision': 'accept'}, format='json')
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(joined_client.get(f'/api/projects/drafts/{project.id}/').status_code, 200)
        self.assertEqual(joined_client.get(f'/api/projects/drafts/{project.id}/team-workspace/').status_code, 200)
        outsider = get_user_model().objects.create_user(username='unauthorized-outsider')
        outsider_client = APIClient()
        outsider_client.force_authenticate(outsider)
        self.assertEqual(outsider_client.get(f'/api/projects/drafts/{project.id}/team-workspace/').status_code, 404)

    def test_allocation_proposal_stales_after_team_changes_without_modifying_tasks(self):
        from apps.teams.models import TeamMember
        project = self.make_project(3)
        base = f'/api/projects/drafts/{project.id}/team-workspace/'
        client = APIClient()
        client.get(base)
        client.post(base + 'sync-roadmap/', {'confirm': True}, format='json')
        proposal = client.post(base + 'allocation-proposals/', {}, format='json')
        self.assertEqual(proposal.status_code, 201)
        task = ProjectTask.objects.filter(project=project, active=True).first()
        self.assertIsNone(task.assigned_to_id)
        TeamMember.objects.create(project=project, slot=2, name='New teammate', skills=['Python'])
        rejected = client.post(base + f"allocation-proposals/{proposal.json()['id']}/approve/", {}, format='json')
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.json()['code'], 'proposal_stale')
        task.refresh_from_db()
        self.assertIsNone(task.assigned_to_id)

    def test_authenticated_owner_access_is_scoped_to_account(self):
        from django.contrib.auth import get_user_model
        from apps.projects.models import ProjectDraft
        users = get_user_model().objects
        owner = users.create_user(username='draft-owner', password='secret')
        other = users.create_user(username='other-user', password='secret')
        draft = ProjectDraft.objects.create(owner=owner, idea='Owner draft', project_type='Startup')
        owner_client = APIClient()
        owner_client.force_authenticate(user=owner)
        other_client = APIClient()
        other_client.force_authenticate(user=other)
        self.assertEqual(owner_client.get(f'/api/projects/drafts/{draft.id}/').status_code, 200)
        self.assertEqual(other_client.get(f'/api/projects/drafts/{draft.id}/').status_code, 404)

    def test_authenticated_github_user_session_csrf_access_to_team_workspace(self):
        from django.test import Client
        from django.contrib.auth import get_user_model
        user = get_user_model().objects.create_user(username='github-999999', email='ashvek@example.com')
        project = self.make_project(3)
        project.owner = user
        project.save(update_fields=['owner'])

        client = Client(enforce_csrf_checks=True, headers={'host': '127.0.0.1:8000'})
        client.force_login(user)

        workspace_url = f'/api/projects/drafts/{project.id}/team-workspace/'
        get_res = client.get(workspace_url)
        self.assertEqual(get_res.status_code, 200)
        self.assertTrue(get_res.json()['project']['is_owner'])
        csrf_cookie = client.cookies.get('csrftoken')
        self.assertIsNotNone(csrf_cookie)
        token = csrf_cookie.value
        self.assertTrue(bool(token))

        post_url = workspace_url + 'sync-roadmap/'
        no_csrf_res = client.post(post_url, {'preview': True}, content_type='application/json')
        self.assertEqual(no_csrf_res.status_code, 403)
        self.assertIn('CSRF', str(no_csrf_res.content))

        csrf_res = client.post(post_url, {'preview': True}, content_type='application/json', HTTP_X_CSRFTOKEN=token)
        self.assertEqual(csrf_res.status_code, 200)

    def test_joined_member_can_access_workspace_and_sync_preview_but_cannot_invite_or_approve(self):
        from django.test import Client
        from django.contrib.auth import get_user_model
        from apps.core.team_workspace import create_invitation
        owner = get_user_model().objects.create_user(username='owner-user', email='owner@example.com')
        joiner = get_user_model().objects.create_user(username='github-joiner', email='joiner@example.com')
        project = self.make_project(3)
        project.owner = owner
        project.save(update_fields=['owner'])

        invitation = create_invitation(project, None, {'email': 'joiner@example.com', 'name': 'Joiner'})
        token = invitation['invite_link'].rsplit('/', 1)[-1]
        joiner_client = Client(headers={'host': '127.0.0.1:8000'})
        joiner_client.force_login(joiner)
        accept_res = joiner_client.post(f'/api/team/invitations/{token}/', {'decision': 'accept'}, content_type='application/json')
        self.assertEqual(accept_res.status_code, 200)

        workspace_url = f'/api/projects/drafts/{project.id}/team-workspace/'
        res = joiner_client.get(workspace_url)
        self.assertEqual(res.status_code, 200)
        self.assertFalse(res.json()['project']['is_owner'])

        sync_res = joiner_client.post(workspace_url + 'sync-roadmap/', {'preview': True}, content_type='application/json')
        self.assertEqual(sync_res.status_code, 200)

        patch_res = joiner_client.patch(workspace_url, {'team_size': 5}, content_type='application/json')
        self.assertEqual(patch_res.status_code, 403)
        self.assertEqual(patch_res.json()['code'], 'permission_denied')

        invite_res = joiner_client.post(workspace_url + 'invitations/', {'invitees': [{'email': 'other@example.com'}]}, content_type='application/json')
        self.assertEqual(invite_res.status_code, 403)
        self.assertEqual(invite_res.json()['code'], 'permission_denied')

    def test_auth_csrf_endpoint_provides_token_and_sets_cookie(self):
        from django.test import Client
        client = Client(enforce_csrf_checks=True, headers={'host': '127.0.0.1:8000'})
        res = client.get('/api/auth/csrf/')
        self.assertEqual(res.status_code, 200)
        token = res.json().get('csrf_token')
        self.assertTrue(bool(token))
        cookie = client.cookies.get('csrftoken')
        self.assertIsNotNone(cookie)
        self.assertTrue(bool(cookie.value))
        # Ensure token works for mutating requests under CSRF enforcement
        logout_res = client.post('/api/auth/logout/', HTTP_X_CSRFTOKEN=token)
        self.assertEqual(logout_res.status_code, 200)

    @patch('apps.core.idea_views.generate_idea_stage')
    def test_ai_stage_uses_the_saved_project_context(self, generate):
        import uuid
        draft_id = uuid.uuid4()
        client = APIClient()
        client.put(f'/api/projects/drafts/{draft_id}/', {
            'idea': 'Saved idea', 'project_type': 'College Project',
            'understanding': {'project_name': 'Saved name'},
            'workflow': {'research': {'research_questions': ['Edited question']}},
            'current_stage': 'research',
        }, format='json')
        generate.return_value = valid_result('feasibility')
        response = client.post('/api/ideas/workflow-stage/', {
            'stage': 'feasibility', 'project_id': str(draft_id),
            'idea': 'stale submitted idea', 'project_type': 'Startup',
            'project_details': {'understanding': {'project_name': 'Stale name'}},
        }, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(generate.call_args.kwargs['idea'], 'Saved idea')
        self.assertEqual(generate.call_args.kwargs['project_type'], 'College Project')
        self.assertEqual(generate.call_args.kwargs['project_details']['understanding']['project_name'], 'Saved name')
        self.assertEqual(generate.call_args.kwargs['project_details']['research']['research_questions'], ['Edited question'])


class BackgroundStageGenerationTests(TestCase):
    def setUp(self):
        from apps.projects.models import ProjectDraft
        self.draft = ProjectDraft.objects.create(
            idea='Taxi booking for commuters', project_type='Startup',
            understanding={'project_name': 'Taxi', 'problem_statement': 'Booking friction', 'target_users': 'Commuters', 'expected_outcome': 'Easy booking'},
        )
        self.client = APIClient()

    def endpoint(self, stage):
        return f'/api/projects/drafts/{self.draft.id}/stages/{stage}/generation/'

    def test_queue_endpoint_is_idempotent_across_repeated_requests(self):
        from apps.projects.models import ProjectStageGeneration
        first = self.client.post(self.endpoint('research'), {}, format='json')
        second = self.client.post(self.endpoint('research'), {}, format='json')
        self.assertEqual(first.status_code, 202)
        self.assertEqual(second.status_code, 202)
        self.assertEqual(first.json()['status'], 'queued')
        self.assertEqual(ProjectStageGeneration.objects.filter(project=self.draft, stage='research').count(), 1)

    def test_downstream_generation_waits_for_saved_upstream_content(self):
        response = self.client.post(self.endpoint('feasibility'), {}, format='json')
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()['code'], 'prerequisite_pending')

    @patch('apps.core.stage_generation.generate_idea_stage')
    def test_worker_persists_research_and_queues_feasibility(self, generate):
        from apps.core.stage_generation import claim_next_job, enqueue_stage_generation, process_generation_job
        from apps.projects.models import ProjectStageGeneration
        generate.return_value = valid_result('research')
        job, _ = enqueue_stage_generation(self.draft.id, 'research')
        process_generation_job(claim_next_job())
        self.draft.refresh_from_db()
        job.refresh_from_db()
        self.assertEqual(job.status, 'completed')
        self.assertEqual(self.draft.workflow['research'], valid_result('research'))
        self.assertEqual(ProjectStageGeneration.objects.get(project=self.draft, stage='feasibility').status, 'queued')

    @patch('apps.core.stage_generation.generate_idea_stage')
    def test_first_generated_result_preserves_preexisting_manual_fields(self, generate):
        from apps.core.stage_generation import enqueue_stage_generation, run_worker
        from apps.projects.models import ProjectStageGeneration
        draft_id = self.draft.id
        response = self.client.put(self.endpoint('research').replace(f'/stages/research/generation/', '/'), {
            'idea': self.draft.idea, 'project_type': self.draft.project_type,
            'understanding': self.draft.understanding,
            'workflow': {'research': {**valid_result('research'), 'research_questions': ['My question']}},
            'current_stage': 'research', 'edited_stages': ['research'],
        }, format='json')
        self.assertEqual(response.status_code, 200)
        job, _ = enqueue_stage_generation(draft_id, 'research')
        generate.return_value = valid_result('research')
        run_worker(once=True)
        self.draft.refresh_from_db()
        job.refresh_from_db()
        self.assertEqual(job.status, 'completed')
        self.assertEqual(self.draft.workflow['research']['research_questions'], ['My question'])

    def test_upstream_changes_mark_dependent_generation_stale(self):
        from apps.core.stage_generation import enqueue_stage_generation
        from apps.projects.models import ProjectStageGeneration
        self.draft.workflow = {'research': valid_result('research'), 'feasibility': valid_result('feasibility')}
        self.draft.save(update_fields=['workflow'])
        job, _ = enqueue_stage_generation(self.draft.id, 'feasibility')
        job.status = 'completed'
        job.has_generated_result = True
        job.save()
        payload = {
            'idea': self.draft.idea, 'project_type': self.draft.project_type,
            'understanding': self.draft.understanding,
            'workflow': {'research': {**valid_result('research'), 'research_questions': ['Changed question']}, 'feasibility': valid_result('feasibility')},
            'current_stage': 'research', 'edited_stages': ['research'],
        }
        response = self.client.put(f'/api/projects/drafts/{self.draft.id}/', payload, format='json')
        self.assertEqual(response.status_code, 200)
        job.refresh_from_db()
        self.assertEqual(job.status, 'stale')
        self.assertEqual(response.json()['workflow']['feasibility'], valid_result('feasibility'))

    def test_status_survives_refresh_and_failed_jobs_can_be_retried(self):
        from apps.core.stage_generation import enqueue_stage_generation
        from apps.projects.models import ProjectStageGeneration
        job, _ = enqueue_stage_generation(self.draft.id, 'research')
        job.status = 'failed'; job.error = 'temporary'; job.save()
        self.assertEqual(self.client.get(self.endpoint('research')).json()['status'], 'failed')
        response = self.client.post(self.endpoint('research'), {'retry': True}, format='json')
        job.refresh_from_db()
        self.assertEqual(response.status_code, 202)
        self.assertEqual(job.status, 'queued')

    def test_edited_report_requires_confirmation_before_replacement(self):
        from apps.core.stage_generation import stage_input_hash, stage_target_hash
        from apps.projects.models import ProjectStageGeneration
        self.draft.workflow = {'research': valid_result('research')}
        self.draft.save(update_fields=['workflow'])
        ProjectStageGeneration.objects.create(
            project=self.draft, stage='research', status='stale', manually_edited=True,
            has_generated_result=True, input_hash=stage_input_hash(self.draft, 'research'),
            target_hash=stage_target_hash(self.draft, 'research'),
        )
        response = self.client.post(self.endpoint('research'), {}, format='json')
        self.assertTrue(response.json()['requires_confirmation'])
        self.assertEqual(response.json()['status'], 'stale')
        approved = self.client.post(self.endpoint('research'), {'replace_edited': True}, format='json')
        self.assertEqual(approved.json()['status'], 'queued')

    @patch('apps.core.stage_generation.generate_idea_stage')
    def test_worker_chains_feasibility_into_flight_plan(self, generate):
        from apps.core.stage_generation import claim_next_job, enqueue_stage_generation, process_generation_job
        from apps.projects.models import ProjectStageGeneration
        generate.side_effect = [valid_result('research'), valid_result('feasibility'), valid_result('flight_plan')]
        enqueue_stage_generation(self.draft.id, 'research')
        for _ in range(3):
            process_generation_job(claim_next_job())
        self.draft.refresh_from_db()
        self.assertTrue(all(stage in self.draft.workflow for stage in ('research', 'feasibility', 'flight_plan')))
        self.assertTrue(all(ProjectStageGeneration.objects.get(project=self.draft, stage=stage).status == 'completed' for stage in ('research', 'feasibility', 'flight_plan')))
        self.assertEqual([call.kwargs['stage'] for call in generate.call_args_list], ['research', 'feasibility', 'flight_plan'])


class RepositoryFindingExplanationTests(SimpleTestCase):
    endpoint = '/api/repository/explain-finding/'

    def setUp(self):
        # ScopedRateThrottle uses the Django cache; clear it before each test
        # so the 5/hour limit is not consumed across test methods in one run.
        from django.core.cache import cache
        cache.clear()

    @patch('apps.core.idea_views.explain_repository_finding')
    def test_explanation_uses_only_bounded_supplied_evidence(self, explain):
        explain.return_value = {'explanation': 'The route is absent.', 'proposed_fix': 'Add the endpoint.', 'verification': 'Make a GET request.'}
        response = APIClient().post(self.endpoint, {
            'repository': 'sample/app', 'title': 'Missing route', 'category': 'Integration', 'severity': 'high',
            'impact': 'Likely 404', 'recommendation': 'Align the route',
            'evidence': [{'file': 'frontend/src/service.js', 'line': 4, 'text': 'GET /api/items/'}],
        }, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['explanation']['proposed_fix'], 'Add the endpoint.')

    def test_rejects_more_than_six_evidence_references(self):
        response = APIClient().post(self.endpoint, {
            'repository': 'sample/app', 'title': 'Finding', 'category': 'Integration', 'severity': 'medium',
            'impact': '', 'recommendation': '',
            'evidence': [{'file': 'file.py', 'line': index + 1, 'text': 'evidence'} for index in range(7)],
        }, format='json')
        self.assertEqual(response.status_code, 400)

    @patch.dict(os.environ, {'GEMINI_API_KEY': ''})
    def test_missing_gemini_key_leaves_deterministic_results_available(self):
        response = APIClient().post(self.endpoint, {
            'repository': 'sample/app', 'title': 'Finding', 'category': 'Integration', 'severity': 'medium',
            'impact': '', 'recommendation': '', 'evidence': [{'file': 'file.py', 'line': 1, 'text': 'evidence'}],
        }, format='json')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()['code'], 'gemini_not_configured')

    def test_missing_required_fields_returns_400(self):
        # Omit 'title' and 'evidence'; both are required by the serializer.
        response = APIClient().post(self.endpoint, {
            'repository': 'sample/app', 'category': 'Integration', 'severity': 'high',
            'impact': 'Likely 404', 'recommendation': 'Fix it',
        }, format='json')
        self.assertEqual(response.status_code, 400)
        self.assertIn('fields', response.json())
        self.assertIn('title', response.json()['fields'])

    def test_empty_evidence_list_returns_400(self):
        response = APIClient().post(self.endpoint, {
            'repository': 'sample/app', 'title': 'Finding', 'category': 'Integration', 'severity': 'medium',
            'impact': '', 'recommendation': '', 'evidence': [],
        }, format='json')
        self.assertEqual(response.status_code, 400)

    @patch('apps.core.idea_views.explain_repository_finding')
    def test_gemini_api_failure_returns_502(self, explain):
        explain.side_effect = GeminiRequestError('Upstream API error', retryable=False)
        response = APIClient().post(self.endpoint, {
            'repository': 'sample/app', 'title': 'Missing route', 'category': 'Integration', 'severity': 'high',
            'impact': 'Likely 404', 'recommendation': 'Align the route',
            'evidence': [{'file': 'frontend/src/service.js', 'line': 4, 'text': 'GET /api/items/'}],
        }, format='json')
        self.assertEqual(response.status_code, 502)
        self.assertIn('error', response.json())


class GeminiPayloadFormatTests(SimpleTestCase):
    """Regression tests locking the Gemini REST API payload format.

    The v1beta generateContent API requires responseMimeType and responseSchema
    as flat keys inside generationConfig. An earlier version used an invalid
    responseFormat.text.mimeType nesting with APPLICATION_JSON (uppercase), which
    the API silently ignored, leaving structured output enforcement disabled.
    """

    def _capture_payload(self, stage='research'):
        """Return the generationConfig captured from a mocked _generate_content call."""
        output = valid_result(stage)
        body = {'candidates': [{'content': {'parts': [{'text': json.dumps(output)}]}, 'finishReason': 'STOP'}]}
        captured = {}
        def fake_generate(payload, model, api_key):
            captured['payload'] = payload
            return body
        with patch.dict(os.environ, {'GEMINI_API_KEY': 'test-key'}):
            with patch('apps.core.gemini_service._generate_content', side_effect=fake_generate):
                from .gemini_service import generate_idea_stage
                generate_idea_stage(stage=stage, idea='Taxi app', project_type='Startup', project_details={})
        return captured['payload']

    def test_generationConfig_uses_responseMimeType_not_responseFormat(self):
        config = self._capture_payload('research').get('generationConfig', {})
        self.assertEqual(config.get('responseMimeType'), 'application/json',
                         'responseMimeType must be lowercase application/json (Gemini v1beta REST)')
        self.assertNotIn('responseFormat', config,
                         'responseFormat is not a valid Gemini API field; use responseMimeType + responseSchema')

    def test_generationConfig_includes_responseSchema(self):
        config = self._capture_payload('research').get('generationConfig', {})
        self.assertIn('responseSchema', config)
        self.assertIsInstance(config['responseSchema'], dict)

    def test_mime_type_is_lowercase(self):
        """APPLICATION_JSON (uppercase) is not a valid MIME type."""
        mime = self._capture_payload('feasibility').get('generationConfig', {}).get('responseMimeType', '')
        self.assertEqual(mime, mime.lower())

    @patch.dict(os.environ, {'GEMINI_API_KEY': 'test-key'})
    @patch('apps.core.gemini_service._generate_content')
    def test_explain_finding_payload_uses_correct_format(self, generate):
        from .gemini_service import explain_repository_finding
        output = {'explanation': 'No route.', 'proposed_fix': 'Add it.', 'verification': 'Hit the endpoint.'}
        body = {'candidates': [{'content': {'parts': [{'text': json.dumps(output)}]}, 'finishReason': 'STOP'}]}
        captured = {}
        def fake_generate(payload, model, api_key):
            captured['payload'] = payload
            return body
        generate.side_effect = fake_generate
        explain_repository_finding(
            repository='owner/repo',
            finding={'title': 'Missing route', 'category': 'Integration', 'severity': 'high',
                     'impact': 'Likely 404', 'recommendation': 'Fix it',
                     'evidence': [{'file': 'service.js', 'line': 4, 'text': 'GET /api/items/'}]},
        )
        config = captured['payload'].get('generationConfig', {})
        self.assertEqual(config.get('responseMimeType'), 'application/json')
        self.assertNotIn('responseFormat', config)
        self.assertIn('responseSchema', config)


class GeminiTaskAllocationTests(SimpleTestCase):
    @patch.dict(os.environ, {'GEMINI_API_KEY': 'test-key', 'GEMINI_MODEL': 'test-model', 'GEMINI_FALLBACK_MODELS': ''})
    @patch('apps.core.gemini_service._generate_content')
    def test_structured_allocation_is_validated_against_real_task_and_member_ids(self, generate):
        from .gemini_service import generate_task_allocation
        output = {'summary': 'Skills match.', 'assignments': [{'task_id': 10, 'member_id': 3, 'reason': 'Python skill match.', 'matched_skills': ['Python'], 'skill_gaps': []}]}
        generate.return_value = {'candidates': [{'content': {'parts': [{'text': json.dumps(output)}]}, 'finishReason': 'STOP'}]}
        result = generate_task_allocation(project={'name': 'Demo'}, tasks=[{'id': 10, 'title': 'Build API'}], members=[{'id': 3, 'skills': ['Python']}])
        self.assertEqual(result['assignments'][0]['member_id'], 3)
        config = generate.call_args.args[0]['generationConfig']
        self.assertEqual(config['responseMimeType'], 'application/json')
        self.assertIn('responseSchema', config)

    @patch.dict(os.environ, {'GEMINI_API_KEY': 'test-key', 'GEMINI_MODEL': 'test-model', 'GEMINI_FALLBACK_MODELS': ''})
    @patch('apps.core.gemini_service._generate_content')
    def test_gemini_cannot_assign_a_non_member(self, generate):
        from .gemini_service import generate_task_allocation
        output = {'summary': 'Suggested.', 'assignments': [{'task_id': 10, 'member_id': 999, 'reason': 'Match.', 'matched_skills': [], 'skill_gaps': []}]}
        generate.return_value = {'candidates': [{'content': {'parts': [{'text': json.dumps(output)}]}, 'finishReason': 'STOP'}]}
        with self.assertRaisesRegex(GeminiRequestError, 'member who has not joined'):
            generate_task_allocation(project={}, tasks=[{'id': 10}], members=[{'id': 3}])


class ProjectRepositoryAssociationTests(TestCase):
    def setUp(self):
        from apps.projects.models import ProjectDraft, ProjectRepository
        self.draft = ProjectDraft.objects.create(
            idea='A platform for independent mechanics',
            project_type='Startup',
            understanding={'project_name': 'Wrench', 'problem_statement': 'Finding parts'},
        )
        self.client = APIClient()

    def test_associate_repository_to_anonymous_draft(self):
        response = self.client.post(f'/api/projects/drafts/{self.draft.id}/repository/', {
            'owner': 'octocat',
            'name': 'Spoon-Knife',
            'repo_url': 'https://github.com/octocat/Spoon-Knife',
            'selected_branch': 'main',
            'connection_status': 'connected',
            'last_synced_sha': 'd0d440026e6ef79a957d60f4e41b312be03ff6b0',
            'detected_technologies': [{'name': 'HTML', 'evidence': 'index.html found'}],
            'is_empty': False,
        }, format='json')
        self.assertEqual(response.status_code, 201)
        data = response.json()
        self.assertEqual(data['repo_owner'], 'octocat')
        self.assertEqual(data['repo_name'], 'Spoon-Knife')
        self.assertEqual(data['repo_full_name'], 'octocat/Spoon-Knife')
        self.assertEqual(data['selected_branch'], 'main')
        self.assertEqual(data['connection_status'], 'connected')
        self.assertEqual(data['last_synced_sha'], 'd0d440026e6ef79a957d60f4e41b312be03ff6b0')
        self.assertEqual(len(data['detected_technologies']), 1)

    def test_get_associated_repository(self):
        from apps.projects.models import ProjectRepository
        ProjectRepository.objects.create(
            project=self.draft,
            repo_owner='octocat',
            repo_name='Hello-World',
            selected_branch='master',
            last_synced_sha='7fd1a60b01f91b314f59955a4e4d4e80d8edf11d',
        )
        response = self.client.get(f'/api/projects/drafts/{self.draft.id}/repository/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['repo_full_name'], 'octocat/Hello-World')
        self.assertEqual(response.json()['selected_branch'], 'master')

    def test_draft_detail_includes_repository_data(self):
        from apps.projects.models import ProjectRepository
        ProjectRepository.objects.create(
            project=self.draft,
            repo_owner='octocat',
            repo_name='Hello-World',
            selected_branch='master',
            last_synced_sha='7fd1a60b01f91b314f59955a4e4d4e80d8edf11d',
        )
        response = self.client.get(f'/api/projects/drafts/{self.draft.id}/')
        self.assertEqual(response.status_code, 200)
        repo_data = response.json().get('repository')
        self.assertIsNotNone(repo_data)
        self.assertEqual(repo_data['repo_full_name'], 'octocat/Hello-World')

    def test_updating_repository_updates_existing_association(self):
        self.client.post(f'/api/projects/drafts/{self.draft.id}/repository/', {
            'owner': 'octocat',
            'name': 'Old-Repo',
            'selected_branch': 'main',
        }, format='json')
        response = self.client.post(f'/api/projects/drafts/{self.draft.id}/repository/', {
            'owner': 'octocat',
            'name': 'New-Repo',
            'selected_branch': 'develop',
            'last_synced_sha': 'abcdef123456',
        }, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['repo_name'], 'New-Repo')
        self.assertEqual(response.json()['selected_branch'], 'develop')
        from apps.projects.models import ProjectRepository
        self.assertEqual(ProjectRepository.objects.filter(project=self.draft).count(), 1)

    def test_invalid_repository_payload_returns_400(self):
        response = self.client.post(f'/api/projects/drafts/{self.draft.id}/repository/', {
            'selected_branch': 'main',
        }, format='json')
        self.assertEqual(response.status_code, 400)
        self.assertIn('error', response.json())

    def test_repository_for_nonexistent_draft_returns_404(self):
        import uuid
        response = self.client.post(f'/api/projects/drafts/{uuid.uuid4()}/repository/', {
            'owner': 'octocat',
            'name': 'Repo',
        }, format='json')
        self.assertEqual(response.status_code, 404)

    def test_disconnect_repository(self):
        from apps.projects.models import ProjectRepository
        ProjectRepository.objects.create(
            project=self.draft,
            repo_owner='octocat',
            repo_name='Hello-World',
        )
        response = self.client.delete(f'/api/projects/drafts/{self.draft.id}/repository/')
        self.assertEqual(response.status_code, 200)
        self.assertFalse(ProjectRepository.objects.filter(project=self.draft).exists())

    def test_user_authorization_prevents_cross_user_access(self):
        from django.contrib.auth import get_user_model
        from apps.projects.models import ProjectDraft, ProjectRepository
        User = get_user_model()
        alice = User.objects.create_user(username='alice', password='password')
        bob = User.objects.create_user(username='bob', password='password')

        alice_draft = ProjectDraft.objects.create(
            owner=alice,
            idea='Alice idea',
            project_type='Startup',
        )
        bob_client = APIClient()
        bob_client.force_authenticate(user=bob)

        # Bob cannot associate a repo to Alice's project
        response = bob_client.post(f'/api/projects/drafts/{alice_draft.id}/repository/', {
            'owner': 'bob',
            'name': 'bobs-repo',
        }, format='json')
        self.assertEqual(response.status_code, 404)

        # Anonymous client cannot associate a repo to Alice's project
        anon_response = self.client.post(f'/api/projects/drafts/{alice_draft.id}/repository/', {
            'owner': 'anon',
            'name': 'anon-repo',
        }, format='json')
        self.assertEqual(anon_response.status_code, 404)

        # Alice CAN associate a repo to her own project
        alice_client = APIClient()
        alice_client.force_authenticate(user=alice)
        alice_response = alice_client.post(f'/api/projects/drafts/{alice_draft.id}/repository/', {
            'owner': 'alice',
            'name': 'alices-repo',
            'selected_branch': 'main',
        }, format='json')
        self.assertEqual(alice_response.status_code, 201)
        self.assertEqual(alice_response.json()['repo_name'], 'alices-repo')

        # Bob cannot read Alice's repository
        bob_read = bob_client.get(f'/api/projects/drafts/{alice_draft.id}/repository/')
        self.assertEqual(bob_read.status_code, 404)

    def test_list_user_repositories(self):
        from apps.projects.models import ProjectRepository
        ProjectRepository.objects.create(
            project=self.draft,
            repo_owner='octocat',
            repo_name='Spoon-Knife',
            selected_branch='main',
        )
        response = self.client.get('/api/projects/repositories/')
        self.assertEqual(response.status_code, 200)
        repos = response.json().get('repositories', [])
        self.assertTrue(any(r['repo_full_name'] == 'octocat/Spoon-Knife' for r in repos))


class RoadmapRepositoryIntegrationTests(TestCase):
    def setUp(self):
        from apps.projects.models import ProjectDraft, ProjectRepository
        self.client = APIClient()
        self.draft = ProjectDraft.objects.create(
            idea='Build an AI agent pairing workspace with flight plan and repository verification.',
            project_type='Startup',
            workflow={
                'flight_plan': {
                    'summary': 'Roadmap for AI agent pairing workspace',
                    'milestones': [
                        {
                            'title': 'Repository Connection and Setup',
                            'category': 'Core',
                            'outcome': 'Connect repository and inspect structure',
                            'tasks': [
                                {
                                    'title': 'Build repository connection and sync API',
                                    'subtasks': ['Create Django endpoints for repo', 'Support sync status'],
                                    'acceptance_criteria': 'Repository can be associated and synced.',
                                },
                                {
                                    'title': 'Talk to potential users about GitHub preferences',
                                    'subtasks': ['Interview 5 developers'],
                                    'acceptance_criteria': 'Document user feedback.',
                                },
                            ],
                        },
                        {
                            'title': 'Integration Verification',
                            'category': 'Quality',
                            'outcome': 'Detect mismatches between frontend and backend',
                            'tasks': [
                                {
                                    'title': 'Verify frontend client matches backend routes',
                                    'subtasks': ['Check API endpoint registration', 'Identify mismatched HTTP methods'],
                                    'acceptance_criteria': 'All frontend endpoints resolve to registered Django views.',
                                },
                            ],
                        },
                    ],
                },
            },
        )
        self.sample_analysis = {
            'revision': 'abcdef1234567890',
            'evidenceFiles': [
                'frontend/src/pages/FlightPlan.jsx',
                'frontend/src/pages/Repository.jsx',
                'frontend/src/services/projectRepositoryService.js',
                'backend/apps/core/urls.py',
                'backend/apps/projects/models.py',
                'backend/apps/core/tests.py',
            ],
            'architecture': {
                'frontend': True,
                'backend': True,
                'routes': [
                    {'path': '/api/projects/drafts/<draft_id>/repository/', 'view': 'ProjectRepositoryView', 'methods': ['GET', 'POST', 'DELETE'], 'sourcePath': 'backend/apps/core/urls.py', 'line': 18},
                    {'path': '/api/projects/repositories/', 'view': 'UserRepositoriesView', 'methods': ['GET'], 'sourcePath': 'backend/apps/core/urls.py', 'line': 20},
                ],
            },
            'insights': {
                'endpoints': [
                    {'path': '/api/projects/drafts/:param/repository/', 'method': 'POST', 'sourcePath': 'frontend/src/services/projectRepositoryService.js', 'line': 212},
                ],
                'testFiles': ['backend/apps/core/tests.py'],
                'scripts': {'test': 'npm run test', 'build': 'npm run build'},
            },
            'findings': [
                {
                    'id': 'route-mismatch-1',
                    'title': 'Frontend endpoint is not registered in Django',
                    'severity': 'high',
                    'category': 'Integration',
                    'file': 'frontend/src/services/apiClient.js',
                    'line': 42,
                    'evidence': [{'file': 'frontend/src/services/apiClient.js', 'line': 42, 'text': 'POST /api/unknown/'}],
                },
            ],
            'verification': [
                {'name': 'Django tests', 'command': 'python manage.py test', 'status': 'not_run', 'reason': 'Execution requires an isolated test runner; untrusted code is not run on web server.'},
            ],
        }

    def test_compare_repository_without_repo_fails(self):
        response = self.client.post(f'/api/projects/drafts/{self.draft.id}/compare-repository/', {}, format='json')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json().get('code'), 'no_repository')

    def test_compare_repository_with_empty_repo(self):
        ProjectRepository.objects.create(
            project=self.draft,
            repo_owner='octocat',
            repo_name='empty-repo',
            is_empty=True,
        )
        response = self.client.post(f'/api/projects/drafts/{self.draft.id}/compare-repository/', {
            'analysis': {'evidenceFiles': []},
        }, format='json')
        self.assertEqual(response.status_code, 201)
        data = response.json()
        self.assertEqual(data['summary']['is_empty_repository'], True)
        # All tasks must be not_assessed
        for task in data['task_assessments'].values():
            self.assertEqual(task['status'], 'not_assessed')
            self.assertIn('empty', task['explanation'].lower())

    def test_compare_repository_with_evidence_and_status_rules(self):
        ProjectRepository.objects.create(
            project=self.draft,
            repo_owner='octocat',
            repo_name='UDAAN',
            selected_branch='main',
            last_synced_sha='abcdef1234567890',
            is_empty=False,
        )
        response = self.client.post(f'/api/projects/drafts/{self.draft.id}/compare-repository/', {
            'analysis': self.sample_analysis,
        }, format='json')
        self.assertEqual(response.status_code, 201)
        data = response.json()
        summary = data['summary']
        tasks = data['task_assessments']

        # Task 0-0 has matching repo files & routes -> evidence_found
        task_0_0 = tasks.get('0-0')
        self.assertIsNotNone(task_0_0)
        self.assertIn(task_0_0['status'], ['evidence_found', 'partially_implemented'])
        self.assertTrue(len(task_0_0['evidence']) > 0)
        self.assertEqual(task_0_0['commit_sha'], 'abcdef1234567890')

        # Task 0-1 is subjective user talk -> manual_review
        task_0_1 = tasks.get('0-1')
        self.assertIsNotNone(task_0_1)
        self.assertEqual(task_0_1['status'], 'manual_review')

        # Unverified tasks MUST NOT be reported as verified
        self.assertEqual(summary['verified_count'], 0)
        for t in tasks.values():
            self.assertNotEqual(t['status'], 'verified')
            # Checks must be reported as not_run with explanation
            for check in t.get('checks', []):
                self.assertEqual(check['status'], 'not_run')
                self.assertIn('isolated', check['reason'].lower())

    def test_user_correct_task_assessment(self):
        repo = ProjectRepository.objects.create(
            project=self.draft,
            repo_owner='octocat',
            repo_name='UDAAN',
            selected_branch='main',
            last_synced_sha='abcdef1234567890',
        )
        compare_resp = self.client.post(f'/api/projects/drafts/{self.draft.id}/compare-repository/', {
            'analysis': self.sample_analysis,
        }, format='json')
        self.assertEqual(compare_resp.status_code, 201)

        # User confirms / corrects task 0-1 to 'partially_implemented' with notes
        patch_resp = self.client.patch(
            f'/api/projects/drafts/{self.draft.id}/roadmap-assessment/tasks/0-1/',
            {
                'status': 'partially_implemented',
                'notes': 'Spoke to 3 users in preliminary testing.',
                'confirmed': True,
            },
            format='json',
        )
        self.assertEqual(patch_resp.status_code, 200)
        updated = patch_resp.json()
        task_0_1 = updated['task_assessments']['0-1']
        self.assertEqual(task_0_1['status'], 'partially_implemented')
        self.assertEqual(task_0_1['user_override']['notes'], 'Spoke to 3 users in preliminary testing.')
        self.assertTrue(task_0_1['user_override']['confirmed'])

        # Attempting to mark task as verified without actual checks passing is forbidden
        bad_verified = self.client.patch(
            f'/api/projects/drafts/{self.draft.id}/roadmap-assessment/tasks/0-1/',
            {'status': 'verified'},
            format='json',
        )
        self.assertEqual(bad_verified.status_code, 400)
        self.assertEqual(bad_verified.json().get('code'), 'unverified_forbidden')

    def test_repository_analysis_saving_and_retrieval(self):
        ProjectRepository.objects.create(
            project=self.draft,
            repo_owner='octocat',
            repo_name='UDAAN',
        )
        save_resp = self.client.post(
            f'/api/projects/drafts/{self.draft.id}/repository/analysis/',
            {'analysis': self.sample_analysis, 'commit_sha': '12345678'},
            format='json',
        )
        self.assertEqual(save_resp.status_code, 200)

        get_resp = self.client.get(f'/api/projects/drafts/{self.draft.id}/repository/analysis/')
        self.assertEqual(get_resp.status_code, 200)
        self.assertEqual(get_resp.json()['analysis']['revision'], 'abcdef1234567890')
        self.assertEqual(get_resp.json()['repository']['last_synced_sha'], '12345678')

    def test_user_scoping_on_roadmap_assessment(self):
        from django.contrib.auth import get_user_model
        User = get_user_model()
        alice = User.objects.create_user(username='alice_rm', password='password')
        bob = User.objects.create_user(username='bob_rm', password='password')

        alice_draft = ProjectDraft.objects.create(
            owner=alice,
            idea='Alice private roadmap',
            project_type='Startup',
        )
        ProjectRepository.objects.create(
            project=alice_draft,
            repo_owner='alice',
            repo_name='private-repo',
        )

        bob_client = APIClient()
        bob_client.force_authenticate(user=bob)

        # Bob cannot compare Alice's repository
        bob_resp = bob_client.post(f'/api/projects/drafts/{alice_draft.id}/compare-repository/', {}, format='json')
        self.assertEqual(bob_resp.status_code, 404)

        # Bob cannot get Alice's assessment
        bob_get = bob_client.get(f'/api/projects/drafts/{alice_draft.id}/roadmap-assessment/')
        self.assertEqual(bob_get.status_code, 404)


from datetime import date, timedelta
from django.utils import timezone


class DeadlineAwareRoadmapTests(TestCase):
    def setUp(self):
        from apps.projects.models import ProjectDraft
        self.client = APIClient()
        self.start = timezone.now().date()
        self.deadline = self.start + timedelta(days=21)
        self.draft = ProjectDraft.objects.create(
            idea='AI-powered study planner for university students',
            project_type='College Project',
            start_date=self.start,
            deadline=self.deadline,
            team_size=2,
            weekly_hours=15,
            understanding={
                'project_name': 'StudyPilot',
                'problem_statement': 'Students struggle to pace exam prep',
                'target_users': 'University students',
                'expected_outcome': 'Timely exam preparation without cramming',
            },
        )

    def test_draft_persists_deadline_and_schedule_fields(self):
        url = f'/api/projects/drafts/{self.draft.id}/'
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data['start_date'], self.start.isoformat())
        self.assertEqual(data['deadline'], self.deadline.isoformat())
        self.assertEqual(data['team_size'], 2)
        self.assertEqual(data['weekly_hours'], 15)

        # Update draft schedule
        new_deadline = self.start + timedelta(days=35)
        update_resp = self.client.put(url, {
            'idea': self.draft.idea,
            'project_type': self.draft.project_type,
            'start_date': self.start.isoformat(),
            'deadline': new_deadline.isoformat(),
            'team_size': 3,
            'weekly_hours': 25,
            'understanding': self.draft.understanding,
            'workflow': {},
            'current_stage': 'launch_timing',
        }, format='json')
        self.assertEqual(update_resp.status_code, 200)
        self.draft.refresh_from_db()
        self.assertEqual(self.draft.deadline, new_deadline)
        self.assertEqual(self.draft.team_size, 3)
        self.assertEqual(self.draft.weekly_hours, 25)

    def test_draft_validates_deadline_is_after_start_date(self):
        url = f'/api/projects/drafts/{self.draft.id}/'
        bad_deadline = self.start - timedelta(days=2)
        resp = self.client.put(url, {
            'idea': self.draft.idea,
            'project_type': self.draft.project_type,
            'start_date': self.start.isoformat(),
            'deadline': bad_deadline.isoformat(),
            'team_size': 1,
            'weekly_hours': 20,
            'understanding': self.draft.understanding,
            'workflow': {},
            'current_stage': 'launch_timing',
        }, format='json')
        self.assertEqual(resp.status_code, 400)
        self.assertIn('deadline', resp.json().get('fields', {}))

    def test_deterministic_scheduler_enforces_boundaries_and_ordering(self):
        from apps.core.roadmap_scheduler import schedule_and_validate_flight_plan
        raw_plan = {
            'summary': 'College exam study pilot',
            'milestones': [
                {
                    'title': 'Research & Requirements',
                    'category': 'Idea and Requirements',
                    'outcome': 'Requirements locked',
                    'tasks': [
                        {'title': 'Draft student persona and syllabus parser specs', 'effort_estimate': '2 days', 'priority': 'high'},
                    ],
                },
                {
                    'title': 'Core Development',
                    'category': 'Core Development',
                    'outcome': 'Working study schedule generator',
                    'tasks': [
                        {
                            'title': 'Build schedule generation algorithm',
                            'dependencies': ['Draft student persona and syllabus parser specs'],
                            'effort_estimate': '4 days',
                            'priority': 'high',
                        },
                    ],
                },
                {
                    'title': 'Testing and Verification',
                    'category': 'Testing and Verification',
                    'outcome': 'Verified and launch ready',
                    'tasks': [
                        {'title': 'User acceptance testing with 5 students', 'dependencies': ['Build schedule generation algorithm'], 'effort_estimate': '2 days', 'priority': 'high'},
                    ],
                },
            ],
        }

        scheduled = schedule_and_validate_flight_plan(
            raw_plan,
            start_date=self.start,
            deadline=self.deadline,
            team_size=2,
            weekly_hours=20,
        )

        milestones = scheduled['milestones']
        self.assertEqual(len(milestones), 3)
        # Check start_date <= ms_start <= ms_target <= deadline
        for ms in milestones:
            self.assertTrue(ms['start_date'] >= self.start.isoformat())
            self.assertTrue(ms['target_date'] <= self.deadline.isoformat())
            self.assertTrue(ms['start_date'] <= ms['target_date'])

        # Check dependency ordering
        task1 = milestones[0]['tasks'][0]
        task2 = milestones[1]['tasks'][0]
        self.assertTrue(task2['start_date'] >= task1['target_date'])

        # Check schedule assessment
        assessment = scheduled['schedule_assessment']
        self.assertIn('feasibility_status', assessment)
        self.assertIn('total_capacity_hours', assessment)
        self.assertIn('total_effort_hours', assessment)
        self.assertEqual(assessment['deadline'], self.deadline.isoformat())

    def test_deterministic_scheduler_detects_overambitious_schedule(self):
        from apps.core.roadmap_scheduler import schedule_and_validate_flight_plan
        # 1 person with 5 hours/week for a 7-day project (only ~5 hours capacity)
        # But 8 tasks requiring 16 hours each (128 hours total)
        tight_deadline = self.start + timedelta(days=7)
        tasks = [{'title': f'Heavy Task {i}', 'effort_estimate': '2 days', 'priority': 'medium' if i > 2 else 'high'} for i in range(8)]
        raw_plan = {
            'summary': 'Overambitious project',
            'milestones': [{'title': 'Sprint 1', 'category': 'Core Development', 'outcome': 'All features built', 'tasks': tasks}],
        }
        scheduled = schedule_and_validate_flight_plan(
            raw_plan,
            start_date=self.start,
            deadline=tight_deadline,
            team_size=1,
            weekly_hours=5,
        )
        assessment = scheduled['schedule_assessment']
        self.assertEqual(assessment['feasibility_status'], 'overambitious')
        self.assertTrue(len(assessment['mvp_recommendations']) > 0)
        self.assertTrue(len(assessment['deferred_features']) > 0)

    @patch('apps.core.idea_views.generate_idea_stage')
    def test_replan_endpoint_preserves_completed_tasks_and_reschedules_remainder(self, mock_generate):
        from apps.core.roadmap_scheduler import schedule_and_validate_flight_plan
        # Setup draft with existing flight plan
        flight_plan = schedule_and_validate_flight_plan(
            {
                'summary': 'Existing plan',
                'milestones': [
                    {'title': 'M1', 'category': 'Idea and Requirements', 'outcome': 'Done', 'tasks': [{'id': 't1', 'title': 'T1', 'effort_estimate': '1 day', 'priority': 'high'}]},
                    {'title': 'M2', 'category': 'Core Development', 'outcome': 'Done', 'tasks': [{'id': 't2', 'title': 'T2', 'effort_estimate': '3 days', 'priority': 'high'}]},
                ],
            },
            start_date=self.start,
            deadline=self.deadline,
        )
        self.draft.workflow = {'flight_plan': flight_plan}
        self.draft.save(update_fields=['workflow'])
        mock_generate.return_value = flight_plan

        replan_url = f'/api/projects/drafts/{self.draft.id}/replan/'
        resp = self.client.post(replan_url, {
            'completed_task_ids': ['t1'],
            'start_date': self.start.isoformat(),
            'deadline': (self.start + timedelta(days=14)).isoformat(),
            'team_size': 2,
            'weekly_hours': 20,
            'current_plan': flight_plan,
        }, format='json')

        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn('proposed_plan', data)
        self.assertIn('comparison', data)
        self.assertEqual(data['comparison']['completed_tasks_preserved'], 1)
        self.assertEqual(data['comparison']['remaining_tasks_rescheduled'], 1)

    def test_replan_endpoint_validates_deadline(self):
        replan_url = f'/api/projects/drafts/{self.draft.id}/replan/'
        # Past deadline or before start
        resp = self.client.post(replan_url, {
            'start_date': self.start.isoformat(),
            'deadline': (self.start - timedelta(days=1)).isoformat(),
        }, format='json')
        self.assertEqual(resp.status_code, 400)


class MarketingContentApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.workspace = '09f59b85-4297-4583-9f2a-49b70c041d5a'
        self.headers = {'HTTP_X_MARKETING_WORKSPACE': self.workspace}

    def test_saved_content_crud_is_private_to_browser_workspace(self):
        response = self.client.post('/api/marketing/content/', {
            'title': 'Campus launch', 'body': 'Editable text', 'content_type': 'social',
            'platform': 'LinkedIn', 'project_id': None, 'generation_inputs': {'topic': 'campus'},
        }, format='json', **self.headers)
        self.assertEqual(response.status_code, 201)
        item_id = response.json()['id']
        own_list = self.client.get('/api/marketing/content/?project=custom&q=launch', **self.headers)
        self.assertEqual(len(own_list.json()['results']), 1)
        private_list = self.client.get('/api/marketing/content/', HTTP_X_MARKETING_WORKSPACE='0a6cb83b-4c34-4356-8806-a91ff67843cb')
        self.assertEqual(private_list.json()['results'], [])
        changed = self.client.patch(f'/api/marketing/content/{item_id}/', {'body': 'Edited copy'}, format='json', **self.headers)
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(changed.json()['body'], 'Edited copy')
        self.assertEqual(self.client.delete(f'/api/marketing/content/{item_id}/', **self.headers).status_code, 204)

    def test_saving_requires_a_valid_workspace_key_and_project_must_be_accessible(self):
        from django.contrib.auth import get_user_model
        payload = {'title': 'Draft', 'body': 'Text', 'content_type': 'tool'}
        missing_key = self.client.post('/api/marketing/content/', payload, format='json')
        self.assertEqual(missing_key.status_code, 400)
        owner = get_user_model().objects.create_user(username='private-project-owner', password='safe-test-password')
        private_project = ProjectDraft.objects.create(idea='Private idea', project_type='Startup', owner=owner)
        denied = self.client.post('/api/marketing/content/', {**payload, 'project_id': str(private_project.id)}, format='json', **self.headers)
        self.assertEqual(denied.status_code, 404)

    def test_authenticated_saved_content_is_scoped_to_the_account(self):
        from django.contrib.auth import get_user_model
        User = get_user_model()
        first = User.objects.create_user(username='marketing-owner', password='safe-test-password')
        second = User.objects.create_user(username='other-marketing-owner', password='safe-test-password')
        browser_saved = self.client.post('/api/marketing/content/', {'title': 'Browser draft', 'body': 'Keep this after login', 'content_type': 'social'}, format='json', **self.headers)
        browser_item_id = browser_saved.json()['id']
        self.client.force_authenticate(first)
        self.assertEqual(len(self.client.get('/api/marketing/content/', **self.headers).json()['results']), 1)
        adopted = self.client.patch(f'/api/marketing/content/{browser_item_id}/', {'body': 'Now on this account'}, format='json', **self.headers)
        self.assertEqual(adopted.status_code, 200)
        self.assertEqual(MarketingContentItem.objects.get(pk=browser_item_id).owner, first)
        created = self.client.post('/api/marketing/content/', {'title': 'Private', 'body': 'Owner text', 'content_type': 'tool'}, format='json')
        self.assertEqual(created.status_code, 201)
        other = APIClient()
        other.force_authenticate(second)
        self.assertEqual(other.get('/api/marketing/content/').json()['results'], [])
        self.assertEqual(other.delete(f"/api/marketing/content/{created.json()['id']}/").status_code, 404)

    @patch('apps.core.marketing_views.generate_marketing_content')
    def test_project_generation_uses_real_context_and_keeps_plans_separate_from_done_work(self, generate):
        from apps.projects.models import ProjectDraft, ProjectRepository, RoadmapAssessment
        from apps.roadmaps.models import ProjectTask
        draft = ProjectDraft.objects.create(
            idea='A campus ride matching app', project_type='Startup',
            understanding={'project_name': 'CampusRide', 'problem_statement': 'Students need rides', 'target_users': 'Students'},
            workflow={'flight_plan': {'milestones': [{'title': 'Prototype', 'tasks': [{'title': 'Build booking flow'}]}]}},
        )
        ProjectRepository.objects.create(project=draft, repo_owner='public-org', repo_name='campus-ride', detected_technologies=[{'name': 'React', 'evidence': 'package.json'}], latest_analysis={'evidenceFiles': ['frontend/src/App.jsx']})
        ProjectTask.objects.create(project=draft, source_key='build-booking', title='Build booking flow', status='completed')
        RoadmapAssessment.objects.create(project=draft, task_assessments={'0-0': {'status': 'verified', 'taskTitle': 'Build booking flow', 'evidence': [{'text': 'Booking tests passed.'}]}})
        generate.return_value = {'approach': 'Grounded copy', 'items': []}
        response = self.client.post('/api/marketing/generate/', {
            'mode': 'social', 'project_id': str(draft.id), 'inputs': {'topic': 'Launch post'},
        }, format='json')
        self.assertEqual(response.status_code, 200)
        context = generate.call_args.kwargs['project_context']
        self.assertEqual(context['project_name'], 'CampusRide')
        self.assertEqual(context['technologies'][0]['name'], 'React')
        self.assertEqual(context['roadmap'][0]['planned_tasks'], ['Build booking flow'])
        self.assertEqual(context['workspace_marked_completed_tasks'][0]['title'], 'Build booking flow')
        self.assertEqual(context['independently_verified_tasks'][0]['task'], 'Build booking flow')

    @patch('apps.core.marketing_views.generate_marketing_content')
    def test_custom_generation_and_ai_failures_return_real_service_status(self, generate):
        from apps.core.gemini_service import GeminiRequestError
        generate.return_value = {'approach': 'Custom', 'items': []}
        success = self.client.post('/api/marketing/generate/', {'mode': 'tool', 'inputs': {'topic': 'Write an internship announcement'}}, format='json')
        self.assertEqual(success.status_code, 200)
        self.assertFalse(success.json()['project_context_used'])
        generate.side_effect = GeminiRequestError('Temporary provider issue.', retryable=True)
        failed = self.client.post('/api/marketing/generate/', {'mode': 'social', 'inputs': {'topic': 'A project'}}, format='json')
        self.assertEqual(failed.status_code, 502)
        self.assertTrue(failed.json()['retryable'])


class MarketingGenerationServiceTests(SimpleTestCase):
    @staticmethod
    def result_item(index, day=0, fmt='LinkedIn post'):
        return {
            'title': f'Hook {index}', 'platform': 'LinkedIn', 'format': fmt,
            'hook': f'Hook {index}', 'body': f'Distinct content version {index}',
            'cta': 'Learn more', 'hashtags': [], 'rationale': 'Direct and specific.',
            'day': day, 'objective': 'awareness',
        }

    @staticmethod
    def provider_response(result):
        import json
        return {'candidates': [{'content': {'parts': [{'text': json.dumps(result)}]}}]}

    @patch.dict(os.environ, {'GEMINI_API_KEY': 'test-key', 'GEMINI_MODEL': 'test-model', 'GEMINI_FALLBACK_MODELS': ''})
    @patch('apps.core.gemini_service._generate_content')
    def test_social_requires_three_distinct_structured_variations(self, generate):
        from apps.core.gemini_service import generate_marketing_content
        generate.return_value = self.provider_response({'approach': 'Three distinct approaches.', 'items': [self.result_item(index) for index in range(3)]})
        result = generate_marketing_content(mode='social', inputs={'topic': 'A useful topic'})
        self.assertEqual(len(result['items']), 3)
        self.assertNotIn('response_format', generate.call_args.args[0]['generationConfig'])
        generate.return_value = self.provider_response({'approach': 'Repeated.', 'items': [self.result_item(1)] * 3})
        with self.assertRaisesRegex(GeminiRequestError, 'repeated a social variation'):
            generate_marketing_content(mode='social', inputs={'topic': 'A useful topic'})

    @patch.dict(os.environ, {'GEMINI_API_KEY': 'test-key', 'GEMINI_MODEL': 'test-model', 'GEMINI_FALLBACK_MODELS': ''})
    @patch('apps.core.gemini_service._generate_content')
    def test_campaign_days_and_repurpose_format_choices_are_validated(self, generate):
        from apps.core.gemini_service import generate_marketing_content
        generate.return_value = self.provider_response({'approach': 'A varied schedule.', 'items': [self.result_item(index, day=index) for index in range(1, 8)]})
        self.assertEqual(len(generate_marketing_content(mode='campaign', inputs={'campaign_days': 7})['items']), 7)
        generate.return_value = self.provider_response({'approach': 'A calendar.', 'items': [self.result_item(index, day=1) for index in range(1, 8)]})
        with self.assertRaisesRegex(GeminiRequestError, 'incomplete campaign calendar'):
            generate_marketing_content(mode='campaign', inputs={'campaign_days': 7})
        generate.return_value = self.provider_response({'approach': 'Repurposed.', 'items': [self.result_item(1, fmt='LinkedIn post')]})
        self.assertEqual(len(generate_marketing_content(mode='repurpose', inputs={'formats': ['LinkedIn post']})['items']), 1)
        with self.assertRaisesRegex(GeminiRequestError, 'formats that do not match'):
            generate_marketing_content(mode='repurpose', inputs={'formats': ['Demo narration']})

    @patch.dict(os.environ, {'GEMINI_API_KEY': ''})
    def test_missing_gemini_configuration_is_actionable(self):
        from apps.core.gemini_service import GeminiConfigurationError, generate_marketing_content
        with self.assertRaisesRegex(GeminiConfigurationError, 'GEMINI_API_KEY'):
            generate_marketing_content(mode='tool', inputs={'topic': 'An announcement'})



