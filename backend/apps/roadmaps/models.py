from django.db import models
from apps.projects.models import ProjectDraft
from apps.teams.models import TeamMember


class ProjectTask(models.Model):
    STATUS_CHOICES = [('not_started', 'Not Started'), ('in_progress', 'In Progress'), ('blocked', 'Blocked'), ('completed', 'Completed')]
    PRIORITY_CHOICES = [('high', 'High'), ('medium', 'Medium'), ('low', 'Low')]
    project = models.ForeignKey(ProjectDraft, on_delete=models.CASCADE, related_name='team_tasks')
    source_key = models.CharField(max_length=220)
    source_position = models.CharField(max_length=32, blank=True, default='')
    milestone = models.CharField(max_length=240, blank=True, default='')
    title = models.CharField(max_length=240)
    description = models.TextField(blank=True, default='')
    assigned_to = models.ForeignKey(TeamMember, null=True, blank=True, on_delete=models.SET_NULL, related_name='tasks')
    priority = models.CharField(max_length=8, choices=PRIORITY_CHOICES, default='medium')
    effort_hours = models.DecimalField(max_digits=8, decimal_places=1, default=4)
    dependencies = models.JSONField(default=list, blank=True)
    deadline = models.DateField(null=True, blank=True)
    deliverable = models.TextField(blank=True, default='')
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default='not_started')
    required_skills = models.JSONField(default=list, blank=True)
    active = models.BooleanField(default=True)
    source_hash = models.CharField(max_length=64, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['deadline', 'milestone', 'id']
        constraints = [models.UniqueConstraint(fields=['project', 'source_key'], name='roadmap_task_unique_project_source')]
