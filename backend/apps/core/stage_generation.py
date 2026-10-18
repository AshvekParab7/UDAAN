import hashlib
import json
import logging
import threading
import time

from django.db import IntegrityError, transaction
from django.db.models import F
from django.utils import timezone

from apps.projects.models import ProjectDraft, ProjectStageGeneration
from .gemini_service import generate_idea_stage

logger = logging.getLogger(__name__)
STAGE_ORDER = ('research', 'feasibility', 'flight_plan')
ACTIVE_STATUSES = ('queued', 'generating')


def _stage_payload(draft, stage):
    workflow = draft.workflow or {}
    payload = {
        'idea': draft.idea,
        'project_type': draft.project_type,
        'attachment': draft.attachment,
        'understanding': draft.understanding or {},
    }
    if stage in ('feasibility', 'flight_plan'):
        payload['research'] = workflow.get('research') or {}
    if stage == 'flight_plan':
        payload['feasibility'] = workflow.get('feasibility') or {}
        if draft.start_date:
            payload['start_date'] = draft.start_date.isoformat()
        if draft.deadline:
            payload['deadline'] = draft.deadline.isoformat()
        payload['team_size'] = draft.team_size
        payload['weekly_hours'] = draft.weekly_hours
    return payload


def _digest(value):
    encoded = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, default=str).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def stage_input_hash(draft, stage):
    return _digest(_stage_payload(draft, stage))


def stage_target_hash(draft, stage):
    return _digest((draft.workflow or {}).get(stage))


def stage_project_details(draft, stage):
    workflow = draft.workflow or {}
    details = {'understanding': draft.understanding or {}}
    if stage in ('feasibility', 'flight_plan'):
        details['research'] = workflow.get('research') or {}
    if stage == 'flight_plan':
        details['feasibility'] = workflow.get('feasibility') or {}
        if draft.start_date:
            details['start_date'] = draft.start_date.isoformat()
        if draft.deadline:
            details['deadline'] = draft.deadline.isoformat()
        details['team_size'] = draft.team_size
        details['weekly_hours'] = draft.weekly_hours
        details['completed_task_ids'] = workflow.get('flightPlanProgress', [])
    if draft.attachment:
        details['attachment'] = draft.attachment
    return details


