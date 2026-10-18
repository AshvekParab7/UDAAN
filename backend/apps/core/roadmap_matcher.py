import re
from datetime import datetime, timezone


def _clean_text(text):
    return re.sub(r'[^a-z0-9\s_-]', ' ', str(text or '').lower())


def _extract_keywords(text):
    stop_words = {
        'the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'have', 'are',
        'can', 'not', 'you', 'all', 'any', 'one', 'two', 'first', 'into', 'each',
        'out', 'about', 'more', 'when', 'what', 'where', 'how', 'make', 'such',
        'will', 'using', 'used', 'use', 'set', 'get', 'add', 'new', 'well', 'our',
    }
    words = [w.strip() for w in _clean_text(text).split() if len(w.strip()) >= 3]
    return [w for w in words if w not in stop_words]


def assess_task_against_evidence(*, task, milestone_index, task_index, milestone, analysis, repository_info, commit_sha, timestamp):
    """
    Deterministically assess a single roadmap task against repository analysis evidence.
    Statuses:
      - not_assessed
      - evidence_found
      - partially_implemented
      - mismatch_detected
      - verified (strictly requires checks to have passed)
      - manual_review
    """
    task_title = str(task.get('title') or '').strip()
    subtasks = [str(st).strip() for st in task.get('subtasks', []) if str(st).strip()]
    criteria = str(task.get('acceptance_criteria') or '').strip()
    dependencies = [str(dep).strip() for dep in task.get('dependencies', []) if str(dep).strip()]
    task_id = f'{milestone_index}-{task_index}'

    is_empty = repository_info.get('is_empty', False)
    evidence_files = analysis.get('evidenceFiles') or []
    if is_empty or not evidence_files:
        return {
            'taskId': task_id,
            'milestoneIndex': milestone_index,
            'taskIndex': task_index,
            'milestoneTitle': milestone.get('title', f'Milestone {milestone_index + 1}'),
            'taskTitle': task_title or f'Task {task_index + 1}',
            'status': 'not_assessed',
            'statusLabel': 'Not assessed',
            'explanation': 'The connected repository is empty; no source files exist to assess.',
            'evidence': [],
            'checks': [{'name': 'Static evidence scan', 'command': 'repository scan', 'status': 'not_run', 'reason': 'Repository has no source files.'}],
            'commit_sha': commit_sha or '',
            'timestamp': timestamp,
            'confidence': 'low',
            'user_override': None,
        }

    # Gather knowledge from repository analysis
    routes = (analysis.get('architecture') or {}).get('routes') or []
    requests = (analysis.get('insights') or {}).get('endpoints') or []
    findings = analysis.get('findings') or []
    test_files = (analysis.get('insights') or {}).get('testFiles') or []
    scripts = (analysis.get('insights') or {}).get('scripts') or {}
    config_files = (analysis.get('insights') or {}).get('configFiles') or []
    verification = analysis.get('verification') or []

    # Combined task context
    task_blob = f'{task_title} {" ".join(subtasks)} {criteria} {" ".join(dependencies)}'
    keywords = set(_extract_keywords(task_blob))

    matched_evidence = []
    matched_mismatches = []
    has_frontend_evidence = False
    has_backend_evidence = False
    has_model_evidence = False
    has_test_evidence = False

    # 1. Check Frontend Components & Routes
    fe_keywords = {'frontend', 'ui', 'component', 'page', 'screen', 'view', 'form', 'explorer', 'flight', 'plan', 'repository', 'setup', 'dashboard', 'overview', 'sidebar'}
    wants_frontend = bool(keywords & fe_keywords) or any(term in task_blob.lower() for term in ['react', 'jsx', 'tsx', 'css', 'page', 'ui', 'client'])

    for file_path in evidence_files:
        lower_path = file_path.lower()
        if not (lower_path.endswith('.jsx') or lower_path.endswith('.tsx') or lower_path.endswith('.js') or lower_path.endswith('.css')):
            continue
        base_name = lower_path.split('/')[-1].split('.')[0]
        # Match filename directly or key components
        if base_name in keywords or any(kw in lower_path for kw in ['flightplan', 'repository', 'projectsetup', 'ideaanalysis', 'maindashboard']):
            # Check relevance to this specific task
            matches_task = any(kw in lower_path for kw in keywords if len(kw) >= 4)
            if matches_task:
                matched_evidence.append({
                    'file': file_path,
                    'line': 1,
                    'text': f'Frontend implementation file: {file_path}',
                })
                has_frontend_evidence = True

    # 2. Check Backend Routes, Endpoints, Views, Serializers
    be_keywords = {'api', 'endpoint', 'route', 'backend', 'django', 'view', 'serializer', 'server', 'url', 'service', 'rest'}
    wants_backend = bool(keywords & be_keywords) or any(term in task_blob.lower() for term in ['django', 'endpoint', 'api', 'backend', 'view', 'url'])

    for route in routes:
        route_path = (route.get('path') or '').lower()
        view_name = (route.get('view') or '').lower()
        route_source = route.get('sourcePath') or ''
        # Check if route matches task keywords
        matches_route = any(kw in route_path or kw in view_name for kw in keywords if len(kw) >= 4)
        if matches_route:
            matched_evidence.append({
                'file': route_source or 'backend/apps/core/urls.py',
                'line': route.get('line') or 1,
                'text': f'Registered Django route: {route.get("path")} → {route.get("view") or "view"} ({", ".join(route.get("methods") or ["GET"])})',
            })
            has_backend_evidence = True

    # Check API client request sites in frontend
    for req in requests:
        req_path = (req.get('path') or '').lower()
        matches_req = any(kw in req_path for kw in keywords if len(kw) >= 4)
        if matches_req:
            matched_evidence.append({
                'file': req.get('sourcePath') or 'frontend/src/services/apiClient.js',
                'line': req.get('line') or 1,
                'text': f'Frontend API request site: {req.get("method", "GET")} {req.get("path")}',
            })

    # 3. Check Models and Migrations
    model_keywords = {'model', 'database', 'schema', 'migration', 'table', 'store', 'persistence', 'draft', 'project', 'repo', 'assessment', 'sql'}
    wants_model = bool(keywords & model_keywords) or any(term in task_blob.lower() for term in ['model', 'database', 'migration', 'storage'])

    for file_path in evidence_files:
        lower_path = file_path.lower()
        if 'models.py' in lower_path or 'migrations/' in lower_path:
            # Check if task mentions project, draft, repo, or assessment
            if any(term in task_blob.lower() for term in ['project', 'draft', 'repo', 'roadmap', 'assessment', 'stage', 'workflow']):
                matched_evidence.append({
                    'file': file_path,
                    'line': 1,
                    'text': f'Data model / persistence definition: {file_path}',
                })
                has_model_evidence = True
                break

    # 4. Check Tests and Declared Scripts
    test_keywords = {'test', 'verify', 'verification', 'check', 'validate', 'validation', 'spec', 'lint'}
    wants_test = bool(keywords & test_keywords) or any(term in task_blob.lower() for term in ['test', 'verify', 'acceptance criteria', 'validate'])

    for test_file in test_files:
        if any(kw in test_file.lower() for kw in keywords if len(kw) >= 4):
            matched_evidence.append({
                'file': test_file,
                'line': 1,
                'text': f'Relevant test suite: {test_file}',
            })
            has_test_evidence = True

    # 5. Check Analysis Findings for Blockers / Mismatches
    for finding in findings:
        finding_file = (finding.get('file') or '').lower()
        finding_endpoint = (finding.get('endpoint') or '').lower()
        file_match = bool(finding_file and any(
            (ev['file'].lower() in finding_file or finding_file in ev['file'].lower())
            for ev in matched_evidence if ev.get('file')
        ))
        endpoint_match = bool(finding_endpoint and any(
            finding_endpoint in ev.get('text', '').lower()
            for ev in matched_evidence
        ))
        affects_task = file_match or endpoint_match
        if affects_task and finding.get('severity') in ('high', 'medium'):
            matched_mismatches.append(finding)

    # 6. Checks evaluation (untrusted code execution is restricted)
    checks = []
    # Test execution rule: Untrusted repository code is not run directly inside Django server.
    if verification:
        for v in verification[:4]:
            checks.append({
                'name': v.get('name') or 'Check',
                'command': v.get('command') or '',
                'status': v.get('status') or 'not_run',
                'reason': v.get('reason') or 'Execution requires an isolated test runner; untrusted repository code is not executed in the server.',
            })
    else:
        checks.append({
            'name': 'Test verification',
            'command': 'test runner',
            'status': 'not_run',
            'reason': 'No isolated runner configured for connected repository execution.',
        })

    # Deduplicate evidence by (file, line)
    seen_evidence = set()
    deduped_evidence = []
    for ev in matched_evidence:
        key = (ev['file'], ev.get('line'))
        if key not in seen_evidence:
            seen_evidence.add(key)
            deduped_evidence.append(ev)

    # Status Determination
    status = 'not_assessed'
    status_label = 'Not assessed'
    explanation = ''
    confidence = 'medium'

    # Check for subjective/planning task that cannot be purely code-verified
    is_subjective_planning = any(phrase in task_title.lower() for phrase in [
        'choose the main user', 'talk to potential users', 'list the assumptions',
        'review existing alternatives', 'set one clear success measure',
        'share the first version', 'collect feedback', 'prioritize the next improvements',
    ])

    if is_subjective_planning:
        status = 'manual_review'
        status_label = 'Needs manual review'
        explanation = 'This task is a product research or discovery activity that does not map directly to code files. Review and assess manually.'
        confidence = 'medium'
    elif matched_mismatches:
        status = 'mismatch_detected'
        status_label = 'Blocked or mismatch detected'
        blocker = matched_mismatches[0]
        explanation = f'Implementation evidence found, but an integration issue was detected: {blocker.get("title")}.'
        for blocker in matched_mismatches[:2]:
            for ev in blocker.get('evidence', [])[:2]:
                deduped_evidence.append({
                    'file': ev.get('file') or blocker.get('file'),
                    'line': ev.get('line'),
                    'text': f'[Mismatch] {ev.get("text") or blocker.get("title")}',
                })
        confidence = 'high'
    elif deduped_evidence:
        # Check if full evidence or partial
        both_wants = wants_frontend and wants_backend
        both_found = has_frontend_evidence and has_backend_evidence
        one_missing = (wants_frontend and not has_frontend_evidence) or (wants_backend and not has_backend_evidence) or (wants_model and not has_model_evidence)

        if both_wants and not both_found:
            status = 'partially_implemented'
            status_label = 'Partially implemented'
            explanation = 'Partial implementation evidence detected (e.g. backend endpoint or frontend component exists, but full integration is incomplete).'
            confidence = 'high'
        elif len(deduped_evidence) >= 2:
            status = 'evidence_found'
            status_label = 'Evidence found'
            explanation = 'Relevant implementation evidence detected in codebase (matching routes, models, or components). Acceptance criteria have not been verified with runtime tests.'
            confidence = 'high'
        else:
            status = 'partially_implemented'
            status_label = 'Partially implemented'
            explanation = 'Limited implementation evidence found in repository files. Review the matched evidence to confirm implementation completeness.'
            confidence = 'medium'
    elif is_subjective_planning:
        status = 'manual_review'
        status_label = 'Needs manual review'
        explanation = 'This task is a product research or discovery activity that does not map directly to code files. Review and assess manually.'
        confidence = 'medium'
    else:
        status = 'not_assessed'
        status_label = 'Not assessed'
        explanation = 'No matching implementation evidence (routes, components, or models) detected in repository source files.'
        confidence = 'low'

    return {
        'taskId': task_id,
        'milestoneIndex': milestone_index,
        'taskIndex': task_index,
        'milestoneTitle': milestone.get('title', f'Milestone {milestone_index + 1}'),
        'taskTitle': task_title or f'Task {task_index + 1}',
        'status': status,
        'statusLabel': status_label,
        'explanation': explanation,
        'evidence': deduped_evidence[:6],
        'checks': checks,
        'commit_sha': commit_sha or '',
        'timestamp': timestamp,
        'confidence': confidence,
        'user_override': None,
    }


