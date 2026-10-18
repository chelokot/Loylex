import http.client
import json
import threading
from pathlib import Path
from unittest import mock

from approval_fixtures import ApprovalTestCase, broker
import loylex_approval_execution as execution
import loylex_approval_host as host
import loylex_approval_packages as packages
import loylex_approval_review as review
import loylex_supervisor_http as supervisor_http


class ApprovalBoundaryTest(ApprovalTestCase):
    def test_git_error_categories_do_not_echo_remote_output(self) -> None:
        cases = (
            (b"fatal: Authentication failed for https://secret@example.test", "authentication rejected"),
            (b"remote: Write access to repository not granted. secret", "repository access denied"),
            (b"fatal: Could not resolve host: secret", "network or TLS failure"),
            (b"fatal: transport 'https' not allowed secret", "transport prohibited"),
            (b"fatal: bad object secret", "missing Git objects"),
            (b"remote: protected branch secret", "remote ref rejected"),
            (b"secret unknown error", "unclassified Git failure"),
        )
        for output, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(host.git_failure_category(output), expected)
        self.assertEqual(
            host.git_failure_category(b"x" * 65536 + b"Authentication failed"),
            "unclassified Git failure",
        )

    def test_failed_git_command_reports_fixed_category(self) -> None:
        def fail(*args, **kwargs):
            kwargs["stderr"].write(b"fatal: Authentication failed for https://secret@example.test")
            return mock.Mock(returncode=128)

        with mock.patch.object(host.subprocess, "run", side_effect=fail):
            with self.assertRaisesRegex(host.ApprovalError, r"^git failed \(exit 128\): authentication rejected$"):
                host.command(["git", "push"])

    def test_reviewer_auth_is_private_and_lifetime_is_independently_bounded(self) -> None:
        def execute(arguments: list[str], **options) -> bytes:
            if arguments[:2] == ["podman", "exec"]:
                return b'{"tokens":{"access_token":"test-only"}}'
            if arguments[:2] == ["podman", "inspect"]:
                return b"sha256:test-image"
            if arguments[:2] == ["podman", "run"]:
                self.assertIn("--timeout=180", arguments)
                self.assertIn("--userns=keep-id:uid=1000,gid=1000", arguments)
                volume = arguments[arguments.index("--volume") + 1]
                auth_path = Path(volume.split(":")[0])
                self.assertEqual(auth_path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(auth_path.parent.stat().st_mode & 0o777, 0o700)
                self.assertIn(":ro,Z", volume)
                self.assertNotIn("--secret", arguments)
                return (
                    b'{"type":"item.completed","item":{"type":"agent_message","text":"Reviewed"}}'
                )
            if arguments[:2] == ["podman", "rm"]:
                return b""
            self.fail(f"Unexpected command: {arguments[0]}")

        with mock.patch.object(review, "command", side_effect=execute):
            result = broker.Approvals._review(self.approvals, "private-auth-test", b"Operation")
        self.assertEqual(result, "Reviewed")

    def test_gateway_deployment_pins_the_built_artifact(self) -> None:
        identifier = self.submit()
        original = host.command
        digest = "sha256:" + "1" * 64

        def execute(arguments: list[str], **options) -> bytes:
            if arguments[:2] == ["podman", "build"]:
                return b""
            if arguments[:3] == ["podman", "image", "inspect"]:
                return digest.encode()
            return original(arguments, **options)

        with mock.patch.object(execution, "command", side_effect=execute):
            result = self.approvals._deploy(
                self.approvals.root / identifier,
                {
                    "kind": "gateway",
                    "commit": self.new_sha,
                    "oldCommit": self.old_sha,
                    "buildRecipe": "FROM scratch\n",
                },
            )
        expected = "ghcr.io/chelokot/loylex-gateway@" + digest
        self.assertEqual(result["image"], expected)
        self.approvals.supervisor.deploy_gateway.assert_called_once_with(expected, self.old_sha)

    def test_host_http_authentication_and_agent_deploy_stays_available(self) -> None:
        supervisor_http.TOKEN = "agent-token"
        supervisor_http.GATEWAY_TOKEN = "gateway-token"
        supervisor_http.APPROVALS = self.approvals
        supervisor_http.SUPERVISOR = mock.Mock()
        supervisor_http.SUPERVISOR.schedule.return_value = {"state": "scheduled"}
        server = supervisor_http.ThreadingHTTPServer(("127.0.0.1", 0), supervisor_http.RequestHandler)
        gateway = supervisor_http.GatewayHTTPServer(("127.0.0.1", 0), supervisor_http.RequestHandler)
        gateway_thread = threading.Thread(target=gateway.serve_forever, daemon=True)
        gateway_thread.start()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def request(path: str, token: str, payload: dict, privileged: bool = False) -> int:
            connection = http.client.HTTPConnection(
                "127.0.0.1", gateway.server_port if privileged else server.server_port
            )
            connection.request(
                "POST", path, json.dumps(payload), {"Authorization": f"Bearer {token}"}
            )
            response = connection.getresponse()
            response.read()
            connection.close()
            return response.status

        try:
            self.assertEqual(request("/v1/approvals/callback", "agent-token", {}), 403)
            self.assertEqual(request("/v1/approvals/callback", "wrong-token", {}), 401)
            self.assertEqual(request("/v1/approvals/callback", "gateway-token", {}), 401)
            self.assertEqual(request("/v1/approvals/callback", "gateway-token", {}, True), 200)
            self.assertEqual(request("/v1/approvals/callback", "agent-token", {}, True), 401)
            self.assertEqual(request("/v1/deploy/gateway", "agent-token", {}), 403)
            self.assertEqual(request("/v1/deploy/all", "agent-token", {}), 403)
            self.assertEqual(request("/v1/deploy/agent", "agent-token", {}), 202)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
            gateway.shutdown()
            gateway.server_close()
            gateway_thread.join()

    def test_operation_validation_rejects_extra_fields_and_path_traversal(self) -> None:
        with self.assertRaises(broker.ApprovalError):
            self.approvals._validate_operation({**self.operation, "shell": "echo privileged"})
        for resource in (
            "issues/../../user",
            "actions/runners/registration-token",
            "pulls",
        ):
            with self.assertRaises(broker.ApprovalError):
                self.approvals._validate_operation(
                    {
                        "kind": "github",
                        "repository": "owner/repo",
                        "method": "POST",
                        "resource": resource,
                        "body": {},
                    }
                )

    def test_infrastructure_updates_install_every_supervisor_module(self) -> None:
        scripts = Path(packages.__file__).parent
        self.assertEqual(
            set(packages.INFRASTRUCTURE_FILES),
            {"loylex-supervisor", *(path.name for path in scripts.glob("loylex_*.py"))},
        )
