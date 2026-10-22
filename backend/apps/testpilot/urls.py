from django.urls import path
from .views import (
    TestRunCollectionView,
    TestRunDetailView,
    TestRunControlView,
    TestRunEventsView,
    TestRunEventsPollingView,
    TestPlanPreviewView,
)

urlpatterns = [
    path('testpilot/runs/', TestRunCollectionView.as_view(), name='testpilot-runs'),
    path('testpilot/runs/<uuid:run_id>/', TestRunDetailView.as_view(), name='testpilot-run-detail'),
    path('testpilot/runs/<uuid:run_id>/control/', TestRunControlView.as_view(), name='testpilot-run-control'),
    path('testpilot/runs/<uuid:run_id>/events/', TestRunEventsView.as_view(), name='testpilot-run-events'),
    path('testpilot/runs/<uuid:run_id>/events/poll/', TestRunEventsPollingView.as_view(), name='testpilot-run-events-poll'),
    path('testpilot/plan-preview/', TestPlanPreviewView.as_view(), name='testpilot-plan-preview'),
]