def compare_roadmap_with_repository(*, flight_plan, repository_info, analysis, commit_sha=None):
    """
    Compare an entire flight plan with repository analysis.
    Returns:
      {
        'summary': {...},
        'task_assessments': {...},
        'milestone_assessments': {...},
        'commit_sha': str,
        'branch': str,
        'timestamp': str,
      }
    """
    now_iso = datetime.now(timezone.utc).isoformat()
    sha = commit_sha or repository_info.get('last_synced_sha') or ''
    branch = repository_info.get('selected_branch') or ''

    milestones = flight_plan.get('milestones') or []
    task_assessments = {}
    milestone_assessments = {}

    status_counts = {
        'not_assessed': 0,
        'evidence_found': 0,
        'partially_implemented': 0,
        'mismatch_detected': 0,
        'verified': 0,
        'manual_review': 0,
    }

    total_tasks = 0

    for m_idx, milestone in enumerate(milestones):
        tasks = milestone.get('tasks') or []
        m_task_ids = []
        m_status_counts = {k: 0 for k in status_counts}

        for t_idx, raw_task in enumerate(tasks):
            total_tasks += 1
            task = {'title': raw_task} if isinstance(raw_task, str) else dict(raw_task)
            assessment = assess_task_against_evidence(
                task=task,
                milestone_index=m_idx,
                task_index=t_idx,
                milestone=milestone,
                analysis=analysis,
                repository_info=repository_info,
                commit_sha=sha,
                timestamp=now_iso,
            )
            task_id = assessment['taskId']
            m_task_ids.append(task_id)
            task_assessments[task_id] = assessment
            status_counts[assessment['status']] = status_counts.get(assessment['status'], 0) + 1
            m_status_counts[assessment['status']] = m_status_counts.get(assessment['status'], 0) + 1

        # Determine milestone build status
        if not tasks:
            m_status = 'not_assessed'
            m_label = 'Not assessed'
        elif m_status_counts['mismatch_detected'] > 0:
            m_status = 'mismatch_detected'
            m_label = 'Blocked or mismatch detected'
        elif m_status_counts['evidence_found'] == len(tasks):
            m_status = 'evidence_found'
            m_label = 'Evidence found'
        elif (m_status_counts['evidence_found'] + m_status_counts['partially_implemented']) > 0:
            m_status = 'partially_implemented'
            m_label = 'Partially implemented'
        elif m_status_counts['manual_review'] == len(tasks):
            m_status = 'manual_review'
            m_label = 'Needs manual review'
        else:
            m_status = 'not_assessed'
            m_label = 'Not assessed'

        milestone_assessments[str(m_idx)] = {
            'milestoneIndex': m_idx,
            'title': milestone.get('title', f'Milestone {m_idx + 1}'),
            'status': m_status,
            'statusLabel': m_label,
            'taskIds': m_task_ids,
            'counts': m_status_counts,
        }

    evidence_backed_count = status_counts['evidence_found'] + status_counts['partially_implemented']
    summary = {
        'total_tasks': total_tasks,
        'total_milestones': len(milestones),
        'evidence_found_count': status_counts['evidence_found'],
        'partially_implemented_count': status_counts['partially_implemented'],
        'mismatch_detected_count': status_counts['mismatch_detected'],
        'verified_count': status_counts['verified'],  # Unverified tasks are never reported as verified
        'manual_review_count': status_counts['manual_review'],
        'not_assessed_count': status_counts['not_assessed'],
        'evidence_percentage': round(evidence_backed_count / total_tasks * 100) if total_tasks else 0,
        'verified_percentage': round(status_counts['verified'] / total_tasks * 100) if total_tasks else 0,
        'commit_sha': sha,
        'branch': branch,
        'is_empty_repository': repository_info.get('is_empty', False),
    }

    return {
        'summary': summary,
        'task_assessments': task_assessments,
        'milestone_assessments': milestone_assessments,
        'commit_sha': sha,
        'branch': branch,
        'timestamp': now_iso,
    }
