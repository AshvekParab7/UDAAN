from django.urls import path, include
from .idea_views import (
    IdeaAnalysisView,
    IdeaWorkflowStageView,
    ProjectDraftView,
    ProjectDraftCollectionView,
    ProjectLearningStateView,
    ProjectLearningTutorView,
    ProjectLearningRecommendationsView,
    ProjectRepositoryAnalysisView,
    ProjectRepositoryView,
    ProjectStageGenerationView,
    ProjectReplanView,
    RepositoryFindingExplanationView,
    RoadmapAssessmentView,
    RoadmapCompareRepositoryView,
    RoadmapTaskAssessmentCorrectionView,
    RoadmapTaskExplanationView,
    UserRepositoriesView,
)
from .views import health
from .team_workspace import (TeamWorkspaceView, TeamMemberView, TeamTaskView, RoadmapTaskSyncView,
    TeamInvitationCollectionView, TeamInvitationManageView, PublicTeamInvitationView,
    TeamAllocationProposalView, TeamAllocationApprovalView)
from .marketing_views import MarketingGenerateView, MarketingContentCollectionView, MarketingContentDetailView
from apps.users.views import GitHubLoginStartView, GitHubLoginCallbackView, AuthStatusView, DeveloperProfileView, LogoutView, CsrfTokenView

urlpatterns = [
    path('auth/csrf/', CsrfTokenView.as_view(), name='csrf-token'),
    path('auth/status/', AuthStatusView.as_view(), name='auth-status'),
    path('auth/github/start/', GitHubLoginStartView.as_view(), name='github-login-start'),
    path('auth/github/callback/', GitHubLoginCallbackView.as_view(), name='github-login-callback'),
    path('auth/logout/', LogoutView.as_view(), name='auth-logout'),
    path('profile/developer/', DeveloperProfileView.as_view(), name='developer-profile'),
    path('health/', health, name='health'),
    path('projects/', ProjectDraftCollectionView.as_view(), name='project-draft-list'),
    path('ideas/analyze/', IdeaAnalysisView.as_view(), name='idea-analysis'),
    path('ideas/workflow-stage/', IdeaWorkflowStageView.as_view(), name='idea-workflow-stage'),
    path('projects/drafts/<uuid:draft_id>/', ProjectDraftView.as_view(), name='project-draft'),
    path('projects/drafts/<uuid:draft_id>/learning/', ProjectLearningStateView.as_view(), name='project-learning-state'),
    path('projects/drafts/<uuid:draft_id>/learning/tutor/', ProjectLearningTutorView.as_view(), name='project-learning-tutor'),
    path('projects/drafts/<uuid:draft_id>/learning/recommendations/', ProjectLearningRecommendationsView.as_view(), name='project-learning-recommendations'),
    path('projects/drafts/<uuid:draft_id>/team-workspace/', TeamWorkspaceView.as_view(), name='team-workspace'),
    path('projects/drafts/<uuid:draft_id>/team-workspace/members/<int:member_id>/', TeamMemberView.as_view(), name='team-workspace-member'),
    path('projects/drafts/<uuid:draft_id>/team-workspace/tasks/<int:task_id>/', TeamTaskView.as_view(), name='team-workspace-task'),
    path('projects/drafts/<uuid:draft_id>/team-workspace/allocation-proposals/', TeamAllocationProposalView.as_view(), name='team-workspace-allocation-proposals'),
    path('projects/drafts/<uuid:draft_id>/team-workspace/allocation-proposals/<int:proposal_id>/approve/', TeamAllocationApprovalView.as_view(), name='team-workspace-allocation-approval'),
    path('projects/drafts/<uuid:draft_id>/team-workspace/sync-roadmap/', RoadmapTaskSyncView.as_view(), name='team-workspace-sync-roadmap'),
    path('projects/drafts/<uuid:draft_id>/team-workspace/invitations/', TeamInvitationCollectionView.as_view(), name='team-workspace-invitations'),
    path('projects/drafts/<uuid:draft_id>/team-workspace/invitations/<int:invitation_id>/', TeamInvitationManageView.as_view(), name='team-workspace-invitation'),
    path('team/invitations/<str:token>/', PublicTeamInvitationView.as_view(), name='public-team-invitation'),
    path('projects/drafts/<uuid:draft_id>/replan/', ProjectReplanView.as_view(), name='project-replan'),
    path('projects/drafts/<uuid:draft_id>/repository/', ProjectRepositoryView.as_view(), name='project-repository'),
    path('projects/drafts/<uuid:draft_id>/repository/analysis/', ProjectRepositoryAnalysisView.as_view(), name='project-repository-analysis'),
    path('projects/drafts/<uuid:draft_id>/compare-repository/', RoadmapCompareRepositoryView.as_view(), name='roadmap-compare-repository'),
    path('projects/drafts/<uuid:draft_id>/roadmap-assessment/', RoadmapAssessmentView.as_view(), name='roadmap-assessment'),
    path('projects/drafts/<uuid:draft_id>/roadmap-assessment/tasks/<str:task_id>/', RoadmapTaskAssessmentCorrectionView.as_view(), name='roadmap-task-assessment-correction'),
    path('projects/drafts/<uuid:draft_id>/stages/<str:stage>/generation/', ProjectStageGenerationView.as_view(), name='project-stage-generation'),
    path('projects/repositories/', UserRepositoriesView.as_view(), name='user-repositories'),
    path('repository/explain-finding/', RepositoryFindingExplanationView.as_view(), name='repository-finding-explanation'),
    path('repository/explain-task-assessment/', RoadmapTaskExplanationView.as_view(), name='repository-explain-task-assessment'),
    path('marketing/generate/', MarketingGenerateView.as_view(), name='marketing-generate'),
    path('marketing/content/', MarketingContentCollectionView.as_view(), name='marketing-content-list-create'),
    path('marketing/content/<int:item_id>/', MarketingContentDetailView.as_view(), name='marketing-content-detail'),
]

from apps.health.urls import urlpatterns as health_urlpatterns
urlpatterns += health_urlpatterns

from apps.testpilot.urls import urlpatterns as testpilot_urlpatterns
urlpatterns += testpilot_urlpatterns
