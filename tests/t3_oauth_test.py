import base64
import hashlib
import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).parents[1] / 'deploy/scripts'))
import loylex_approval_host as host
import loylex_approval_validation as policy
import loylex_approval_execution as execution
import loylex_supervisor_http as http
from approval_fixtures import ApprovalTestCase

ORIGIN = 'https://home.example'
ENV = {'environmentId': 'env-1', 'label': 'laptop-fedora', 'endpoint': {'httpBaseUrl': ORIGIN}}
DEVICE = {'device_code': 'private-device-code', 'user_code': 'ABCD-EFGH', 'verification_uri_complete': 'https://clerk.t3.codes/oauth/device?user_code=ABCD-EFGH', 'expires_in': 600, 'interval': 5}


class NativeFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = mock.patch.object(Path, 'home', return_value=Path(self.temporary.name))
        self.home.start()
        self.oauth = http.T3OAuth()
        self.network = mock.patch.object(host, 't3_native_request', return_value=(200, DEVICE))
        self.request = self.network.start()
        self.addCleanup(self.temporary.cleanup)
        self.addCleanup(self.home.stop)
        self.addCleanup(self.network.stop)

    def begin(self):
        with mock.patch.object(http.threading, 'Thread'):
            result = self.oauth.begin('home', environmentName='laptop-fedora')
        self.record = host.t3_read('t3-pending.json')['home']
        return result

    def stage(self):
        self.begin()
        self.oauth.request = mock.Mock(side_effect=[{'sub': 'verified-owner', 'email': 'owner@example.com'}, {'environments': [ENV]}])
        with mock.patch.object(threading, 'Timer'):
            self.oauth.stage('home', self.record, 'private-account-token')
        pending = host.t3_read('t3-pending.json')
        pending['home']['state'] = 'confirmation_required'
        host.t3_write('t3-pending.json', pending)
        return self.oauth.confirmation('home', self.record['attemptId'])



class NativeLoginTests(NativeFixture):
    def test_device_link_contains_no_credentials_and_needs_no_host_setup(self):
        result = self.begin()
        self.assertEqual(result['authorizationUrl'], DEVICE['verification_uri_complete'])
        self.assertEqual(result['userCode'], DEVICE['user_code'])
        self.assertNotIn('private-device-code', json.dumps(result))
        self.assertNotIn('private-device-code', json.dumps(host.t3_read('t3-pending.json')))
        self.assertEqual(self.request.call_args.args[:2], (self.oauth.CLERK, '/oauth/device_authorization'))
        self.assertFalse((Path.home() / '.config/loylex/t3-oauth.json').exists())

    def test_untrusted_verification_host_is_rejected(self):
        self.request.return_value = (200, {**DEVICE, 'verification_uri_complete': 'https://attacker.example/steal'})
        with self.assertRaises(host.ApprovalError):
            self.begin()
        self.assertEqual(self.oauth.slots._value, 2)

    def test_account_login_only_stages_exact_target_and_requires_second_confirmation(self):
        record = self.stage()
        self.assertEqual(record['environmentId'], 'env-1')
        self.assertEqual(record['accountEmail'], 'owner@example.com')
        self.assertEqual(record['endpoint'], ORIGIN + '/mcp')
        self.assertIsNone(host.t3_read('t3-credentials.json'))
        self.assertNotIn('private-account-token', json.dumps(host.t3_read('t3-pending.json')))
        self.oauth.expire(record['attemptId'])
        with self.assertRaises(host.ApprovalError):
            self.oauth.confirmation('home', record['attemptId'])

    def test_duplicate_labels_refuse_without_creating_mcp_grant(self):
        self.begin()
        self.oauth.request = mock.Mock(side_effect=[{'sub': 'owner', 'email': 'owner@example.com'}, {'environments': [ENV, ENV]}])
        with self.assertRaises(host.ApprovalError):
            self.oauth.stage('home', self.record, 'private-account-token')
        self.assertEqual(self.oauth.accounts, {})

    def test_configuration_lease_refuses_changed_target(self):
        record = self.stage()
        host.t3_write('t3-machines.json', {'home': {'endpoint': 'https://other.example/mcp'}})
        with self.assertRaises(host.ApprovalError):
            self.oauth.confirmation('home', record['attemptId'])

    def test_concurrent_confirmations_and_unknown_outcomes_execute_once(self):
        record = self.stage()
        def complete(_):
            try:
                self.oauth.complete('home', record)
                return True
            except host.ApprovalError:
                return False
        with mock.patch.object(execution, 'complete_t3_enrollment', side_effect=host.ApprovalError('unknown outcome')) as enroll:
            with ThreadPoolExecutor(max_workers=2) as pool:
                self.assertEqual(list(pool.map(complete, range(2))), [False, False])
            self.assertEqual(enroll.call_count, 1)
        self.assertEqual(self.oauth.accounts, {})
        self.assertEqual(self.oauth.status({'machine': 'home'})['state'], 'failed')

    def test_polling_pending_and_slowdown_are_bounded_and_never_expose_codes(self):
        self.begin()
        self.request.side_effect = [(400, {'error': 'authorization_pending'}), (400, {'error': 'slow_down'}), (200, {'access_token': 'private-account-token'})]
        with mock.patch('time.sleep') as sleep, mock.patch.object(self.oauth, 'stage', side_effect=lambda machine, record, token: self.oauth.accounts.__setitem__(record['attemptId'], token)) as stage:
            self.oauth.worker('home', self.record, DEVICE['device_code'], 5)
            self.assertEqual([x.args[0] for x in sleep.call_args_list], [5, 5, 10])
            stage.assert_called_once_with('home', self.record, 'private-account-token')
        self.assertEqual(self.oauth.status({'machine': 'home'})['state'], 'confirmation_required')

    def test_transport_errors_do_not_retry_poll_or_enroll(self):
        self.begin()
        self.request.side_effect = host.ApprovalError('connection lost')
        with mock.patch('time.sleep'), mock.patch.object(self.oauth, 'stage') as stage:
            self.oauth.worker('home', self.record, DEVICE['device_code'], 5)
            self.assertEqual(self.request.call_count, 2)  # begin plus one poll
            stage.assert_not_called()
        self.assertEqual(self.oauth.status({'machine': 'home'})['state'], 'failed')

    def test_restart_loses_temporary_account_and_requires_new_login(self):
        self.stage()
        self.assertEqual(http.T3OAuth().status({'machine': 'home'}), {'machine': 'home', 'state': 'reconnect_required'})

    def test_status_never_returns_email_endpoint_tokens_or_project_content(self):
        self.stage()
        status = self.oauth.status({'machine': 'home'})
        self.assertEqual(set(status), {'machine', 'state', 'expiresAt'})
        self.assertNotIn('private', json.dumps(status))
        self.assertNotIn('owner', json.dumps(status))


