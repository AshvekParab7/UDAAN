import hashlib
import json
import re
import secrets
import hashlib
from datetime import date, timedelta
from decimal import Decimal

from django.conf import settings
from django.core.mail import send_mail
from django.db import models, transaction
from django.utils import timezone
from django.shortcuts import get_object_or_404
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import ensure_csrf_cookie
from django.middleware.csrf import get_token
from rest_framework import serializers, status
from rest_framework.permissions import AllowAny
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.projects.models import ProjectDraft
from apps.roadmaps.models import ProjectTask
from apps.teams.models import TeamInvitation, TeamMember
from apps.users.models import DeveloperProfile, TaskAllocationProposal
from apps.core.gemini_service import GeminiConfigurationError, GeminiRequestError, generate_task_allocation


def owned_drafts(request):
    return ProjectDraft.objects.filter(owner=request.user) if request.user.is_authenticated else ProjectDraft.objects.filter(owner__isnull=True)


def accessible_drafts(request):
    if request.user.is_authenticated:
        user_email = (request.user.email or '').strip()
        query = models.Q(owner=request.user) | models.Q(team_members__user=request.user)
        if user_email:
            query |= models.Q(team_members__email__iexact=user_email)
        return ProjectDraft.objects.filter(query).distinct()
    return ProjectDraft.objects.filter(owner__isnull=True)


def ensure_member_slots(project, target_size=None, current_user=None):
    creator, _ = TeamMember.objects.get_or_create(project=project, slot=1, defaults={'is_creator': True, 'user': project.owner})
    updates = []
    if not creator.is_creator:
        creator.is_creator = True
        updates.append('is_creator')
    if project.owner_id and creator.user_id != project.owner_id:
        creator.user = project.owner
        updates.append('user')
    if updates:
        creator.save(update_fields=updates)
    if current_user and current_user.is_authenticated and current_user.email:
        TeamMember.objects.filter(project=project, email__iexact=current_user.email, user__isnull=True).update(user=current_user)
    return list(TeamMember.objects.filter(project=project).order_by('slot'))


def task_payload(task):
    return {'id': task.pk, 'source_key': task.source_key, 'source_position': task.source_position, 'milestone': task.milestone, 'title': task.title,
        'description': task.description, 'assigned_to': task.assigned_to_id, 'priority': task.priority,
        'effort_hours': float(task.effort_hours), 'dependencies': task.dependencies, 'deadline': task.deadline,
        'deliverable': task.deliverable, 'status': task.status, 'required_skills': task.required_skills, 'active': task.active}


def member_payload(member):
    tasks = list(member.tasks.filter(active=True))
    total = sum((t.effort_hours for t in tasks), Decimal('0'))
    done = sum(1 for t in tasks if t.status == 'completed')
    profile = DeveloperProfile.objects.filter(user=member.user).first() if member.user_id else None
    return {'id': member.pk, 'slot': member.slot, 'name': member.name, 'display_name': member.display_name,
        'email': member.email, 'role': member.role, 'skills': member.skills, 'is_creator': member.is_creator,
        'user_id': member.user_id, 'github_connected': bool(profile),
        'github_login': profile.github_login if profile else '',
        'profile_skills': profile.skills if profile else [],
        'preferred_roles': profile.preferred_roles if profile else [],
        'availability_hours': profile.availability_hours if profile else None,
        'learning_goals': profile.learning_goals if profile else '',
        'github_technologies': profile.technologies if profile else [],
        'github_evidence': profile.evidence if profile else [],
        'profile_analysis_status': profile.analysis_status if profile else 'not_connected',
        'task_count': len(tasks), 'workload_hours': float(total), 'completed_tasks': done,
        'progress': int(done * 100 / len(tasks)) if tasks else 0}


def invitation_payload(invitation):
    invitation.refresh_expiry_status()
    return {'id': invitation.pk, 'email': invitation.email, 'name': invitation.name, 'role': invitation.role,
        'skills': invitation.skills, 'status': invitation.status, 'expires_at': invitation.expires_at,
        'created_at': invitation.created_at}


def email_delivery_configured():
    non_delivery_backends = {
        'django.core.mail.backends.console.EmailBackend',
        'django.core.mail.backends.locmem.EmailBackend',
        'django.core.mail.backends.filebased.EmailBackend',
        'django.core.mail.backends.dummy.EmailBackend',
    }
    return bool(getattr(settings, 'EMAIL_HOST', '') and getattr(settings, 'DEFAULT_FROM_EMAIL', '')
        and settings.EMAIL_BACKEND not in non_delivery_backends)


