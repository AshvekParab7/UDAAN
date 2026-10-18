# Background stage generation

UDAAN persists stage-generation jobs in Django's database. The web application enqueues a stage only after its prerequisite draft data has been saved. A separate Django management-command worker calls the configured Gemini provider, validates and saves the completed output, and queues the next stage. The job row is unique for each draft and stage; conditional status updates prevent multiple worker processes from claiming the same queued row.

## Local development

From `backend/`, apply migrations and start the worker in a separate terminal alongside Django:

```powershell
.\.venv\Scripts\python.exe manage.py migrate
.\.venv\Scripts\python.exe manage.py runserver
.\.venv\Scripts\python.exe manage.py run_generation_worker --poll-interval 2
```

The worker needs the same Django settings and `GEMINI_API_KEY` configuration as the web process. `--once` processes all currently queued work (including chained stages) and exits, which is useful for a one-shot local check. Ctrl+C stops the worker cleanly. The worker is an independent process; generation is not tied to an open browser request.

Run one worker process for local SQLite development. The database-backed queue is intentionally small and can be moved to a dedicated task broker later if production volume calls for it. Configure at least one long-running worker process in production and monitor failed jobs through the generation status endpoint. Failed jobs remain saved and can be explicitly retried.