class EnrollmentTests(NativeFixture):
    def test_full_grant_uses_dpop_and_pkce_without_callback_or_proof_downgrade(self):
        record = self.stage()
        key = mock.Mock(thumbprint='proof-thumbprint')
        calls = []
        def request(origin, path, payload=None, **kwargs):
            calls.append((origin, path, payload, kwargs))
            if path == '/v1/environments': return {'environments': [ENV]}
            if path == '/v1/client/dpop-token': return {'token_type': 'DPoP', 'access_token': 'private-relay-token'}
            if path.endswith('/connect'): return {**ENV, 'credential': 'private-bootstrap'}
            if path == '/oauth/token': return {'token_type': 'DPoP', 'access_token': 'private-environment-token'}
            if path == '/api/auth/pairing-token': return {'credential': 'private-pairing-code'}
            if path == '/oauth/mcp/register': return {'client_id': 'public-client'}
            if path == '/oauth/mcp/decision':
                auth = payload['authorization']
                self.assertEqual(payload['decision'], {'_tag': 'pairing-code', 'access': 'full-access', 'code': 'private-pairing-code'})
                self.assertEqual(auth['code_challenge_method'], 'S256')
                return {'redirectTo': self.oauth.CALLBACK + '?' + urlencode({'iss': ORIGIN, 'state': auth['state'], 'code': 'private-oauth-code'})}
            if path == '/oauth/mcp/token':
                auth = next(c[2]['authorization'] for c in calls if c[1] == '/oauth/mcp/decision')
                expected = base64.urlsafe_b64encode(hashlib.sha256(payload['code_verifier'].encode()).digest()).decode().rstrip('=')
                self.assertEqual(auth['code_challenge'], expected)
                return {'token_type': 'Bearer', 'access_token': 'private-mcp-token', 'expires_in': 2592000, 'scope': ' '.join(self.oauth.SCOPES)}
            raise AssertionError(path)
        self.oauth.request = request
        with mock.patch.object(host, 'T3ProofKey', return_value=key):
            self.assertEqual(self.oauth.complete('home', record), {'machine': 'home', 'state': 'connected'})
        self.assertEqual(host.t3_read('t3-credentials.json')['home']['accessToken'], 'private-mcp-token')
        self.assertNotIn('private', json.dumps(host.t3_read('t3-machines.json')))
        self.assertEqual(self.oauth.accounts, {})
        self.assertTrue(all(c[3].get('key') is key for c in calls if c[1] in ['/v1/client/dpop-token', '/oauth/token', '/api/auth/pairing-token']))
        self.assertFalse(any(c[0].startswith('http:') for c in calls))


