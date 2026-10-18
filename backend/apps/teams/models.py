from django.conf import settings
from django.db import models
from django.utils import timezone
from apps.projects.models import ProjectDraft


class TeamMember(models.Model):
    project = models.ForeignKey(ProjectDraft, on_delete=models.CASCADE, related_name='team_members')
    slot = models.PositiveSmallIntegerField()
    name = models.CharField(max_length=160, blank=True, default='')
    email = models.EmailField(blank=True, default='')
    role = models.CharField(max_length=120, blank=True, default='')
    skills = models.JSONField(default=list, blank=True)
    is_creator = models.BooleanField(default=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name='udaan_team_memberships')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['slot']
        constraints = [models.UniqueConstraint(fields=['project', 'slot'], name='team_member_unique_project_slot')]

    @property
    def display_name(self):
        return self.name.strip() or ('Project creator' if self.is_creator else self.email or f'Member {self.slot}')


class TeamInvitation(models.Model):
    STATUSES = [('pending', 'Pending'), ('accepted', 'Accepted'), ('declined', 'Declined'), ('expired', 'Expired')]
    project = models.ForeignKey(ProjectDraft, on_delete=models.CASCADE, related_name='team_invitations')
    email = models.EmailField()
    name = models.CharField(max_length=160, blank=True, default='')
    role = models.CharField(max_length=120, blank=True, default='')
    skills = models.JSONField(default=list, blank=True)
    token_hash = models.CharField(max_length=64, unique=True)
    status = models.CharField(max_length=12, choices=STATUSES, default='pending')
    expires_at = models.DateTimeField()
    invited_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name='sent_team_invitations')
    member = models.OneToOneField(TeamMember, null=True, blank=True, on_delete=models.SET_NULL, related_name='invitation')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def refresh_expiry_status(self):
        if self.status == 'pending' and self.expires_at <= timezone.now():
            self.status = 'expired'
            self.save(update_fields=['status', 'updated_at'])
        return self.status
