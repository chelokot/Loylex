import json
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1] / 'deploy/scripts'))
import loylex_approval_host as host
import loylex_approval_validation as policy
import loylex_supervisor_http as http


class T3HostSecurityTests(unittest.TestCase):
    def test_dns_is_pinned_to_public_address_and_tls_uses_original_hostname(self):
        with mock.patch('socket.getaddrinfo', return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('1.1.1.1', 443))]) as dns, mock.patch('socket.create_connection') as connect, mock.patch('ssl.create_default_context') as tls:
            client = host.t3_https('home.example')
            client.connect()
            dns.assert_called_once()
            connect.assert_called_once_with(('1.1.1.1', 443), timeout=30)
            tls.return_value.wrap_socket.assert_called_once_with(connect.return_value, server_hostname='home.example')

    def test_private_mixed_multicast_and_metadata_dns_answers_fail_closed(self):
        for address in ['127.0.0.1', '169.254.169.254', '10.1.1.1', '::1', 'fe80::1', '224.0.0.1', '0.0.0.0']:
            answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('1.1.1.1', 443)), (socket.AF_INET, socket.SOCK_STREAM, 6, '', (address, 443))]
            with self.subTest(address=address), mock.patch('socket.getaddrinfo', return_value=answers), mock.patch('socket.create_connection') as connect:
                with self.assertRaises(host.ApprovalError):
                    host.t3_https('home.example').connect()
                connect.assert_not_called()

    def test_config_symlinks_and_world_readable_credentials_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(Path, 'home', return_value=Path(temporary)):
            host.t3_write('t3-credentials.json', {'secret': 'not-readable'})
            path = Path.home() / '.config/loylex/t3-credentials.json'
            path.chmod(0o644)
            with self.assertRaises(host.ApprovalError):
                host.t3_read('t3-credentials.json')
            link = path.with_name('t3-pending.json')
            link.symlink_to(path)
            with self.assertRaises((host.ApprovalError, OSError)):
                host.t3_read('t3-pending.json')

    def test_callback_config_is_fixed_https_path_without_query_or_credentials(self):
        for url in ['http://example.com/t3/callback', 'https://user:pw@example.com/t3/callback', 'https://example.com/t3/callback?x=y', 'https://example.com/other', 'https://example.com/t3/callback#']:
            with self.subTest(url=url), mock.patch.object(host, 't3_read', return_value={'callbackUrl': url}):
                with self.assertRaises(host.ApprovalError):
                    http.T3OAuth().configuration()

    def test_missing_callback_configuration_leaves_supervisor_available(self):
        with mock.patch.object(host, 't3_read', return_value=None), mock.patch.object(http, 'T3CallbackServer') as listener:
            http.start_t3_callback()
            listener.assert_not_called()

    def test_export_path_and_text_continuation_validation(self):
        for path in ['/etc/passwd', '../secret', 'a/../b', 'C:/file', 'a\\b', 'a//b']:
            with self.subTest(path=path), self.assertRaises(host.ApprovalError):
                policy.validate_t3({'kind': 't3', 'machine': 'home', 'action': 'export', 'arguments': {'projectId': 'p', 'path': path}})
        with self.assertRaises(host.ApprovalError):
            policy.validate_t3({'kind': 't3', 'machine': 'home', 'action': 'read', 'arguments': {'threadId': 't', 'textOffset': 2}})
        policy.validate_t3({'kind': 't3', 'machine': 'home', 'action': 'read', 'arguments': {'threadId': 't', 'itemId': 'i', 'textOffset': 2}})


class T3ManagementTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = mock.patch.object(Path, 'home', return_value=Path(self.temporary.name))
        self.home.start()
        self.entry = {'endpoint': 'https://home.example/mcp', 'tokenSecret': 'loylex-t3-home', 'projects': {}}
        host.t3_write('t3-machines.json', {'home': self.entry})
        self.addCleanup(self.temporary.cleanup)
        self.addCleanup(self.home.stop)

    def operation(self, action, args):
        return {'kind': 't3', 'machine': 'home', 'action': action, 'arguments': args}

    def test_register_persists_exact_folder_and_changed_folder_refuses(self):
        operation = self.operation('register', {'projectId': 'p', 'workspaceRoot': 'C:\\Users\\Andrey\\project'})
        saved = policy.snapshot_t3(operation)
        with mock.patch.object(policy, 'call_t3', return_value={'workspaceRoot': 'C:\\Users\\Andrey\\project'}):
            self.assertEqual(policy.execute_t3(saved)['state'], 'project_registered')
        self.assertEqual(policy.connection('home')['projects'], {'p': 'C:\\Users\\Andrey\\project'})
        saved = policy.snapshot_t3(operation)
        with mock.patch.object(policy, 'call_t3', return_value={'workspaceRoot': '/other'}), self.assertRaises(host.ApprovalError):
            policy.execute_t3(saved)

    def test_disconnect_persists_and_cancels_inflight_login(self):
        host.t3_write('t3-pending.json', {'home': {'state': 'unused'}})
        saved = policy.snapshot_t3(self.operation('disconnect', {}))
        self.assertEqual(policy.execute_t3(saved)['state'], 'disconnected')
        self.assertTrue(host.t3_read('t3-machines.json')['home']['disabled'])
        self.assertEqual(host.t3_read('t3-pending.json'), {})
        with self.assertRaises(host.ApprovalError):
            policy.connection('home')

    def test_export_uses_the_approved_prompt_and_full_access_but_no_content_in_receipt(self):
        self.entry['projects']['p'] = '/project'
        host.t3_write('t3-machines.json', {'home': self.entry})
        saved = policy.snapshot_t3(self.operation('export', {'projectId': 'p', 'path': 'report.txt'}))
        self.assertIn('report.txt', saved['exportPrompt'])
        with mock.patch.object(policy, 'call_t3', side_effect=[{'workspaceRoot': '/project'}, {'threadId': 'mcp:t', 'status': 'running', 'text': 'private'}]) as call:
            self.assertEqual(policy.execute_t3(saved), {'threadId': 'mcp:t', 'status': 'running'})
            self.assertEqual(call.call_args.args[1], 't3_thread_launch')
            self.assertEqual(call.call_args.args[2]['message'], saved['exportPrompt'])
            self.assertEqual(call.call_args.args[2]['runtimeMode'], 'full-access')


class OAuthNetworkTests(unittest.TestCase):
    def test_no_redirect_following_or_remote_error_leakage(self):
        import io
        for status in [302, 400, 401, 500]:
            response = io.BytesIO(b'private-code private-token')
            response.status = status
            connection = mock.Mock()
            connection.getresponse.return_value = response
            with mock.patch.object(host, 't3_https', return_value=connection) as factory:
                with self.assertRaises(host.ApprovalError) as raised:
                    host.t3_json('https://home.example', '/oauth/mcp/token', {'code': 'private-code'}, form=True)
                self.assertNotIn('private', str(raised.exception))
                self.assertEqual(factory.call_count, 1)
                self.assertEqual(connection.request.call_count, 1)
                self.assertTrue(connection.close.called)
