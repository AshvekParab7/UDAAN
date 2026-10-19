from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from apps.projects.models import ProjectDraft
from .models import DeveloperProfile
from .views import analyze_public_profile


@override_settings(GITHUB_CLIENT_ID='test-client', GITHUB_CLIENT_SECRET='test-secret', GITHUB_REDIRECT_URI='http://testserver/api/auth/github/callback/')
class GitHubAuthenticationTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = {'id': 98765, 'login': 'dev-user', 'avatar_url': 'https://avatars.example/dev.png', 'html_url': 'https://github.com/dev-user'}
        self.email = [{'email': 'dev@example.test', 'verified': True, 'primary': True}]
        self.profile_data = ({'repositories': [{'name': 'dev-user/demo', 'url': 'https://github.com/dev-user/demo', 'description': 'Demo', 'language': 'Python', 'evidence_paths': ['manage.py']}],
            'technologies': [{'name': 'Python', 'evidence_count': 1}], 'evidence': [{'technology': 'Python', 'repositories': ['dev-user/demo'], 'basis': 'Repo language metadata.'}]}, 'complete')

    def login_github(self, *, project_ids='', refresh=False):
        query = {}
        if project_ids: query['project_ids'] = project_ids
        if refresh: query['refresh'] = '1'
        start = self.client.get('/api/auth/github/start/', query)
        self.assertEqual(start.status_code, 200)
        state = self.client.session['github_oauth_state']
        with patch('apps.users.views.github_request', side_effect=[{'access_token': 'never-persist'}, self.user, self.email]), \
             patch('apps.users.views.analyze_public_profile', return_value=self.profile_data) as analyze:
            response = self.client.get('/api/auth/github/callback/', {'code': 'one-time-code', 'state': state})
        self.assertEqual(response.status_code, 302)
        return response, analyze

    def test_oauth_uses_state_stable_github_id_and_caches_repository_analysis(self):
        response, analyze = self.login_github()
        self.assertTrue(response['Location'].endswith('/profile?github=connected'))
        self.assertEqual(analyze.call_count, 1)
        profile = DeveloperProfile.objects.get(github_id='98765')
        self.assertEqual(profile.user.email, 'dev@example.test')
        self.assertEqual(profile.technologies[0]['name'], 'Python')
        self.assertFalse(hasattr(profile, 'access_token'))
        status = self.client.get('/api/auth/status/').json()
        self.assertTrue(status['authenticated'])
        self.assertEqual(status['profile']['github_login'], 'dev-user')

        _, analyze_again = self.login_github()
        analyze_again.assert_not_called()
        self.assertEqual(get_user_model().objects.count(), 1)

    def test_refresh_reanalyzes_and_claims_only_supplied_guest_project_ids(self):
        project = ProjectDraft.objects.create(idea='A local project', project_type='Startup')
        response, analyze = self.login_github(project_ids=str(project.id), refresh=True)
        self.assertEqual(response.status_code, 302)
        analyze.assert_called_once()
        project.refresh_from_db()
        self.assertEqual(project.owner, get_user_model().objects.get(username='github-98765'))

    def test_invalid_oauth_state_does_not_create_an_account(self):
        self.client.get('/api/auth/github/start/')
        response = self.client.get('/api/auth/github/callback/', {'code': 'code', 'state': 'wrong'})
        self.assertIn('github=invalid_state', response['Location'])
        self.assertEqual(get_user_model().objects.count(), 0)

    def test_missing_configuration_is_explained_without_redirecting(self):
        with override_settings(GITHUB_CLIENT_ID='', GITHUB_CLIENT_SECRET=''):
            response = self.client.get('/api/auth/github/start/')
        self.assertEqual(response.status_code, 503)
        self.assertIn('GITHUB_CLIENT_ID', response.json()['error'])

    def test_member_can_edit_profile_and_authentication_is_required(self):
        user = get_user_model().objects.create_user(username='profile-user')
        profile = DeveloperProfile.objects.create(user=user, github_id='456')
        self.client.force_authenticate(user)
        response = self.client.patch('/api/profile/developer/', {'skills': ['React', 'Testing'], 'preferred_roles': ['Frontend'], 'availability_hours': 16, 'learning_goals': 'Practice integration tests'}, format='json')
        self.assertEqual(response.status_code, 200)
        profile.refresh_from_db()
        self.assertEqual(profile.skills, ['React', 'Testing'])
        self.assertEqual(profile.availability_hours, 16)
        self.client.force_authenticate(user=None)
        self.assertIn(self.client.get('/api/profile/developer/').status_code, (401, 403))


class GitHubPublicEvidenceTests(TestCase):
    @patch('apps.users.views.github_request')
    def test_profile_analysis_uses_only_public_repository_metadata_and_source_paths(self, github_request):
        github_request.side_effect = [
            [{'full_name': 'demo/one', 'html_url': 'https://github.com/demo/one', 'description': 'Public app', 'language': 'Python', 'private': False, 'default_branch': 'main'},
             {'full_name': 'demo/private', 'private': True}],
            {'Python': 1200, 'HTML': 200},
            {'tree': [{'type': 'blob', 'path': 'manage.py'}, {'type': 'blob', 'path': 'app/views.py'}, {'type': 'tree', 'path': 'folder'}]},
        ]
        result, status = analyze_public_profile({'login': 'demo'}, 'transient-token')
        self.assertEqual(status, 'complete')
        self.assertEqual([repo['name'] for repo in result['repositories']], ['demo/one'])
        self.assertEqual(result['technologies'][0]['name'], 'HTML')
        self.assertIn('app/views.py', result['repositories'][0]['evidence_paths'])
        self.assertEqual(github_request.call_count, 3)
