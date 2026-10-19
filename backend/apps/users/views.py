import json
import re
import secrets
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from django.conf import settings
from django.contrib.auth import get_user_model, login, logout
from django.db import transaction
from django.http import HttpResponseRedirect
from django.utils import timezone
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import ensure_csrf_cookie
from django.middleware.csrf import get_token
from rest_framework import serializers, status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import DeveloperProfile
# pyrefly: ignore[missing-import]
from apps.projects.models import ProjectDraft
# pyrefly: ignore[missing-import]
from apps.teams.models import TeamMember


def github_request(url, token=None, method='GET', payload=None, accept='application/vnd.github+json'):
    headers = {'Accept': accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'UDAAN-Project-Workspace'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    data = json.dumps(payload).encode() if payload is not None else None
    if data:
        headers['Content-Type'] = 'application/json'
    request = Request(url, headers=headers, data=data, method=method)
    with urlopen(request, timeout=12) as response:
        return json.loads(response.read().decode('utf-8')) if response.status != 204 else None


def configured_github():
    return bool(getattr(settings, 'GITHUB_CLIENT_ID', '') and getattr(settings, 'GITHUB_CLIENT_SECRET', ''))


def frontend_url(path='/profile'):
    return f"{settings.FRONTEND_BASE_URL.rstrip('/')}{path}"


class GitHubLoginStartView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        if not configured_github():
            return Response({'error': 'GitHub sign-in is not configured. Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to backend/.env.'}, status=503)
        state = secrets.token_urlsafe(32)
        request.session['github_oauth_state'] = state
        request.session['github_oauth_refresh'] = request.query_params.get('refresh') == '1'
        return_to = request.query_params.get('return_to', '/profile')
        allowed_return = return_to == '/profile' or bool(re.fullmatch(r'/team/invite/[A-Za-z0-9_-]+', return_to))
        request.session['github_oauth_return_to'] = return_to if allowed_return else '/profile'
        raw_ids = request.query_params.get('project_ids', '')
        project_ids = []
        for raw_id in raw_ids.split(',')[:50]:
            try: project_ids.append(str(uuid.UUID(raw_id)))
            except (ValueError, TypeError, AttributeError): continue
        request.session['github_oauth_project_ids'] = project_ids
        callback = getattr(settings, 'GITHUB_REDIRECT_URI', f"http://127.0.0.1:8000/api/auth/github/callback/")
        params = urlencode({'client_id': settings.GITHUB_CLIENT_ID, 'redirect_uri': callback, 'scope': 'read:user user:email', 'state': state})
        return Response({'authorization_url': f'https://github.com/login/oauth/authorize?{params}'})


@method_decorator(ensure_csrf_cookie, name='dispatch')
class GitHubLoginCallbackView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        error = request.query_params.get('error')
        if error:
            return HttpResponseRedirect(f'{frontend_url(request.session.pop("github_oauth_return_to", "/profile"))}?github=cancelled')
        expected = request.session.pop('github_oauth_state', None)
        actual = request.query_params.get('state', '')
        if not expected or not secrets.compare_digest(expected, actual) or not request.query_params.get('code'):
            return HttpResponseRedirect(f'{frontend_url(request.session.pop("github_oauth_return_to", "/profile"))}?github=invalid_state')
        if not configured_github():
            return HttpResponseRedirect(f'{frontend_url(request.session.pop("github_oauth_return_to", "/profile"))}?github=not_configured')
        callback = getattr(settings, 'GITHUB_REDIRECT_URI', 'http://127.0.0.1:8000/api/auth/github/callback/')
        try:
            token_response = github_request('https://github.com/login/oauth/access_token', method='POST', accept='application/json', payload={
                'client_id': settings.GITHUB_CLIENT_ID, 'client_secret': settings.GITHUB_CLIENT_SECRET,
                'code': request.query_params['code'], 'redirect_uri': callback,
            })
            token = token_response.get('access_token')
            if not token:
                return HttpResponseRedirect(f'{frontend_url(request.session.pop("github_oauth_return_to", "/profile"))}?github=token_error')
            github_user = github_request('https://api.github.com/user', token)
            emails = github_request('https://api.github.com/user/emails', token)
            verified_email = next((entry['email'].lower() for entry in emails if entry.get('verified') and entry.get('primary')), '')
            if not verified_email:
                verified_email = next((entry['email'].lower() for entry in emails if entry.get('verified')), '')
            github_id = str(github_user.get('id') or '')
            if not github_id:
                return HttpResponseRedirect(f'{frontend_url(request.session.pop("github_oauth_return_to", "/profile"))}?github=provider_error')
            profile_before = DeveloperProfile.objects.filter(github_id=github_id).first()
            refresh_requested = bool(request.session.pop('github_oauth_refresh', False))
            already_analyzed = profile_before and profile_before.analysis_status != 'not_started' and profile_before.analyzed_at
            if refresh_requested or not already_analyzed:
                profile_data, analysis_status = analyze_public_profile(github_user, token)
            else:
                profile_data, analysis_status = None, profile_before.analysis_status
        except (HTTPError, URLError, TimeoutError, ValueError, KeyError):
            return HttpResponseRedirect(f'{frontend_url(request.session.pop("github_oauth_return_to", "/profile"))}?github=provider_error')
        User = get_user_model()
        try:
            with transaction.atomic():
                profile = DeveloperProfile.objects.select_related('user').filter(github_id=github_id).first()
                if profile:
                    user = profile.user
                else:
                    user = User.objects.filter(email__iexact=verified_email).first() if verified_email else None
                    if user and DeveloperProfile.objects.filter(user=user).exists():
                        return HttpResponseRedirect(f'{frontend_url(request.session.pop("github_oauth_return_to", "/profile"))}?github=account_link_error')
                    if not user:
                        username = f"github-{github_id}"
                        user = User.objects.create_user(username=username, email=verified_email or '')
                    profile, _ = DeveloperProfile.objects.get_or_create(user=user, defaults={'github_id': github_id})
                    if profile.github_id != github_id:
                        return HttpResponseRedirect(f'{frontend_url(request.session.pop("github_oauth_return_to", "/profile"))}?github=account_link_error')
                if profile_data is not None:
                    profile.public_repositories = profile_data['repositories']
                    profile.technologies = profile_data['technologies']
                    profile.evidence = profile_data['evidence']
                    profile.analysis_status = analysis_status
                    profile.analyzed_at = timezone.now()
                profile.github_login = str(github_user.get('login') or '')[:80]
                profile.avatar_url = str(github_user.get('avatar_url') or '')[:500]
                profile.profile_url = str(github_user.get('html_url') or '')[:500]
                profile.save()
                project_ids = request.session.pop('github_oauth_project_ids', [])
                if project_ids:
                    unowned = list(ProjectDraft.objects.filter(pk__in=project_ids, owner__isnull=True))
                    for draft in unowned:
                        draft.owner = user
                        draft.save(update_fields=['owner', 'updated_at'])
                        TeamMember.objects.filter(project=draft, slot=1).update(user=user)
                login(request, user, backend='django.contrib.auth.backends.ModelBackend')
        except Exception:
            return HttpResponseRedirect(f'{frontend_url(request.session.pop("github_oauth_return_to", "/profile"))}?github=account_error')
        return_to = request.session.pop('github_oauth_return_to', '/profile')
        csrf_token = get_token(request)
        redirect_response = HttpResponseRedirect(f'{frontend_url(return_to)}?github=connected')
        redirect_response.set_cookie(
            settings.CSRF_COOKIE_NAME,
            csrf_token,
            domain=settings.CSRF_COOKIE_DOMAIN,
            path=settings.CSRF_COOKIE_PATH,
            secure=settings.CSRF_COOKIE_SECURE,
            httponly=getattr(settings, 'CSRF_COOKIE_HTTPONLY', False),
            samesite=settings.CSRF_COOKIE_SAMESITE,
        )
        return redirect_response


def analyze_public_profile(github_user, token):
    repositories, technology_evidence = [], {}
    status_value = 'complete'
    try:
        rows = github_request(f"https://api.github.com/users/{github_user['login']}/repos?type=owner&sort=pushed&per_page=8", token)
        for repo in rows if isinstance(rows, list) else []:
            if repo.get('private'):
                continue
            entry = {'name': str(repo.get('full_name') or '')[:160], 'url': str(repo.get('html_url') or '')[:300],
                     'description': str(repo.get('description') or '')[:500], 'language': repo.get('language'), 'evidence_paths': []}
            repositories.append(entry)
            try:
                language_data = github_request(f"https://api.github.com/repos/{repo['full_name']}/languages", token)
                for language in language_data if isinstance(language_data, dict) else {}:
                    technology_evidence.setdefault(language, []).append(repo['full_name'])
            except (HTTPError, URLError, TimeoutError, ValueError, KeyError):
                status_value = 'partial'
            try:
                branch = str(repo.get('default_branch') or 'HEAD')
                tree = github_request(f"https://api.github.com/repos/{repo['full_name']}/git/trees/{branch}?recursive=1", token)
                paths = [str(item.get('path') or '') for item in (tree.get('tree') or []) if item.get('type') == 'blob']
                notable = [path for path in paths if path.lower().endswith(('.py', '.js', '.jsx', '.ts', '.tsx', '.java', '.go', '.rs', '.sql', '.prisma'))
                           or path.rsplit('/', 1)[-1].lower() in ('package.json', 'pyproject.toml', 'requirements.txt', 'manage.py', 'dockerfile')]
                entry['evidence_paths'] = notable[:10]
            except (HTTPError, URLError, TimeoutError, ValueError, KeyError):
                status_value = 'partial'
    except (HTTPError, URLError, TimeoutError, ValueError, KeyError):
        status_value = 'unavailable'
    if not repositories and status_value == 'complete':
        status_value = 'partial'
    technologies = [{'name': name, 'evidence_count': len(names)} for name, names in sorted(technology_evidence.items())]
    evidence = [{'technology': name, 'repositories': names[:8], 'basis': 'Declared repository language metadata; not proof of proficiency.'}
                for name, names in sorted(technology_evidence.items())]
    return {'repositories': repositories, 'technologies': technologies, 'evidence': evidence}, status_value


class DeveloperProfileSerializer(serializers.ModelSerializer):
    class Meta:
        model = DeveloperProfile
        fields = ['github_id', 'github_login', 'avatar_url', 'profile_url', 'public_repositories', 'technologies', 'evidence',
                  'skills', 'experience', 'preferred_roles', 'availability_hours', 'learning_goals', 'analysis_status', 'analyzed_at', 'updated_at']
        read_only_fields = ['github_id', 'github_login', 'avatar_url', 'profile_url', 'public_repositories', 'technologies', 'evidence', 'analysis_status', 'analyzed_at', 'updated_at']

    def validate_skills(self, values):
        if len(values) > 40 or any(not value.strip() for value in values):
            raise serializers.ValidationError('Enter up to 40 non-empty skills.')
        return list(dict.fromkeys(value.strip()[:80] for value in values))

    def validate_preferred_roles(self, values):
        if len(values) > 12:
            raise serializers.ValidationError('Enter up to 12 preferred roles.')
        return list(dict.fromkeys(value.strip()[:120] for value in values if value.strip()))

    def validate_availability_hours(self, value):
        if not 1 <= value <= 80:
            raise serializers.ValidationError('Availability must be between 1 and 80 hours per week.')
        return value

    def validate_experience(self, value):
        if len(value) > 4000:
            raise serializers.ValidationError('Experience details must be 4,000 characters or fewer.')
        return value

    def validate_learning_goals(self, value):
        if len(value) > 2000:
            raise serializers.ValidationError('Learning goals must be 2,000 characters or fewer.')
        return value


@method_decorator(ensure_csrf_cookie, name='dispatch')
class AuthStatusView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        csrf_token = get_token(request)
        data = {'authenticated': request.user.is_authenticated, 'github_configured': configured_github(), 'csrf_token': csrf_token}
        if request.user.is_authenticated:
            profile = DeveloperProfile.objects.filter(user=request.user).first()
            data['user'] = {'id': request.user.pk, 'name': request.user.get_full_name() or (profile.github_login if profile else request.user.username), 'email': request.user.email}
            data['github_connected'] = bool(profile)
            data['profile'] = DeveloperProfileSerializer(profile).data if profile else None
        res = Response(data)
        res['X-CSRFToken'] = csrf_token
        return res


@method_decorator(ensure_csrf_cookie, name='dispatch')
class CsrfTokenView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        token = get_token(request)
        res = Response({'csrf_token': token})
        res['X-CSRFToken'] = token
        return res


@method_decorator(ensure_csrf_cookie, name='dispatch')
class DeveloperProfileView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        profile = DeveloperProfile.objects.filter(user=request.user).first()
        if not profile:
            return Response({'error': 'Connect a GitHub account to create your developer profile.'}, status=404)
        return Response(DeveloperProfileSerializer(profile).data)

    def patch(self, request):
        profile = DeveloperProfile.objects.filter(user=request.user).first()
        if not profile:
            return Response({'error': 'Connect a GitHub account to create your developer profile.'}, status=404)
        serializer = DeveloperProfileSerializer(profile, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        saved = serializer.save()
        return Response(DeveloperProfileSerializer(saved).data)


class LogoutView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        logout(request)
        return Response({'authenticated': False})
