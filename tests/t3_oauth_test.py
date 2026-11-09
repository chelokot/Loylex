import base64
import hashlib
import json
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlencode, urlsplit

sys.path.insert(0, str(Path(__file__).parents[1] / 'deploy/scripts'))
import loylex_approval_host as host
import loylex_approval_validation as policy
import loylex_supervisor_http as http
from approval_fixtures import ApprovalTestCase

ORIGIN = 'https://home.example'
CALLBACK = 'https://loylex.example/t3/callback'
METADATA = {'issuer': ORIGIN, 'authorization_endpoint': ORIGIN + '/oauth/mcp/authorize',
            'token_endpoint': ORIGIN + '/oauth/mcp/token', 'registration_endpoint': ORIGIN + '/oauth/mcp/register',
            'code_challenge_methods_supported': ['S256']}
TOKEN = {'access_token': 'private-access-token', 'token_type': 'Bearer', 'expires_in': 2592000,
         'scope': 'orchestration:read orchestration:operate settings:write source-control:write'}


class OAuthTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = mock.patch.object(Path, 'home', return_value=Path(self.temporary.name))
        self.home.start()
        self.oauth = http.T3OAuth()
        self.oauth.ready = True
        host.t3_write('t3-oauth.json', {'callbackUrl': CALLBACK})
        self.network = mock.patch.object(host, 't3_json', side_effect=[METADATA, {'client_id': 'client'}, TOKEN])
        self.request = self.network.start()
        self.addCleanup(self.temporary.cleanup)
        self.addCleanup(self.home.stop)
        self.addCleanup(self.network.stop)

    def begin(self):
        value = self.oauth.begin('home', ORIGIN + '/mcp')
        self.params = parse_qs(urlsplit(value['authorizationUrl']).query)
        return value

    def query(self, **changes):
        params = {'state': self.params['state'][0], 'iss': ORIGIN, 'code': 'private-code'}
        params.update(changes)
        return urlencode(params)

    def test_pkce_issuer_single_use_and_private_storage(self):
        value = self.begin()
        pending = host.t3_read('t3-pending.json')['home']
        challenge = base64.urlsafe_b64encode(hashlib.sha256(pending['verifier'].encode()).digest()).decode().rstrip('=')
        self.assertEqual(self.params['code_challenge'], [challenge])
        self.assertNotIn(pending['verifier'], json.dumps(value))
        self.assertEqual(self.params['redirect_uri'], [CALLBACK])
        self.oauth.finish(self.query())
        self.assertEqual(host.t3_read('t3-pending.json'), {})
        credential = host.t3_read('t3-credentials.json')['home']
        self.assertEqual(credential['accessToken'], TOKEN['access_token'])
        self.assertNotIn(TOKEN['access_token'], json.dumps(host.t3_read('t3-machines.json')))
        self.assertEqual(self.request.call_args.args[:2], (ORIGIN, '/oauth/mcp/token'))
        self.assertEqual(self.request.call_args.args[2]['code_verifier'], pending['verifier'])
        self.assertTrue(self.request.call_args.kwargs['form'])
        with self.assertRaises(host.ApprovalError):
            self.oauth.finish(self.query())
        self.assertEqual(self.request.call_count, 3)
        for path in (Path.home() / '.config/loylex').iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_wrong_state_issuer_duplicate_fields_and_expiry_never_exchange(self):
        self.begin()
        for query in [self.query(state='wrong'), self.query(iss='https://other.example'), self.query() + '&state=duplicate']:
            with self.assertRaises(host.ApprovalError):
                self.oauth.finish(query)
        pending = host.t3_read('t3-pending.json')
        pending['home']['expiresAt'] = 0
        host.t3_write('t3-pending.json', pending)
        with self.assertRaises(host.ApprovalError):
            self.oauth.finish(self.query())
        self.assertEqual(self.request.call_count, 2)

    def test_concurrent_callbacks_exchange_exactly_once(self):
        self.begin()
        def finish(_):
            try:
                self.oauth.finish(self.query())
                return True
            except host.ApprovalError:
                return False
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(finish, range(2))), [False, True])
        self.assertEqual(self.request.call_count, 3)

    def test_denial_or_unknown_exchange_outcome_is_not_retried(self):
        self.begin()
        self.request.side_effect = host.ApprovalError('connection lost')
        with self.assertRaises(host.ApprovalError):
            self.oauth.finish(self.query())
        self.assertEqual(host.t3_read('t3-pending.json'), {})
        with self.assertRaises(host.ApprovalError):
            self.oauth.finish(self.query())
        self.assertEqual(self.request.call_count, 3)

    def test_read_only_or_auto_grant_never_becomes_full_access(self):
        self.begin()
        self.request.side_effect = None
        self.request.return_value = {**TOKEN, 'scope': 'orchestration:read orchestration:operate'}
        with self.assertRaises(host.ApprovalError):
            self.oauth.finish(self.query())
        self.assertIsNone(host.t3_read('t3-credentials.json'))

    def test_discovery_cannot_redirect_registration_or_tokens(self):
        self.request.side_effect = [{**METADATA, 'token_endpoint': 'https://other.example/steal'}]
        with self.assertRaises(host.ApprovalError):
            self.oauth.begin('home', ORIGIN + '/mcp')
        self.assertEqual(self.request.call_count, 1)
        self.assertIsNone(host.t3_read('t3-pending.json'))

    def test_configuration_change_invalidates_pending_login(self):
        self.begin()
        host.t3_write('t3-machines.json', {'home': {'endpoint': 'https://other.example/mcp'}})
        with self.assertRaises(host.ApprovalError):
            self.oauth.finish(self.query())
        self.assertEqual(self.request.call_count, 2)

    def test_connection_state_returns_no_secret_or_project_content(self):
        self.begin()
        with mock.patch.object(http, 'T3_OAUTH', self.oauth):
            self.assertEqual(policy.t3_connection_status({'machine': 'home'})['state'], 'awaiting_login')
            self.oauth.finish(self.query())
            status = policy.t3_connection_status({'machine': 'home'})
            self.assertEqual(set(status), {'machine', 'state', 'expiresAt'})
            self.assertEqual(status['state'], 'connected')
            self.assertNotIn('private', json.dumps(status))
            with mock.patch.object(policy.T3Transport, 'call', return_value={}) as call:
                policy.call_t3(policy.connection('home'), 't3_project_list', {})
                call.assert_called_once()
            credentials = host.t3_read('t3-credentials.json')
            credentials['home']['expiresAt'] = 0
            host.t3_write('t3-credentials.json', credentials)
            self.assertEqual(policy.t3_connection_status({'machine': 'home'})['state'], 'reconnect_required')
            with mock.patch.object(policy.T3Transport, 'call') as call:
                with self.assertRaises(host.ApprovalError):
                    policy.call_t3(policy.connection('home'), 't3_project_list', {})
                call.assert_not_called()