def create_invitation(project, request, invitee):
    token = secrets.token_urlsafe(32)
    invitation = TeamInvitation.objects.create(
        project=project, email=invitee['email'].strip().lower(), name=invitee.get('name', '').strip(),
        role=invitee.get('role', '').strip(), skills=invitee.get('skills') or [],
        token_hash=hashlib.sha256(token.encode()).hexdigest(), expires_at=timezone.now() + timedelta(days=7),
        invited_by=request.user if request and getattr(request, 'user', None) and request.user.is_authenticated else None,
    )
    base = getattr(settings, 'FRONTEND_BASE_URL', 'http://127.0.0.1:5173').rstrip('/')
    link = f'{base}/team/invite/{token}'
    delivery = 'link_only'
    if email_delivery_configured():
        try:
            sent = send_mail(
                f"You're invited to {(project.understanding or {}).get('project_name') or 'a UDAAN project'}",
                f"Accept your project team invitation: {link}\nThis invitation expires in 7 days.",
                settings.DEFAULT_FROM_EMAIL, [invitation.email], fail_silently=False,
            )
            delivery = 'sent' if sent else 'failed'
        except Exception:
            delivery = 'failed'
    result = invitation_payload(invitation)
    result.update({'invite_link': link, 'delivery': delivery})
    return result


def flatten_roadmap(project):
    roadmap = (project.workflow or {}).get('flight_plan') or {}
    result = []
    occurrences = {}
    milestones = roadmap.get('milestones') or []
    today = project.start_date or date.today()
    end = project.deadline or today + timedelta(days=max(len(milestones), 1) * 7)
    span = max((end - today).days, 1)
    for mi, milestone in enumerate(milestones):
        if not isinstance(milestone, dict):
            continue
        title = str(milestone.get('title') or f'Milestone {mi + 1}')[:240]
        for ti, raw in enumerate(milestone.get('tasks') or []):
            raw = {'title': raw} if isinstance(raw, str) else raw
            if not isinstance(raw, dict):
                continue
            task_title = str(raw.get('title') or '').strip()
            if not task_title:
                continue
            norm = re.sub(r'\W+', '-', f'{mi}-{title}-{task_title}'.lower()).strip('-')[:190]
            occurrences[norm] = occurrences.get(norm, 0) + 1
            key = f'{norm}-{occurrences[norm]}'
            effort = str(raw.get('effort_estimate') or '4 hours').lower()
            nums = [float(n) for n in re.findall(r'\d+(?:\.\d+)?', effort)]
            amount = sum(nums) / len(nums) if nums else 4
            if 'week' in effort: amount *= 30
            elif 'day' in effort: amount *= 6
            elif 'min' in effort: amount /= 60
            elif 'hour' not in effort and not nums: amount = 4
            target = raw.get('target_date') or milestone.get('target_date')
            if not target:
                target = (today + timedelta(days=min(span, round(span * (mi + 1) / max(len(milestones), 1))))).isoformat()
            try: deadline = date.fromisoformat(str(target)[:10])
            except ValueError: deadline = end
            dependencies = raw.get('dependencies') or []
            if isinstance(dependencies, str): dependencies = [part.strip() for part in dependencies.splitlines() if part.strip()]
            elif not isinstance(dependencies, list): dependencies = []
            skills = raw.get('required_skills') or []
            if isinstance(skills, str): skills = [part.strip() for part in skills.splitlines() if part.strip()]
            if not isinstance(skills, list): skills = []
            description = raw.get('description') or raw.get('subtasks') or ''
            if isinstance(description, list): description = '\n'.join(map(str, description))
            record = {'source_key': key, 'source_position': f'{mi}-{ti}', 'milestone': title, 'title': task_title,
                'description': str(description), 'priority': str(raw.get('priority') or 'medium').lower(),
                'effort_hours': Decimal(str(max(0.5, min(1000, round(amount, 1))))),
                'dependencies': dependencies, 'deadline': deadline,
                'deliverable': str(raw.get('acceptance_criteria') or ''), 'required_skills': skills,
                'suggested_role': str(raw.get('suggested_role') or '')}
            record['source_hash'] = hashlib.sha256(json.dumps({k: str(v) for k,v in record.items()}, sort_keys=True).encode()).hexdigest()
            result.append(record)
    return result


def automatic_assignments(records, members, existing_by_key=None):
    loads = {m.pk: sum((t.effort_hours for t in m.tasks.filter(active=True)), Decimal('0')) for m in members}
    candidates = [m for m in members if m.is_creator or m.name or m.role or m.skills] or members
    for record in sorted(records, key=lambda row: (row['deadline'], {'high': 0, 'medium': 1, 'low': 2}.get(row['priority'], 1), -row['effort_hours'])):
        previous = (existing_by_key or {}).get(record['source_key'])
        if previous and previous.assigned_to_id:
            record['assigned_to'] = previous.assigned_to
            continue
        role = record['suggested_role'].lower()
        skills = {str(s).lower() for s in record['required_skills']}
        def score(member):
            member_skills = {str(s).lower() for s in member.skills}
            overlap = len(skills & member_skills)
            role_match = int(bool(role and role in member.role.lower()))
            return (-(overlap + role_match * 2), loads[member.pk], member.slot)
        selected = min(candidates, key=score)
        record['assigned_to'] = selected
        loads[selected.pk] += record['effort_hours']


