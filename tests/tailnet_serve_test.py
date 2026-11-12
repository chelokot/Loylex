import http.client
import json
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1] / 'deploy/scripts'))
import loylex_tailnet_serve as tailnet
from loylex_approval_host import ApprovalError
from tailnet_fixtures import FAKE_TAILSCALE, publish_operation




class TailnetServeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.bin = root / 'bin'
        self.bin.mkdir()
        self.fake = self.bin / 'tailscale'
        self.fake.write_text(FAKE_TAILSCALE)
        self.fake.chmod(0o755)
        self.home = root / 'home'
        self.home.mkdir()
        self.probe = mock.Mock(return_value=None)
        for patcher in (
            mock.patch.object(tailnet, 'TAILSCALE', str(self.fake)),
            mock.patch.object(tailnet.Path, 'home', return_value=self.home),
            mock.patch.object(tailnet, 'tailnet_probe', self.probe),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def routes_on_fake(self):
        path = self.bin / 'state.json'
        return json.loads(path.read_text())['routes'] if path.exists() else {}

    def sites(self):
        return self.home / '.local/state/loylex-tailnet/sites'

    def site_names(self):
        return sorted(item.name for item in self.sites().iterdir()) if self.sites().exists() else []

    def test_publish_writes_the_site_and_adds_one_route(self):
        result = tailnet.tailnet_publish('op1', publish_operation(
            'anime-todo', {'index.html': b'<h1>one</h1>', 'assets/app.css': b'p{}'}))
        self.assertEqual(result, {
            'url': 'https://vps.crane-rigel.ts.net/anime-todo/',
            'files': 2,
            'bytes': len(b'<h1>one</h1>') + len(b'p{}'),
        })
        self.assertEqual(self.routes_on_fake(), {'/anime-todo': tailnet.tailnet_target('anime-todo')})
        self.assertEqual((self.sites() / 'anime-todo' / 'assets/app.css').read_bytes(), b'p{}')
        self.assertEqual(self.site_names(), ['anime-todo'])
        self.probe.assert_called_once()

    def test_republish_replaces_files_and_keeps_a_single_route(self):
        tailnet.tailnet_publish('op1', publish_operation('anime-todo', {'index.html': b'v1', 'old.css': b'x'}))
        tailnet.tailnet_publish('op2', publish_operation('anime-todo', {'index.html': b'v2'}))
        self.assertEqual(self.routes_on_fake(), {'/anime-todo': tailnet.tailnet_target('anime-todo')})
        self.assertEqual((self.sites() / 'anime-todo' / 'index.html').read_bytes(), b'v2')
        self.assertFalse((self.sites() / 'anime-todo' / 'old.css').exists())
        self.assertEqual(self.site_names(), ['anime-todo'])
        self.assertEqual(self.probe.call_count, 2)

    def test_foreign_route_is_never_replaced(self):
        (self.bin / 'state.json').write_text(json.dumps({'routes': {'/housik': 'http://127.0.0.1:9999'}}))
        with self.assertRaisesRegex(ApprovalError, 'another target'):
            tailnet.tailnet_publish('op1', publish_operation('housik', {'index.html': b'x'}))
        self.assertEqual(self.routes_on_fake(), {'/housik': 'http://127.0.0.1:9999'})
        self.assertFalse((self.sites() / 'housik').exists())
        with self.assertRaisesRegex(ApprovalError, 'another target'):
            tailnet.tailnet_remove('housik')
        self.assertEqual(self.routes_on_fake(), {'/housik': 'http://127.0.0.1:9999'})

    def test_failed_probe_rolls_back_the_new_route_and_files(self):
        self.probe.side_effect = ApprovalError('Tailnet probe did not serve the new site: HTTP/1.1 502 Bad Gateway')
        with self.assertRaisesRegex(ApprovalError, '502'):
            tailnet.tailnet_publish('op1', publish_operation('anime-todo', {'index.html': b'x'}))
        self.assertEqual(self.routes_on_fake(), {})
        self.assertEqual(self.site_names(), [])

    def test_failed_probe_restores_the_previous_version(self):
        tailnet.tailnet_publish('op1', publish_operation('anime-todo', {'index.html': b'good'}))
        self.probe.side_effect = ApprovalError('probe failed')
        with self.assertRaises(ApprovalError):
            tailnet.tailnet_publish('op2', publish_operation('anime-todo', {'index.html': b'bad'}))
        self.assertEqual((self.sites() / 'anime-todo' / 'index.html').read_bytes(), b'good')
        self.assertEqual(self.routes_on_fake(), {'/anime-todo': tailnet.tailnet_target('anime-todo')})
        self.assertEqual(self.site_names(), ['anime-todo'])

    def test_refused_serve_is_reported_and_leaves_nothing_behind(self):
        (self.bin / 'fail-add').write_text('1')
        with self.assertRaisesRegex(ApprovalError, 'Serve is not enabled'):
            tailnet.tailnet_publish('op1', publish_operation('anime-todo', {'index.html': b'x'}))
        self.assertEqual(self.site_names(), [])
        self.probe.assert_not_called()

    def test_remove_deletes_route_and_files_and_is_idempotent(self):
        tailnet.tailnet_publish('op1', publish_operation('anime-todo', {'index.html': b'x'}))
        self.assertEqual(tailnet.tailnet_remove('anime-todo'), {
            'name': 'anime-todo', 'routeRemoved': True, 'filesRemoved': True})
        self.assertEqual(self.routes_on_fake(), {})
        self.assertEqual(self.site_names(), [])
        self.assertEqual(tailnet.tailnet_remove('anime-todo'), {
            'name': 'anime-todo', 'routeRemoved': False, 'filesRemoved': False})

    def test_status_reports_routes_and_sites_without_mutating_them(self):
        tailnet.tailnet_publish('op1', publish_operation('anime-todo', {'index.html': b'x'}))
        status = tailnet.tailnet_status()
        self.assertEqual(status['dnsName'], 'vps.crane-rigel.ts.net')
        self.assertEqual(status['routes'], {'/anime-todo': tailnet.tailnet_target('anime-todo')})
        self.assertEqual(status['sites'], ['anime-todo'])
        self.assertEqual(self.routes_on_fake(), {'/anime-todo': tailnet.tailnet_target('anime-todo')})

    def test_loopback_serves_only_files_inside_site_directories(self):
        tailnet.tailnet_publish('op1', publish_operation('anime-todo', {'index.html': b'<h1>hi</h1>', 'sub/x.css': b'x{}'}))
        (self.sites() / 'secret.txt').write_bytes(b'top secret')
        server = ThreadingHTTPServer(('127.0.0.1', 0), tailnet.TailnetSiteHandler)
        server.sites_root = self.sites()
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        port = server.server_address[1]
        cases = {
            '/anime-todo/': (200, b'<h1>hi</h1>'),
            '/anime-todo/index.html': (200, b'<h1>hi</h1>'),
            '/anime-todo': (301, b''),
            '/anime-todo/sub/x.css': (200, b'x{}'),
            '/anime-todo/sub': (301, b''),
            '/anime-todo/sub/': (404, b''),
            '/anime-todo/missing.html': (404, b''),
            '/anime-todo/../secret.txt': (404, b''),
            '/anime-todo/%2e%2e/secret.txt': (404, b''),
            '/anime-todo/..%2fsecret.txt': (404, b''),
            '/secret.txt': (404, b''),
            '/.staging-op1/index.html': (404, b''),
        }
        for path, (status, body) in cases.items():
            with self.subTest(path=path):
                connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                connection.request('GET', path)
                response = connection.getresponse()
                data = response.read()
                connection.close()
                self.assertEqual(response.status, status)
                if status == 200:
                    self.assertEqual(data, body)
                if status == 301:
                    self.assertTrue(response.getheader('Location', '').startswith('/anime-todo'))


if __name__ == '__main__':
    unittest.main()
