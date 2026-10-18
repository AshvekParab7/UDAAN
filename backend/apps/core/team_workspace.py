import hashlib
import json
import re
import secrets
from datetime import date, timedelta
from decimal import Decimal

from django.conf import settings
from django.core.mail import send_mail
from django.db import transaction
from django.utils import timezone
from django.shortcuts import get_object_or_404
from rest_framework import serializers, status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.projects.models import ProjectDraft
from apps.roadmaps.models import ProjectTask
from apps.teams.models import TeamInvitation, TeamMember


def owned_drafts(request):
    return ProjectDraft.objects.filter(owner=request.user) if request.user.is_authenticated else ProjectDraft.objects.filter(owner__isnull=True)


def ensure_member_slots(project, target_size=None):
    creator, _ = TeamMember.objects.get_or_create(project=project, slot=1, defaults={'is_creator': True})
    if not creator.is_creator:
        creator.is_creator = True
        creator.save(update_fields=['is_creator'])
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
    return {'id': member.pk, 'slot': member.slot, 'name': member.name, 'display_name': member.display_name,
        'email': member.email, 'role': member.role, 'skills': member.skills, 'is_creator': member.is_creator,
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
        invited_by=request.user if request.user.is_authenticated else None,
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


class TeamWorkspaceView(APIView):
    def get(self, request, draft_id):
        project = get_object_or_404(owned_drafts(request), pk=draft_id)
        members = ensure_member_slots(project)
        tasks = list(ProjectTask.objects.filter(project=project, active=True).select_related('assigned_to'))
        flight_plan = (project.workflow or {}).get('flight_plan') or {}
        invitations = list(project.team_invitations.all())
        for invitation in invitations:
            invitation.refresh_expiry_status()
        pending_count = sum(invitation.status == 'pending' for invitation in invitations)
        return Response({'project': {'id': str(project.pk), 'name': (project.understanding or {}).get('project_name') or 'Untitled project',
            'team_size': project.team_size or 1, 'deadline': project.deadline, 'has_roadmap': bool(flight_plan.get('milestones')),
            'joined_count': len(members), 'pending_count': pending_count,
            'remaining_capacity': max(0, (project.team_size or 1) - len(members) - pending_count)},
            'members': [member_payload(m) for m in members], 'tasks': [task_payload(t) for t in tasks],
            'invitations': [invitation_payload(i) for i in invitations],
            'unassigned_tasks': sum(t.assigned_to_id is None for t in tasks)})

    def post(self, request, draft_id):
        project = get_object_or_404(owned_drafts(request), pk=draft_id)
        members = ensure_member_slots(project)
        return Response({'members': [member_payload(m) for m in members]}, status=status.HTTP_200_OK)

    def patch(self, request, draft_id):
        project = get_object_or_404(owned_drafts(request), pk=draft_id)
        try: new_size = int(request.data.get('team_size'))
        except (TypeError, ValueError): return Response({'error': 'Team size must be a whole number.'}, status=400)
        if not 1 <= new_size <= 50: return Response({'error': 'Team size must be between 1 and 50.'}, status=400)
        project.team_size = new_size
        project.save(update_fields=['team_size', 'updated_at'])
        members = ensure_member_slots(project)
        return Response({'team_size': new_size, 'members': [member_payload(m) for m in members]})


class TeamMemberView(APIView):
    def patch(self, request, draft_id, member_id):
        project = get_object_or_404(owned_drafts(request), pk=draft_id)
        member = get_object_or_404(TeamMember, project=project, pk=member_id)
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
        project = get_object_or_404(owned_drafts(request), pk=draft_id)
        member = get_object_or_404(TeamMember, project=project, pk=member_id)
        if member.is_creator:
            return Response({'error': 'The project creator cannot be removed from the team.'}, status=409)
        assigned = list(member.tasks.filter(active=True).values('id', 'title'))
        if assigned:
            return Response({'error': 'Reassign this member’s active tasks before removing them.', 'code': 'member_has_assigned_tasks', 'assigned_tasks': assigned}, status=409)
        member.delete()
        return Response(status=204)


class RoadmapTaskSyncView(APIView):
    def post(self, request, draft_id):
        project = get_object_or_404(owned_drafts(request), pk=draft_id)
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
        automatic_assignments(records, members, existing)
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
        project = get_object_or_404(owned_drafts(request), pk=draft_id)
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


class TeamInvitationCollectionView(APIView):
    def get(self, request, draft_id):
        project = get_object_or_404(owned_drafts(request), pk=draft_id)
        invitations = list(project.team_invitations.all())
        return Response({'invitations': [invitation_payload(item) for item in invitations]})

    def post(self, request, draft_id):
        serializer = InvitationBatchInput(data=request.data)
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            project = get_object_or_404(owned_drafts(request).select_for_update(), pk=draft_id)
            ensure_member_slots(project)
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
        project = get_object_or_404(owned_drafts(request), pk=draft_id)
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
        project = get_object_or_404(owned_drafts(request), pk=draft_id)
        invitation = get_object_or_404(TeamInvitation, project=project, pk=invitation_id)
        if invitation.status != 'pending':
            return Response({'error': 'Only pending invitations can be cancelled.'}, status=409)
        invitation.delete()
        return Response(status=204)


class PublicTeamInvitationView(APIView):
    authentication_classes = []
    permission_classes = []

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
            project = ProjectDraft.objects.select_for_update().get(pk=invitation.project_id)
            if request.user.is_authenticated and request.user.email and request.user.email.casefold() != invitation.email.casefold():
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