class ConnectBrokerTests(ApprovalTestCase):
    def test_only_a_live_approved_button_starts_oauth_and_sends_link(self):
        oauth = mock.Mock(ready=True)
        oauth.configuration.return_value = CALLBACK
        oauth.lock = __import__('threading').RLock()
        oauth.begin.return_value = {'authorizationUrl': ORIGIN + '/authorize?state=opaque', 'state': 'awaiting_login'}
        operation = {'kind': 't3', 'machine': 'home', 'action': 'connect', 'arguments': {'endpoint': ORIGIN + '/mcp'}}
        with mock.patch.object(http, 'T3_OAUTH', oauth), mock.patch.object(policy, 't3_read', return_value={}):
            identifier = self.submit(operation)
            oauth.begin.assert_not_called()
            self.assertFalse(self.callback(identifier, user=1)['accepted'])
            self.assertTrue(self.callback(identifier)['accepted'])
            self.assertEqual(self.wait_execution(identifier)['state'], 'succeeded')
            oauth.begin.assert_called_once_with('home', ORIGIN + '/mcp')
            deadline = time.monotonic() + 1
            while len(self.approvals.messages) < 4 and time.monotonic() < deadline:
                time.sleep(0.01)
            links = [p for method, p, _ in self.approvals.messages if method == 'sendMessage' and 'reply_markup' in p and 'url' in str(p)]
            self.assertEqual(len(links), 1)
            self.assertEqual(links[0]['reply_markup']['inline_keyboard'][0][0]['url'], oauth.begin.return_value['authorizationUrl'])


class CallbackHTTPTests(unittest.TestCase):
    def test_browser_response_has_no_code_or_token_and_never_logs_url(self):
        from http.client import HTTPConnection
        import threading
        from http.server import HTTPServer
        with mock.patch.object(http.T3_OAUTH, 'finish', side_effect=host.ApprovalError('private-code private-token')):
            with HTTPServer(('127.0.0.1', 0), http.T3CallbackHandler) as server:
                thread = threading.Thread(target=server.handle_request)
                thread.start()
                connection = HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                connection.request('GET', '/t3/callback?state=x&code=private-code&iss=https%3A%2F%2Fhome.example')
                response = connection.getresponse()
                body = response.read().decode()
                self.assertEqual(response.status, 400)
                self.assertEqual(response.getheader('Cache-Control'), 'no-store')
                self.assertEqual(response.getheader('Referrer-Policy'), 'no-referrer')
                self.assertNotIn('private', body)
                connection.close()
                thread.join(timeout=3)