def _has_content(value):
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, dict):
        return any(_has_content(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return any(_has_content(item) for item in value)
    return value is not None


def stage_prerequisite_ready(draft, stage):
    if stage == 'research':
        return _has_content(draft.understanding)
    upstream = 'research' if stage == 'feasibility' else 'feasibility'
    upstream_job = ProjectStageGeneration.objects.filter(project=draft, stage=upstream).first()
    if upstream_job and upstream_job.status in ACTIVE_STATUSES:
        return False
    return _has_content((draft.workflow or {}).get(upstream))


def _result_for(draft, stage):
    return (draft.workflow or {}).get(stage)


def serialize_generation(job, draft=None, requires_confirmation=False, stale_inputs=False):
    draft = draft or job.project
    return {
        'stage': job.stage,
        'status': job.status,
        'error': job.error,
        'result': _result_for(draft, job.stage),
        'manually_edited': job.manually_edited,
        'has_generated_result': job.has_generated_result,
        'requires_confirmation': requires_confirmation,
        'stale_inputs': stale_inputs,
        'attempts': job.attempts,
        'updated_at': job.updated_at,
    }


def enqueue_stage_generation(project_id, stage, *, retry=False, replace_edited=False):
    with transaction.atomic():
        draft = ProjectDraft.objects.select_for_update().get(pk=project_id)
        input_hash = stage_input_hash(draft, stage)
        target_hash = stage_target_hash(draft, stage)
        job = ProjectStageGeneration.objects.select_for_update().filter(project=draft, stage=stage).first()
        if job is None:
            try:
                with transaction.atomic():
                    job = ProjectStageGeneration.objects.create(project=draft, stage=stage, status='queued', input_hash=input_hash, target_hash=target_hash)
                trigger_background_worker()
                return job, False
            except IntegrityError:
                job = ProjectStageGeneration.objects.select_for_update().get(project=draft, stage=stage)

        if job.status in ACTIVE_STATUSES:
            if job.input_hash != input_hash:
                job.rerun_requested = True
                job.save(update_fields=['rerun_requested', 'updated_at'])
            return job, False

        if job.input_hash == input_hash and job.status == 'completed':
            return job, False
        if job.manually_edited and job.has_generated_result and not replace_edited:
            job.status = 'stale'
            job.error = 'This report contains your edits. Confirm before replacing it with a new generated version.'
            job.finished_at = timezone.now()
            job.save(update_fields=['status', 'error', 'finished_at', 'updated_at'])
            return job, True
        if job.input_hash == input_hash and job.status == 'failed' and not retry:
            return job, False

        job.status = 'queued'
        job.input_hash = input_hash
        job.target_hash = target_hash
        job.error = ''
        job.rerun_requested = False
        job.finished_at = None
        job.started_at = None
        if replace_edited:
            job.manually_edited = False
        job.save(update_fields=['status', 'input_hash', 'target_hash', 'error', 'rerun_requested', 'finished_at', 'started_at', 'manually_edited', 'updated_at'])
        trigger_background_worker()
        return job, False


def trigger_background_worker():
    """Ensure queued generation jobs are processed promptly even if no standalone worker process is running."""
    import sys
    if 'test' in sys.argv:
        return

    def _run():
        try:
            while True:
                job_id = claim_next_job()
                if job_id is None:
                    break
                process_generation_job(job_id)
        except Exception:
            logger.exception('In-process stage generation worker encountered an error')

    worker_thread = threading.Thread(target=_run, daemon=True)
    worker_thread.start()


def mark_draft_generation_changes(draft, previous_workflow, edited_stages=()):
    previous_workflow = previous_workflow or {}
    workflow = draft.workflow or {}
    changed = {stage for stage in STAGE_ORDER if previous_workflow.get(stage) != workflow.get(stage)}
    for stage in set(edited_stages) & set(STAGE_ORDER) & changed:
        job = ProjectStageGeneration.objects.select_for_update().filter(project=draft, stage=stage).first()
        if job is None:
            ProjectStageGeneration.objects.create(
                project=draft, stage=stage, status='not_started', manually_edited=True,
                input_hash=stage_input_hash(draft, stage), target_hash=stage_target_hash(draft, stage),
            )
        elif not job.manually_edited:
            job.manually_edited = True
            job.save(update_fields=['manually_edited', 'updated_at'])
    for job in ProjectStageGeneration.objects.select_for_update().filter(project=draft):
        update_fields = []
        latest_hash = stage_input_hash(draft, job.stage)
        if latest_hash != job.input_hash:
            if job.status == 'generating':
                if not job.rerun_requested:
                    job.rerun_requested = True
                    update_fields.append('rerun_requested')
            elif job.status in ('queued', 'completed', 'failed'):
                job.status = 'stale'
                job.error = 'Saved upstream information changed. Prepare this report again to use the latest details.'
                job.finished_at = timezone.now()
                update_fields.extend(['status', 'error', 'finished_at'])
        if update_fields:
            job.save(update_fields=[*set(update_fields), 'updated_at'])


def _merge_first_result(existing, generated):
    if isinstance(existing, dict) and isinstance(generated, dict):
        return {key: _merge_first_result(existing.get(key), value) for key, value in generated.items()}
    if isinstance(existing, list) and existing:
        return existing
    if isinstance(existing, str) and existing.strip():
        return existing
    return generated


def _stale_or_requeue(job, draft, *, message, target_changed=False):
    if target_changed and not job.manually_edited:
        job.manually_edited = True
    next_hash = stage_input_hash(draft, job.stage)
    if job.rerun_requested and not job.manually_edited and next_hash != job.input_hash:
        job.status = 'queued'
        job.input_hash = next_hash
        job.target_hash = stage_target_hash(draft, job.stage)
        job.error = ''
        job.rerun_requested = False
        job.started_at = None
        job.finished_at = None
    else:
        job.status = 'stale'
        job.error = message
        job.finished_at = timezone.now()
    job.save(update_fields=['status', 'input_hash', 'target_hash', 'manually_edited', 'error', 'rerun_requested', 'started_at', 'finished_at', 'updated_at'])
    return job.status == 'queued'


def process_generation_job(job_id):
    with transaction.atomic():
        job = ProjectStageGeneration.objects.select_for_update().select_related('project').get(pk=job_id)
        draft = ProjectDraft.objects.select_for_update().get(pk=job.project_id)
        if job.status != 'generating':
            return
        if stage_input_hash(draft, job.stage) != job.input_hash:
            if job.manually_edited and job.has_generated_result:
                _stale_or_requeue(job, draft, message='Saved upstream information changed before generation began.')
                return
            job.input_hash = stage_input_hash(draft, job.stage)
            job.save(update_fields=['input_hash', 'updated_at'])
        if stage_target_hash(draft, job.stage) != job.target_hash:
            if job.manually_edited and job.has_generated_result:
                _stale_or_requeue(job, draft, message='This stage was edited while generation was queued. Your saved content was kept.', target_changed=True)
                return
            job.target_hash = stage_target_hash(draft, job.stage)
            job.save(update_fields=['target_hash', 'updated_at'])
        if job.manually_edited and job.has_generated_result:
            job.status = 'stale'
            job.error = 'This report contains your edits. Confirm before replacing it with a new generated version.'
            job.finished_at = timezone.now()
            job.save(update_fields=['status', 'error', 'finished_at', 'updated_at'])
            return
        stage = job.stage
        idea = draft.idea
        project_type = draft.project_type
        project_details = stage_project_details(draft, stage)
        target_hash = job.target_hash
        input_hash = job.input_hash
        had_previous_result = job.has_generated_result

    try:
        result = generate_idea_stage(stage=stage, idea=idea, project_type=project_type, project_details=project_details)
    except Exception as error:
        logger.exception('Background %s generation failed for draft %s', stage, job.project_id)
        ProjectStageGeneration.objects.filter(pk=job_id, status='generating').update(
            status='failed', error=str(error)[:2000], finished_at=timezone.now(), updated_at=timezone.now(),
        )
        return

    should_queue_next = False
    with transaction.atomic():
        job = ProjectStageGeneration.objects.select_for_update().get(pk=job_id)
        draft = ProjectDraft.objects.select_for_update().get(pk=job.project_id)
        if job.status != 'generating':
            return
        if stage_target_hash(draft, stage) != target_hash and job.manually_edited and job.has_generated_result:
            _stale_or_requeue(job, draft, message='This stage was edited during generation. Your saved content was kept.', target_changed=True)
            return
        workflow = dict(draft.workflow or {})
        if not had_previous_result and workflow.get(stage):
            result = _merge_first_result(workflow[stage], result)
        workflow[stage] = result
        draft.workflow = workflow
        draft.save(update_fields=['workflow', 'updated_at'])
        job.status = 'completed'
        job.has_generated_result = True
        job.error = ''
        job.input_hash = stage_input_hash(draft, stage)
        job.target_hash = stage_target_hash(draft, stage)
        job.finished_at = timezone.now()
        job.save(update_fields=['status', 'has_generated_result', 'error', 'input_hash', 'target_hash', 'finished_at', 'updated_at'])
        should_queue_next = stage in ('research', 'feasibility')

    if should_queue_next:
        next_stage = STAGE_ORDER[STAGE_ORDER.index(stage) + 1]
        try:
            enqueue_stage_generation(job.project_id, next_stage)
        except Exception:
            logger.exception('Could not queue next stage %s for draft %s', next_stage, job.project_id)


def claim_next_job():
    candidate = ProjectStageGeneration.objects.filter(status='queued').order_by('created_at').first()
    if not candidate:
        return None
    now = timezone.now()
    claimed = ProjectStageGeneration.objects.filter(pk=candidate.pk, status='queued').update(status='generating', started_at=now, finished_at=None, attempts=F('attempts') + 1, updated_at=now)
    return candidate.pk if claimed else None


def run_worker(*, poll_interval=2, once=False, stop_event=None):
    while True:
        job_id = claim_next_job()
        if job_id is not None:
            process_generation_job(job_id)
            continue
        if once or (stop_event is not None and stop_event.is_set()):
            return
        time.sleep(max(0.25, poll_interval))
