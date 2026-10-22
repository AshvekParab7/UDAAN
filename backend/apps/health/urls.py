from django.urls import path

from .views import (
    HealthScoreView,
    HealthActionsView,
    HealthHistoryView,
    PassportView,
    PublicPassportView,
)

urlpatterns = [
    path('projects/drafts/<uuid:draft_id>/health/', HealthScoreView.as_view(), name='health-score'),
    path('projects/drafts/<uuid:draft_id>/health/actions/', HealthActionsView.as_view(), name='health-actions'),
    path('projects/drafts/<uuid:draft_id>/health/history/', HealthHistoryView.as_view(), name='health-history'),
    path('projects/drafts/<uuid:draft_id>/health/passport/', PassportView.as_view(), name='health-passport'),
    path('passport/<uuid:public_id>/', PublicPassportView.as_view(), name='public-passport'),
]
