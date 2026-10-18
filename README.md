# UDAAN

UDAAN (Give Every Idea Wings) is an AI-assisted project development and team execution platform. This repository contains its initial frontend and backend foundation; product screens and business features will be built incrementally from the provided design references.

## Requirements

- Node.js 20.19+ or 22.12+
- Python 3.10+

## Frontend

```powershell
cd frontend
Copy-Item .env.example .env
npm install
npm run dev
```

The Vite development server runs at http://127.0.0.1:5173. `VITE_API_BASE_URL` defaults in code to `http://127.0.0.1:8000`.

Build for production with `npm run build` from `frontend/`.

## Backend

```powershell
cd backend
py -m venv .venv
.venv\Scripts\Activate.ps1
Copy-Item .env.example .env
py -m pip install -r requirements.txt
py manage.py migrate
py manage.py runserver 127.0.0.1:8000
```

The API runs at http://127.0.0.1:8000. Check `http://127.0.0.1:8000/api/health/` for its health response. To enable idea analysis, add `GEMINI_API_KEY=your-key` to `backend/.env` (optionally set `GEMINI_MODEL=gemini-3.8-flash` and `GEMINI_FALLBACK_MODELS=gemini-3.6-flash,gemini-3.5-flash-lite`) and restart Django. Keep the key in the backend environment; do not add it to `frontend/.env`. The `/api/ideas/analyze/` endpoint returns a draft based on the idea and any attached text. SQLite is used by default. To use PostgreSQL, set `DB_ENGINE=postgresql` and configure the `DB_*` values in `backend/.env`.

## Foundation

- React, Vite, React Router, Tailwind CSS, Framer Motion, and Lucide icons
- Central API client, project storage, and idea workflow services
- Django REST Framework with CORS configured for local Vite origins
- Four stage idea planning wizard and Flight Plan pages

## Idea planning workflow

The four planning stages call the Django `/api/ideas/analyze/` and `/api/ideas/workflow-stage/` endpoints. Gemini credentials stay in `backend/.env` as `GEMINI_API_KEY`; `GEMINI_MODEL` may select the model. Generated Research is a preliminary, unverified landscape report. This app has no live web search integration, so AI generated source URLs are rejected and the source list starts empty. Verify claims and add real sources yourself. Feasibility is a buildability estimate, not proof of demand. Flight Plan assigns role suggestions only, never named people.

Drafts are saved in browser storage and to the Django `ProjectDraft` table. The current frontend has no sign-in flow and sends draft requests anonymously, so the draft UUID acts as a bearer identifier for read/write access; anyone who obtains that identifier may access an unowned draft. The API associates a draft with a user when a request is authenticated, then restricts access to that user, but the React app does not currently provide or send user credentials. Do not store sensitive personal or confidential information in these drafts.

Run backend checks from `backend/` with `python manage.py check`, `python manage.py makemigrations --check --dry-run`, and `python manage.py test apps.core.tests`. Run the production frontend build from `frontend/` with `npm run build`.
