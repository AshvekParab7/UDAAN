import uuid
from django.db import models
from apps.projects.models import ProjectDraft


RUN_STATUS_CHOICES = [
    ('queued', 'Queued'),
    ('starting', 'Starting'),
    ('running', 'Running'),
    ('paused', 'Paused'),
    ('completed', 'Completed'),
    ('failed', 'Failed'),
    ('cancelled', 'Cancelled'),
]

STEP_STATUS_CHOICES = [
    ('pending', 'Pending'),
    ('running', 'Running'),
    ('passed', 'Passed'),
    ('failed', 'Failed'),
    ('blocked', 'Blocked'),
    ('skipped', 'Skipped'),
    ('inconclusive', 'Inconclusive'),
]


class TestRun(models.Model):
    """A single TestPilot execution run for a project and target URL."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        ProjectDraft, on_delete=models.CASCADE, related_name='test_runs',
        null=True, blank=True,
    )
    created_by = models.ForeignKey(
        'auth.User', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='test_runs_created',
    )

    target_url = models.URLField(max_length=512)
    objective = models.TextField(blank=True, default='')
    mode = models.CharField(max_length=32, default='smoke', choices=[
        ('smoke', 'Quick Smoke Test'),
        ('full', 'Full Workflow Test'),
    ])

    status = models.CharField(max_length=20, choices=RUN_STATUS_CHOICES, default='queued')

    # Stored test plan (JSON list of step dicts)
    test_plan = models.JSONField(default=list, blank=True)
    # Final results summary
    results_summary = models.JSONField(default=dict, blank=True)

    started_at  = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    created_at  = models.DateTimeField(auto_now_add=True)
    updated_at  = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f'TestRun {self.id} [{self.status}] → {self.target_url}'


class TestStep(models.Model):
    """A single step within a TestRun — one browser action + assertion."""

    run = models.ForeignKey(TestRun, on_delete=models.CASCADE, related_name='steps')
    index = models.PositiveSmallIntegerField(default=0)

    description  = models.TextField()
    action_type  = models.CharField(max_length=64, blank=True, default='')
    action_args  = models.JSONField(default=dict, blank=True)
    expected     = models.TextField(blank=True, default='')
    actual       = models.TextField(blank=True, default='')
    status       = models.CharField(max_length=20, choices=STEP_STATUS_CHOICES, default='pending')
    error_message = models.TextField(blank=True, default='')

    # Path to screenshot relative to MEDIA_ROOT/testpilot/
    screenshot_path = models.CharField(max_length=512, blank=True, default='')
    # Duration in milliseconds
    duration_ms = models.PositiveIntegerField(null=True, blank=True)

    started_at  = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['index']

    def __str__(self):
        return f'Step {self.index}: {self.description[:60]} [{self.status}]'


class TestEvent(models.Model):
    """Append-only log of agent events for SSE streaming and report building."""

    run       = models.ForeignKey(TestRun, on_delete=models.CASCADE, related_name='events')
    seq       = models.PositiveIntegerField(default=0)   # monotonic sequence per run
    event_type = models.CharField(max_length=64)          # e.g. navigate, click, type, assert, screenshot, error
    message   = models.TextField(blank=True, default='')
    data      = models.JSONField(default=dict, blank=True)
    timestamp = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['seq']