def allocation_basis(project):
    tasks = list(ProjectTask.objects.filter(project=project, active=True).order_by('id'))
    members = list(TeamMember.objects.filter(project=project).select_related('user').order_by('id'))
    task_data = [{'id': task.pk, 'title': task.title, 'milestone': task.milestone, 'skills': task.required_skills,
                  'description': task.description, 'deliverable': task.deliverable, 'priority': task.priority,
                  'hours': str(task.effort_hours), 'deadline': str(task.deadline), 'dependencies': task.dependencies,
                  'assigned_to': task.assigned_to_id, 'status': task.status} for task in tasks]
    member_data = []
    for member in members:
        profile = DeveloperProfile.objects.filter(user=member.user).first() if member.user_id else None
        current_hours = member.tasks.filter(active=True).aggregate(total=models.Sum('effort_hours'))['total'] or Decimal('0')
        member_data.append({'id': member.pk, 'role': member.role, 'skills': member.skills,
            'profile_skills': profile.skills if profile else [], 'roles': profile.preferred_roles if profile else [],
            'availability': profile.availability_hours if profile else None,
            'experience': profile.experience if profile else '', 'learning_goals': profile.learning_goals if profile else '',
            'technologies': profile.technologies if profile else [], 'current_workload_hours': float(current_hours)})
    packed = json.dumps({'tasks': task_data, 'members': member_data}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(packed.encode()).hexdigest(), tasks, members, task_data, member_data


def heuristic_allocation(task_data, member_data):
    loads = {member['id']: float(member['current_workload_hours']) for member in member_data}
    assignments = []
    for task in sorted(task_data, key=lambda row: (row['deadline'] or '9999', row['id'])):
        required = {str(value).strip().casefold() for value in task['skills'] if str(value).strip()}
        scored = []
        for member in member_data:
            skills = {str(value).strip().casefold() for value in member['skills'] + member['profile_skills']}
            tech = {str(item.get('name') or '').casefold() for item in member['technologies'] if isinstance(item, dict)}
            roles = {str(value).strip().casefold() for value in member['roles']}
            if member['role']:
                roles.add(member['role'].casefold())
            matches = sorted(required & (skills | tech))
            role_match = any(role and role in task['title'].casefold() + ' ' + task['milestone'].casefold() for role in roles)
            gaps = sorted(required - (skills | tech))
            capacity = max(int(member['availability'] or 10), 1)
            scored.append((-(len(matches) + (2 if role_match else 0)), loads[member['id']] / capacity, member['id'], member, matches, gaps, role_match))
        selected = min(scored, default=None)
        hours = float(task['hours'])
        if not selected or (required and not selected[4] and not selected[6]):
            assignments.append({'task_id': task['id'], 'member_id': 0,
                'reason': 'No joined member has matching declared skills or role evidence. Assign manually or update a member profile.',
                'matched_skills': [], 'skill_gaps': sorted(required)})
            continue
        _, _, _, member, matches, gaps, role_match = selected
        loads[member['id']] += hours
        if matches:
            reason = 'Matched declared skills: ' + ', '.join(matches)
        elif required and role_match:
            reason = 'Matched a preferred/member role; no task-specific skill match was declared.'
        else:
            reason = 'No required skills were listed; assignment uses declared availability and workload balance. Suitability is uncertain.'
        reason += f" Balanced against {loads[member['id']]:.1f} proposed hours and {member['availability'] or 10} available hours per week."
        if gaps:
            reason += ' Skill evidence is incomplete for: ' + ', '.join(gaps) + '.'
        assignments.append({'task_id': task['id'], 'member_id': member['id'], 'reason': reason,
            'matched_skills': matches, 'skill_gaps': gaps})
    return assignments


def allocation_payload(proposal, project):
    basis, tasks, members, _, _ = allocation_basis(project)
    return {'id': proposal.pk, 'status': proposal.status, 'summary': getattr(proposal, 'summary', ''),
        'source': getattr(proposal, 'source', 'gemini'), 'assignments': proposal.assignments,
        'stale': proposal.source_hash != basis, 'created_at': proposal.created_at}


class MemberInput(serializers.Serializer):
    name = serializers.CharField(max_length=160, required=False, allow_blank=True)
    email = serializers.EmailField(required=False, allow_blank=True)
    role = serializers.CharField(max_length=120, required=False, allow_blank=True)
    skills = serializers.ListField(child=serializers.CharField(max_length=80), required=False)


class TaskInput(serializers.Serializer):
    title = serializers.CharField(max_length=240, required=False)
    description = serializers.CharField(required=False, allow_blank=True)
    assigned_to = serializers.IntegerField(required=False, allow_null=True)
    priority = serializers.ChoiceField(choices=['high', 'medium', 'low'], required=False)
    effort_hours = serializers.DecimalField(max_digits=8, decimal_places=1, min_value=Decimal('0.1'), required=False)
    dependencies = serializers.ListField(child=serializers.CharField(max_length=240), required=False)
    deadline = serializers.DateField(required=False, allow_null=True)
    deliverable = serializers.CharField(required=False, allow_blank=True)
    status = serializers.ChoiceField(choices=['not_started', 'in_progress', 'blocked', 'completed'], required=False)
    required_skills = serializers.ListField(child=serializers.CharField(max_length=80), required=False)


class InviteeInput(serializers.Serializer):
    email = serializers.EmailField()
    name = serializers.CharField(max_length=160, required=False, allow_blank=True)
    role = serializers.CharField(max_length=120, required=False, allow_blank=True)
    skills = serializers.ListField(child=serializers.CharField(max_length=80), required=False, default=list)


class InvitationBatchInput(serializers.Serializer):
    invitees = serializers.ListField(child=InviteeInput(), min_length=1, max_length=20)

    def validate_invitees(self, invitees):
        normalized = [entry['email'].strip().casefold() for entry in invitees]
        if len(set(normalized)) != len(normalized):
            raise serializers.ValidationError('Remove duplicate email addresses from this invitation list.')
        return invitees


@method_decorator(ensure_csrf_cookie, name='dispatch')
class TeamWorkspaceView(APIView):
    def get(self, request, draft_id):
        project = get_object_or_404(accessible_drafts(request), pk=draft_id)
        members = ensure_member_slots(project, current_user=request.user)
        tasks = list(ProjectTask.objects.filter(project=project, active=True).select_related('assigned_to'))
        flight_plan = (project.workflow or {}).get('flight_plan') or {}
        invitations = list(project.team_invitations.all())
        for invitation in invitations:
            invitation.refresh_expiry_status()
        pending_count = sum(invitation.status == 'pending' for invitation in invitations)
        proposal = project.allocation_proposals.first()
        is_owner = (project.owner_id == request.user.pk) if request.user.is_authenticated else (project.owner_id is None)
        token = get_token(request)
        response = Response({'project': {'id': str(project.pk), 'name': (project.understanding or {}).get('project_name') or 'Untitled project',
            'team_size': project.team_size or 1, 'deadline': project.deadline, 'has_roadmap': bool(flight_plan.get('milestones')),
            'joined_count': len(members), 'pending_count': pending_count,
            'remaining_capacity': max(0, (project.team_size or 1) - len(members) - pending_count),
            'is_owner': is_owner},
            'members': [member_payload(m) for m in members], 'tasks': [task_payload(t) for t in tasks],
            'invitations': [invitation_payload(i) for i in invitations],
            'allocation_proposal': allocation_payload(proposal, project) if proposal else None,
            'unassigned_tasks': sum(t.assigned_to_id is None for t in tasks),
            'csrf_token': token})
        response['X-CSRFToken'] = token
        return response

    def post(self, request, draft_id):
        project = get_object_or_404(accessible_drafts(request), pk=draft_id)
        if request.user.is_authenticated and project.owner_id != request.user.pk:
            return Response({'error': 'Only the project owner can modify team configuration.', 'code': 'permission_denied'}, status=status.HTTP_403_FORBIDDEN)
        members = ensure_member_slots(project, current_user=request.user)
        return Response({'members': [member_payload(m) for m in members]}, status=status.HTTP_200_OK)

    def patch(self, request, draft_id):
        project = get_object_or_404(accessible_drafts(request), pk=draft_id)
        if request.user.is_authenticated and project.owner_id != request.user.pk:
            return Response({'error': 'Only the project owner can change team capacity.', 'code': 'permission_denied'}, status=status.HTTP_403_FORBIDDEN)
        try: new_size = int(request.data.get('team_size'))
        except (TypeError, ValueError): return Response({'error': 'Team size must be a whole number.'}, status=400)
        if not 1 <= new_size <= 50: return Response({'error': 'Team size must be between 1 and 50.'}, status=400)
        project.team_size = new_size
        project.save(update_fields=['team_size', 'updated_at'])
        members = ensure_member_slots(project, current_user=request.user)
        return Response({'team_size': new_size, 'members': [member_payload(m) for m in members]})


class TeamMemberView(APIView):
    def patch(self, request, draft_id, member_id):
        project = get_object_or_404(accessible_drafts(request), pk=draft_id)
        member = get_object_or_404(TeamMember, project=project, pk=member_id)
        is_owner = (project.owner_id == request.user.pk) if request.user.is_authenticated else (project.owner_id is None)
        user_email = (request.user.email or '').strip().casefold() if request.user.is_authenticated else ''
        member_email = (member.email or '').strip().casefold()
        is_self = (member.user_id == request.user.pk) or bool(user_email and member_email and user_email == member_email) if request.user.is_authenticated else member.is_creator
        if request.user.is_authenticated and not is_owner and not is_self:
            return Response({'error': 'Only the project owner or this member can edit these details.'}, status=403)
        serializer = MemberInput(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data.get('email', '').strip()
        if email and TeamMember.objects.filter(project=project, email__iexact=email).exclude(pk=member.pk).exists():
            return Response({'error': 'This email already belongs to another joined member.'}, status=409)
        if email and TeamInvitation.objects.filter(project=project, email__iexact=email, status='pending').exists():
            return Response({'error': 'This email already has a pending team invitation.'}, status=409)
        for key, value in serializer.validated_data.items(): setattr(member, key, value)
        member.save()
        return Response(member_payload(member))

    def delete(self, request, draft_id, member_id):
        project = get_object_or_404(accessible_drafts(request), pk=draft_id)
        member = get_object_or_404(TeamMember, project=project, pk=member_id)
        is_owner = (project.owner_id == request.user.pk) if request.user.is_authenticated else (project.owner_id is None)
        user_email = (request.user.email or '').strip().casefold() if request.user.is_authenticated else ''
        member_email = (member.email or '').strip().casefold()
        is_self = (member.user_id == request.user.pk) or bool(user_email and member_email and user_email == member_email) if request.user.is_authenticated else member.is_creator
        if request.user.is_authenticated and not is_owner and not is_self:
            return Response({'error': 'Only the project owner or this member can remove this membership.'}, status=403)
        if member.is_creator:
            return Response({'error': 'The project creator cannot be removed from the team.'}, status=409)
        assigned = list(member.tasks.filter(active=True).values('id', 'title'))
        if assigned:
            return Response({'error': 'Reassign this member’s active tasks before removing them.', 'code': 'member_has_assigned_tasks', 'assigned_tasks': assigned}, status=409)
        member.delete()
        return Response(status=204)


class RoadmapTaskSyncView(APIView):
    def post(self, request, draft_id):
        project = get_object_or_404(accessible_drafts(request), pk=draft_id)
        records = flatten_roadmap(project)
        members = ensure_member_slots(project)
        existing = {t.source_key: t for t in ProjectTask.objects.filter(project=project)}
        changes = {'new': [], 'modified': [], 'removed': []}
        for row in records:
            old = existing.get(row['source_key'])
            if not old: changes['new'].append({'title': row['title'], 'milestone': row['milestone']})
            elif old.source_hash != row['source_hash'] and old.active: changes['modified'].append({'title': row['title'], 'milestone': row['milestone']})
        incoming = {r['source_key'] for r in records}
        changes['removed'] = [{'title': t.title, 'milestone': t.milestone} for key,t in existing.items() if t.active and key not in incoming]
        if request.data.get('preview') is True or request.data.get('confirm') is not True:
            return Response({'changes': changes, 'requires_confirmation': bool(existing and any(changes.values()))})
        with transaction.atomic():
            for row in records:
                old = existing.get(row['source_key'])
                values = {k:v for k,v in row.items() if k != 'source_key' and k != 'suggested_role'}
                values['active'] = True
                if old:
                    # Existing user edits and progress survive a roadmap refresh.
                    if old.source_hash == row['source_hash']:
                        continue
                    for key in ('title', 'description', 'milestone', 'source_position', 'priority', 'effort_hours', 'dependencies', 'deadline', 'deliverable', 'required_skills'):
                        setattr(old, key, values[key])
                    old.source_hash = row['source_hash']; old.active = True
                    if old.assigned_to_id is None: old.assigned_to = row.get('assigned_to')
                    old.save()
                else: ProjectTask.objects.create(project=project, source_key=row['source_key'], **values)
            ProjectTask.objects.filter(project=project, active=True).exclude(source_key__in=incoming).update(active=False)
        return Response({'changes': changes, 'created_or_updated': len(records)})


class TeamTaskView(APIView):
    def patch(self, request, draft_id, task_id):
        project = get_object_or_404(accessible_drafts(request), pk=draft_id)
        task = get_object_or_404(ProjectTask, project=project, pk=task_id, active=True)
        serializer = TaskInput(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        values = serializer.validated_data
        if 'assigned_to' in values:
            member_id = values.pop('assigned_to')
            task.assigned_to = get_object_or_404(TeamMember, project=project, pk=member_id) if member_id else None
        for key, value in values.items(): setattr(task, key, value)
        task.save()
        return Response(task_payload(task))


class TeamAllocationProposalView(APIView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'allocation_ai'

    def post(self, request, draft_id):
        project = get_object_or_404(accessible_drafts(request), pk=draft_id)
        basis, tasks, members, task_data, member_data = allocation_basis(project)
        if not tasks:
            return Response({'error': 'Sync the Flight Plan first so there are roadmap tasks to allocate.'}, status=409)
        model_tasks = [{'id': task.pk, 'title': task.title, 'milestone': task.milestone, 'description': task.description, 'deliverable': task.deliverable,
            'required_skills': task.required_skills, 'effort_hours': float(task.effort_hours), 'deadline': task.deadline,
            'dependencies': task.dependencies, 'priority': task.priority, 'current_assignee': task.assigned_to.display_name if task.assigned_to_id else None}
            for task in tasks]
        model_members = []
        for member, data in zip(members, member_data):
            data.update({'name': member.display_name, 'member_role': member.role,
            'existing_workload_hours': data['current_workload_hours']})
            model_members.append(data)
        summary = ''
        source = 'gemini'
        try:
            result = generate_task_allocation(project={'name': (project.understanding or {}).get('project_name', ''),
                'idea': project.idea[:800], 'project_type': project.project_type, 'deadline': str(project.deadline or '')},
                tasks=model_tasks, members=model_members)
            proposed = result['assignments']
            summary = result['summary']
        except (GeminiConfigurationError, GeminiRequestError):
            source = 'heuristic'
            proposed = heuristic_allocation(task_data, member_data)
            summary = 'Gemini is unavailable or returned an invalid proposal. This deterministic skills-and-workload suggestion is ready for your review.'

        task_by_id = {task.pk: task for task in tasks}
        member_by_id = {member.pk: (member, data) for member, data in zip(members, member_data)}
        validated = []
        for row in proposed:
            task_id = row['task_id']
            member_id = row['member_id'] or None
            task = task_by_id[task_id]
            invalid_member = bool(member_id and member_id not in member_by_id)
            if invalid_member:
                member_id = None
            required = {str(value).strip().casefold() for value in task.required_skills if str(value).strip()}
            matches, gaps, reason = [], sorted(required), ('Suggested member is not currently in this project; left unassigned.' if invalid_member else row.get('reason', ''))
            if member_id:
                member, data = member_by_id[member_id]
                declared = {str(value).strip().casefold() for value in member.skills + data['profile_skills']}
                observed = {str(item.get('name') or '').strip().casefold() for item in data['technologies'] if isinstance(item, dict)}
                declared_matches = sorted(required & declared)
                technology_matches = sorted(required & observed)
                matches = sorted(set(declared_matches + technology_matches))
                gaps = sorted(required - (declared | observed))
                preferred = [str(value).strip().casefold() for value in data['roles']]
                role_match = any(role and (role in task.title.casefold() or role in task.milestone.casefold()) for role in preferred)
                if required and not matches and not role_match:
                    member_id = None
                    reason = 'No matching skills or task-relevant preferred role were found in this member profile.'
                elif matches:
                    evidence_parts = []
                    if declared_matches:
                        evidence_parts.append('Self-declared skills: ' + ', '.join(declared_matches))
                    if technology_matches:
                        evidence_parts.append('GitHub repository language metadata suggests exposure to: ' + ', '.join(technology_matches) + ' (not proficiency)')
                    reason = '; '.join(evidence_parts) + ('.' if not gaps else f". No profile evidence for: {', '.join(gaps)}.")
                elif role_match:
                    reason = 'Task wording aligns with this member’s stated preferred role; required skill evidence is incomplete.'
                elif not required:
                    reason = 'No required skills were listed. This suggestion balances estimated workload; suitability is uncertain.'
            validated.append({'task_id': task_id, 'member_id': member_id or 0, 'reason': str(reason)[:600],
                'matched_skills': matches, 'skill_gaps': gaps, 'effort_hours': float(task.effort_hours),
                'deadline': str(task.deadline or ''), 'task_title': task.title, 'milestone': task.milestone})
        with transaction.atomic():
            latest = project.allocation_proposals.select_for_update().first()
            if latest and latest.status == 'pending' and latest.source_hash == basis:
                return Response(allocation_payload(latest, project))
            project.allocation_proposals.filter(status='pending').update(status='superseded')
            proposal = TaskAllocationProposal.objects.create(project=project, assignments=validated, summary=summary[:1200],
                source=source, source_hash=basis, generated_by=request.user if request.user.is_authenticated else None)
        return Response(allocation_payload(proposal, project), status=201)


class TeamAllocationApprovalView(APIView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'allocation_ai'
    def post(self, request, draft_id, proposal_id):
        project = get_object_or_404(accessible_drafts(request), pk=draft_id)
        if request.user.is_authenticated and project.owner_id != request.user.pk:
            return Response({'error': 'Only the project owner can approve task allocations.', 'code': 'permission_denied'}, status=status.HTTP_403_FORBIDDEN)
        with transaction.atomic():
            proposal = get_object_or_404(TaskAllocationProposal.objects.select_for_update(), project=project, pk=proposal_id, status='pending')
            basis, tasks, members, _, _ = allocation_basis(project)
            if basis != proposal.source_hash:
                return Response({'error': 'The team or Flight Plan changed since this proposal. Generate a fresh review before approving.', 'code': 'proposal_stale'}, status=409)
            assignments = request.data.get('assignments', proposal.assignments)
            if not isinstance(assignments, list) or len(assignments) != len(tasks):
                return Response({'error': 'Review every active task before approving this proposal.'}, status=400)
            task_ids = {task.pk for task in tasks}
            member_ids = {member.pk for member in members}
            parsed = {}
            for row in assignments:
                if not isinstance(row, dict) or not isinstance(row.get('task_id'), int):
                    return Response({'error': 'An allocation row is malformed.'}, status=400)
                task_id = row['task_id']
                member_id = row.get('member_id') or None
                if task_id not in task_ids or task_id in parsed or (member_id is not None and member_id not in member_ids):
                    return Response({'error': 'Assignments must refer to each real task once and only joined members.'}, status=400)
                parsed[task_id] = member_id
            if set(parsed) != task_ids:
                return Response({'error': 'Review every active task before approving this proposal.'}, status=400)
            task_map = {task.pk: task for task in tasks}
            for task_id, member_id in parsed.items():
                task = task_map[task_id]
                task.assigned_to_id = member_id
                task.save(update_fields=['assigned_to', 'updated_at'])
            proposal.assignments = [{**row, 'member_id': parsed[row['task_id']] or 0} for row in proposal.assignments]
            proposal.status = 'approved'
            proposal.approved_at = timezone.now()
            proposal.source_hash = allocation_basis(project)[0]
            proposal.save(update_fields=['assignments', 'status', 'approved_at', 'source_hash'])
        return Response(allocation_payload(proposal, project))


class TeamInvitationCollectionView(APIView):
    def get(self, request, draft_id):
        project = get_object_or_404(accessible_drafts(request), pk=draft_id)
        invitations = list(project.team_invitations.all())
        return Response({'invitations': [invitation_payload(item) for item in invitations]})

    def post(self, request, draft_id):
        serializer = InvitationBatchInput(data=request.data)
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            project = get_object_or_404(accessible_drafts(request).select_for_update(), pk=draft_id)
            if request.user.is_authenticated and project.owner_id != request.user.pk:
                return Response({'error': 'Only the project owner can invite team members.', 'code': 'permission_denied'}, status=status.HTTP_403_FORBIDDEN)
            ensure_member_slots(project, current_user=request.user)
            members = list(TeamMember.objects.filter(project=project))
            invitations = list(TeamInvitation.objects.select_for_update().filter(project=project))
            for invitation in invitations:
                invitation.refresh_expiry_status()
            active_emails = {member.email.strip().casefold() for member in members if member.email.strip()}
            active_emails.update(invitation.email.strip().casefold() for invitation in invitations if invitation.status == 'pending')
            invitees = serializer.validated_data['invitees']
            requested = [invitee['email'].strip().casefold() for invitee in invitees]
            duplicates = sorted(set(requested) & active_emails)
            if duplicates:
                return Response({'error': f"Already a team member or has a pending invitation: {', '.join(duplicates)}", 'code': 'duplicate_invitation'}, status=409)
            if len(set(requested)) != len(requested):
                return Response({'error': 'Remove duplicate email addresses from this invitation list.'}, status=400)
            pending_count = sum(invitation.status == 'pending' for invitation in invitations)
            remaining = max(0, (project.team_size or 1) - len(members) - pending_count)
            if len(invitees) > remaining:
                return Response({'error': f'Only {remaining} invitation slot(s) remain in this project capacity.', 'code': 'capacity_exceeded', 'remaining_capacity': remaining}, status=409)
            created = [create_invitation(project, request, invitee) for invitee in invitees]
        return Response({'invitations': created, 'message': 'Invitation records created. Check delivery status for each address.'}, status=201)


class TeamInvitationManageView(APIView):
    def post(self, request, draft_id, invitation_id):
        project = get_object_or_404(accessible_drafts(request), pk=draft_id)
        if request.user.is_authenticated and project.owner_id != request.user.pk:
            return Response({'error': 'Only the project owner can manage invitations.', 'code': 'permission_denied'}, status=status.HTTP_403_FORBIDDEN)
        with transaction.atomic():
            invitation = get_object_or_404(TeamInvitation.objects.select_for_update(), project=project, pk=invitation_id)
            if invitation.refresh_expiry_status() not in ('pending', 'expired'):
                return Response({'error': 'Only pending or expired invitations can be resent.'}, status=409)
            if TeamMember.objects.filter(project=project, email__iexact=invitation.email).exists():
                return Response({'error': 'This email already belongs to a joined member.'}, status=409)
            token = secrets.token_urlsafe(32)
            invitation.token_hash = hashlib.sha256(token.encode()).hexdigest()
            invitation.status = 'pending'
            invitation.expires_at = timezone.now() + timedelta(days=7)
            invitation.save(update_fields=['token_hash', 'status', 'expires_at', 'updated_at'])
        result = invitation_payload(invitation)
        result['invite_link'] = f"{getattr(settings, 'FRONTEND_BASE_URL', 'http://127.0.0.1:5173').rstrip('/')}/team/invite/{token}"
        result['delivery'] = 'link_only'
        if email_delivery_configured():
            try:
                sent = send_mail('Your UDAAN team invitation', f"Accept your team invitation: {result['invite_link']}\nThis invitation expires in 7 days.", settings.DEFAULT_FROM_EMAIL, [invitation.email], fail_silently=False)
                result['delivery'] = 'sent' if sent else 'failed'
            except Exception:
                result['delivery'] = 'failed'
        return Response(result)

    def delete(self, request, draft_id, invitation_id):
        project = get_object_or_404(accessible_drafts(request), pk=draft_id)
        if request.user.is_authenticated and project.owner_id != request.user.pk:
            return Response({'error': 'Only the project owner can manage invitations.', 'code': 'permission_denied'}, status=status.HTTP_403_FORBIDDEN)
        invitation = get_object_or_404(TeamInvitation, project=project, pk=invitation_id)
        if invitation.status != 'pending':
            return Response({'error': 'Only pending invitations can be cancelled.'}, status=409)
        invitation.delete()
        return Response(status=204)


@method_decorator(ensure_csrf_cookie, name='dispatch')
class PublicTeamInvitationView(APIView):
    permission_classes = [AllowAny]

    def _invitation(self, token, lock=False):
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        queryset = TeamInvitation.objects.select_related('project')
        if lock:
            queryset = queryset.select_for_update()
        invitation = get_object_or_404(queryset, token_hash=token_hash)
        invitation.refresh_expiry_status()
        return invitation

    def get(self, request, token):
        invitation = self._invitation(token)
        if invitation.status != 'pending':
            return Response({'status': invitation.status, 'error': f'This invitation is {invitation.status}.'}, status=410)
        return Response({'status': invitation.status, 'email': invitation.email, 'name': invitation.name,
            'role': invitation.role, 'project_name': (invitation.project.understanding or {}).get('project_name') or 'UDAAN project',
            'expires_at': invitation.expires_at})

    def post(self, request, token):
        decision = request.data.get('decision')
        if decision not in ('accept', 'decline'):
            return Response({'error': 'Choose accept or decline.'}, status=400)
        with transaction.atomic():
            invitation = self._invitation(token, lock=True)
            if invitation.status != 'pending':
                return Response({'status': invitation.status, 'error': f'This invitation is {invitation.status}.'}, status=410)
            if decision == 'decline':
                invitation.status = 'declined'
                invitation.save(update_fields=['status', 'updated_at'])
                return Response({'status': 'declined'})
            if not request.user.is_authenticated:
                return Response({'error': 'Sign in with GitHub before accepting this team invitation.', 'code': 'authentication_required'}, status=401)
            project = ProjectDraft.objects.select_for_update().get(pk=invitation.project_id)
            if not request.user.is_authenticated:
                return Response({'error': 'Sign in using the GitHub account you want to associate with this invitation.', 'code': 'authentication_required'}, status=401)
            if not request.user.email or request.user.email.casefold() != invitation.email.casefold():
                return Response({'error': 'Sign in using the email address this invitation was sent to.'}, status=403)
            if TeamMember.objects.filter(project=project, email__iexact=invitation.email).exists():
                return Response({'error': 'This email already belongs to a joined member.'}, status=409)
            current_count = TeamMember.objects.filter(project=project).count()
            if current_count >= (project.team_size or 1):
                return Response({'error': 'The project is at capacity. Ask the project owner to increase the team size.'}, status=409)
            used_slots = set(TeamMember.objects.filter(project=project).values_list('slot', flat=True))
            slot = next((candidate for candidate in range(2, (project.team_size or 1) + 1) if candidate not in used_slots), None)
            if slot is None:
                return Response({'error': 'The project is at capacity. Ask the project owner to increase the team size.'}, status=409)
            member = TeamMember.objects.create(project=project, slot=slot, name=invitation.name, email=invitation.email,
                role=invitation.role, skills=invitation.skills, user=request.user if request.user.is_authenticated else None)
            invitation.status = 'accepted'
            invitation.member = member
            invitation.save(update_fields=['status', 'member', 'updated_at'])
        return Response({'status': 'accepted', 'member': member_payload(member),
            'project': {'id': str(project.pk), 'name': (project.understanding or {}).get('project_name') or 'UDAAN project'}})
