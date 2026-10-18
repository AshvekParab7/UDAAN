import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('projects', '0001_initial')]

    operations = [
        migrations.AddField(
            model_name='projectdraft',
            name='attachment',
            field=models.JSONField(blank=True, default=None, null=True),
        ),
        migrations.CreateModel(
            name='ProjectStageGeneration',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('stage', models.CharField(choices=[('research', 'Research'), ('feasibility', 'Feasibility'), ('flight_plan', 'Flight plan')], max_length=24)),
                ('status', models.CharField(choices=[('not_started', 'Not started'), ('queued', 'Queued'), ('generating', 'Generating'), ('completed', 'Completed'), ('failed', 'Failed'), ('stale', 'Stale')], default='not_started', max_length=16)),
                ('input_hash', models.CharField(max_length=64)),
                ('target_hash', models.CharField(max_length=64)),
                ('manually_edited', models.BooleanField(default=False)),
                ('has_generated_result', models.BooleanField(default=False)),
                ('rerun_requested', models.BooleanField(default=False)),
                ('attempts', models.PositiveSmallIntegerField(default=0)),
                ('error', models.TextField(blank=True, default='')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('started_at', models.DateTimeField(blank=True, null=True)),
                ('finished_at', models.DateTimeField(blank=True, null=True)),
                ('project', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='stage_generations', to='projects.projectdraft')),
            ],
            options={
                'constraints': [models.UniqueConstraint(fields=('project', 'stage'), name='unique_project_stage_generation')],
                'indexes': [models.Index(fields=['status', 'created_at'], name='stagegen_status_created_idx')],
            },
        ),
    ]