class ConnectBrokerTests(ApprovalTestCase):
    def test_live_button_starts_login_but_never_automatically_confirms_target(self):
        oauth = mock.Mock(ready=True)
        oauth.configuration.return_value = 't3-connect-device-v1'
        oauth.lock = threading.RLock()
        oauth.begin.return_value = {'authorizationUrl': 'https://clerk.t3.codes/oauth/device', 'state': 'awaiting_login', 'userCode': 'ABCD-EFGH'}
        operation = {'kind': 't3', 'machine': 'home', 'action': 'connect', 'arguments': {'environmentName': 'laptop-fedora'}}
        with mock.patch.object(http, 'T3_OAUTH', oauth), mock.patch.object(policy, 't3_read', return_value={}):
            identifier = self.submit(operation)
            oauth.begin.assert_not_called()
            self.assertFalse(self.callback(identifier, user=1)['accepted'])
            self.assertTrue(self.callback(identifier)['accepted'])
            self.assertEqual(self.wait_execution(identifier)['state'], 'succeeded')
            self.assertEqual(oauth.begin.call_args.args, ('home',))
            self.assertEqual(oauth.begin.call_args.kwargs['environmentName'], 'laptop-fedora')
            oauth.complete.assert_not_called()

    def test_confirmation_snapshot_is_private_metadata_only_and_second_button_is_required(self):
        oauth = mock.Mock()
        oauth.confirmation.return_value = {'attemptId': 'attempt', 'accountEmail': 'owner@example.com', 'environmentId': 'e', 'endpoint': ORIGIN + '/mcp'}
        oauth.complete.return_value = {'machine': 'home', 'state': 'connected'}
        with mock.patch.object(http, 'T3_OAUTH', oauth):
            identifier = self.submit({'kind': 't3', 'machine': 'home', 'action': 'confirm-connect', 'arguments': {'attemptId': 'attempt'}})
            oauth.complete.assert_not_called()
            self.assertTrue(self.callback(identifier)['accepted'])
            self.assertEqual(self.wait_execution(identifier)['state'], 'succeeded')
            oauth.complete.assert_called_once_with('home', oauth.confirmation.return_value)


class ProofKeyTests(unittest.TestCase):
    def test_bun_webcrypto_signature_verifies_and_has_no_private_jwk_header(self):
        def crypto(payload):
            result = subprocess.run(['bun', '-e', host.T3_CRYPTO_SCRIPT], input=json.dumps(payload).encode(), capture_output=True, timeout=10, check=True)
            return json.loads(result.stdout)
        with mock.patch.object(host, 't3_crypto', side_effect=crypto):
            key = host.T3ProofKey()
            proof = key.proof(ORIGIN + '/oauth/token', 'POST', 'private-token', 'nonce')
        header, claims, signature = proof.split('.')
        decoded = lambda s: json.loads(base64.urlsafe_b64decode(s + '=' * (-len(s) % 4)))
        self.assertNotIn('d', decoded(header)['jwk'])
        self.assertEqual(decoded(claims)['htu'], ORIGIN + '/oauth/token')
        self.assertEqual(decoded(claims)['nonce'], 'nonce')
        self.assertNotIn('private-token', proof)
        self.assertEqual(len(base64.urlsafe_b64decode(signature + '==')), 64)
        verify = "const x=JSON.parse(await Bun.stdin.text());const k=await crypto.subtle.importKey('jwk',x.key,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);console.log(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},k,Buffer.from(x.signature,'base64url'),new TextEncoder().encode(x.message)));"
        result = subprocess.run(['bun', '-e', verify], input=json.dumps({'key': key.jwk, 'signature': signature, 'message': header + '.' + claims}).encode(), capture_output=True, check=True, timeout=10)
        self.assertEqual(result.stdout.strip(), b'true')

    def test_helper_has_no_network_mounts_logs_or_mutable_image_reference(self):
        with mock.patch.object(host, 'command', side_effect=[b'a' * 64, b'{}']) as command:
            host.t3_crypto({'operation': 'key'})
        args = command.call_args.args[0]
        for limit in ['--network=none', '--read-only', '--log-driver=none', '--cap-drop=ALL', '--pids-limit=32', '--memory=128m']:
            self.assertIn(limit, args)
        self.assertFalse(any('volume' in x or 'secret' in x or ':main' in x for x in args))
