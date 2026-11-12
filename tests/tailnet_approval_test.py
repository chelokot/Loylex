import json
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1] / 'deploy/scripts'))
import loylex_tailnet_serve as tailnet
from approval_fixtures import ApprovalTestCase
from loylex_approval_host import ApprovalError
from tailnet_fixtures import FAKE_TAILSCALE, publish_operation


# The broker path end to end: submit, operator button, execute. Telegram and review are stubbed by
# ApprovalTestCase; the tailscale binary and the probe are replaced here.
class TailnetApprovalTests(ApprovalTestCase):
    def setUp(self):
        super().setUp()
        self.bin = Path(self.temporary.name) / 'bin'
        self.bin.mkdir()
        self.fake = self.bin / 'tailscale'
        self.fake.write_text(FAKE_TAILSCALE)
        self.fake.chmod(0o755)
        self.home = Path(self.temporary.name) / 'home'
        self.home.mkdir()
        self.probe = mock.Mock(return_value=None)
        for patcher in (
            mock.patch.object(tailnet, 'TAILSCALE', str(self.fake)),
            mock.patch.object(tailnet.Path, 'home', return_value=self.home),
            mock.patch.object(tailnet, 'tailnet_probe', self.probe),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def routes(self):
        path = self.bin / 'state.json'
        return json.loads(path.read_text())['routes'] if path.exists() else {}

    def test_publish_waits_for_the_operator_button_and_executes_once(self):
        identifier = self.submit(publish_operation('anime-todo', {'index.html': b'<h1>x</h1>'}))
        self.assertFalse((self.bin / 'state.json').exists())  # Nothing reaches tailscale before the button.
        self.assertFalse(self.callback(identifier, user=849670500)['accepted'])
        self.assertTrue(self.callback(identifier)['accepted'])
        status = self.wait_execution(identifier)
        self.assertEqual(status['state'], 'succeeded', status)
        self.assertEqual(json.loads(status['result'])['url'], 'https://vps.crane-rigel.ts.net/anime-todo/')
        self.assertEqual(self.routes(), {'/anime-todo': tailnet.tailnet_target('anime-todo')})
        self.assertFalse(self.callback(identifier)['accepted'])

    def test_remove_through_approval_deletes_the_route_and_files(self):
        published = self.submit(publish_operation('anime-todo', {'index.html': b'x'}))
        self.callback(published)
        self.wait_execution(published)
        removal = self.submit({'kind': 'tailnet', 'action': 'remove', 'name': 'anime-todo'})
        message = self.approvals.status(removal)['message_id']
        self.assertTrue(self.callback(removal, message=message)['accepted'])
        status = self.wait_execution(removal)
        self.assertEqual(status['state'], 'succeeded', status)
        self.assertEqual(json.loads(status['result']), {
            'name': 'anime-todo', 'routeRemoved': True, 'filesRemoved': True})
        self.assertEqual(self.routes(), {})

    def test_failed_probe_fails_the_approval_and_leaves_no_route(self):
        self.probe.side_effect = ApprovalError('Tailnet probe did not serve the new site: HTTP/1.1 404 Not Found')
        identifier = self.submit(publish_operation('anime-todo', {'index.html': b'x'}))
        self.callback(identifier)
        status = self.wait_execution(identifier)
        self.assertEqual(status['state'], 'failed')
        self.assertIn('404', status['result'])
        self.assertEqual(self.routes(), {})

    def test_status_is_read_only_and_creates_no_approval(self):
        result = self.approvals.submit({
            'chatId': -100,
            'replyId': 10,
            'threadId': None,
            'operation': {'kind': 'tailnet-status'},
        })
        self.assertEqual(result['dnsName'], 'vps.crane-rigel.ts.net')
        self.assertEqual(result['routes'], {})
        self.assertEqual(self.approvals.database.execute('SELECT COUNT(*) FROM approvals').fetchone()[0], 0)


if __name__ == '__main__':
    import unittest

    unittest.main()
