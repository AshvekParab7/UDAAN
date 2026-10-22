import uuid

from django.db import models

from apps.projects.models import ProjectDraft


class ProjectHealthSnapshot(models.Model):
    """Persisted health score for a project at a point in time."""

    project = models.ForeignKey(ProjectDraft, on_delete=models.CASCADE, related_name='health_snapshots')
    score = models.PositiveSmallIntegerField(default=0)  # 0-100
    signals = models.JSONField(default=dict, blank=True)
    evidence_coverage = models.PositiveSmallIntegerField(default=0)  # 0-100 %
    computed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-computed_at']
        indexes = [
            models.Index(fields=['project', '-computed_at'], name='health_snap_proj_time_idx'),
        ]

    def __str__(self):
        return f'{self.project_id} score={self.score} @ {self.computed_at:%Y-%m-%d %H:%M}'


class ProjectPassport(models.Model):
    """Public sharing passport for a project health snapshot."""

    project = models.OneToOneField(ProjectDraft, on_delete=models.CASCADE, related_name='health_passport')
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    is_published = models.BooleanField(default=False)
    disclosed_fields = models.JSONField(default=list, blank=True)
    published_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-updated_at']

    def __str__(self):
        return f'{self.project_id} passport ({"published" if self.is_published else "draft"})'
