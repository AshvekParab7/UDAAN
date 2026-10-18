import threading

from django.core.management.base import BaseCommand, CommandError

from apps.core.stage_generation import run_worker


class Command(BaseCommand):
    help = 'Process queued UDAAN stage generations using the configured AI provider.'

    def add_arguments(self, parser):
        parser.add_argument('--poll-interval', type=float, default=2.0, help='Seconds to wait when the queue is empty.')
        parser.add_argument('--once', action='store_true', help='Process available jobs and exit.')

    def handle(self, *args, **options):
        if options['poll_interval'] <= 0:
            raise CommandError('--poll-interval must be greater than zero.')
        stop_event = threading.Event()
        try:
            run_worker(poll_interval=options['poll_interval'], once=options['once'], stop_event=stop_event)
        except KeyboardInterrupt:
            stop_event.set()
            self.stdout.write(self.style.WARNING('Generation worker stopped.'))
