from django.contrib import admin
from django.utils.html import format_html

from posthog.admin.admins.team_admin import TeamAdmin
from posthog.models import Team


class TeamInline(admin.TabularInline):
    extra = 0
    model = Team

    fields = (
        "id",
        "displayed_name",
        "api_token",
        "app_urls",
        "created_at",
        "updated_at",
        "anonymize_ips",
        "completed_snippet_onboarding",
        "ingested_event",
        "session_recording_opt_in",
        "autocapture_opt_out",
        "signup_token",
        "is_demo",
        "test_account_filters",
        "path_cleaning_filters",
        "timezone",
        "data_attributes",
        "correlation_config",
        "modifiers",
        "plugins_opt_in",
        "opt_out_capture",
    )
    readonly_fields = [*TeamAdmin.readonly_fields, "displayed_name"]

    def displayed_name(self, team: Team):
        return format_html(
            '<a href="/admin/posthog/team/{}/change/">{}.&nbsp;{}</a>',
            team.pk,
            team.pk,
            team.name,
        )
