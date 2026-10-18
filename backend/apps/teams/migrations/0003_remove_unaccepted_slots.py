from django.db import migrations


def remove_unaccepted_slots(apps, schema_editor):
    TeamMember = apps.get_model('teams', 'TeamMember')
    ProjectTask = apps.get_model('roadmaps', 'ProjectTask')
    legacy_ids = list(TeamMember.objects.filter(slot__gt=1).values_list('id', flat=True))
    if legacy_ids:
        ProjectTask.objects.filter(assigned_to_id__in=legacy_ids).update(assigned_to=None)
        TeamMember.objects.filter(id__in=legacy_ids).delete()
    TeamMember.objects.filter(slot=1).update(is_creator=True)


class Migration(migrations.Migration):
    dependencies = [
        ('roadmaps', '0003_projecttask_source_position'),
        ('teams', '0002_teammember_user_teaminvitation'),
    ]

    operations = [migrations.RunPython(remove_unaccepted_slots, migrations.RunPython.noop)]
