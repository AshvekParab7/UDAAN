from django.conf import settings
from django.db import models


class DeveloperProfile(models.Model):
    ANALYSIS_STATES = [('not_started', 'Not started'), ('complete', 'Complete'), ('partial', 'Partial'), ('unavailable', 'Unavailable')]
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='developer_profile')
    github_id = models.CharField(max_length=32, unique=True)
    github_login = models.CharField(max_length=80, blank=True, default='')
    avatar_url = models.URLField(blank=True, default='')
    profile_url = models.URLField(blank=True, default='')
    public_repositories = models.JSONField(default=list, blank=True)
    technologies = models.JSONField(default=list, blank=True)
    evidence = models.JSONField(default=list, blank=True)
    skills = models.JSONField(default=list, blank=True)
    experience = models.TextField(blank=True, default='')
    preferred_roles = models.JSONField(default=list, blank=True)
    availability_hours = models.PositiveSmallIntegerField(default=10)
    learning_goals = models.TextField(blank=True, default='')
    analysis_status = models.CharField(max_length=16, choices=ANALYSIS_STATES, default='not_started')
    analyzed_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)


class TaskAllocationProposal(models.Model):
    STATES = [('pending', 'Pending review'), ('approved', 'Approved'), ('superseded', 'Superseded')]
    project = models.ForeignKey('projects.ProjectDraft', on_delete=models.CASCADE, related_name='allocation_proposals')
    assignments = models.JSONField(default=list)
    summary = models.CharField(max_length=1200, blank=True, default='')
    source = models.CharField(max_length=24, default='gemini')
    status = models.CharField(max_length=12, choices=STATES, default='pending')
    source_hash = models.CharField(max_length=64)
    generated_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name='task_allocation_proposals')
    approved_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
