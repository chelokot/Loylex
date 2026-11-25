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
    def test_fork_comparison_metadata_is_public_and_validated(self) -> None:
        for metadata, expected in (({"fork": False}, None),
                                   ({"fork": True, "parent": {"full_name": "upstream/project"}}, "upstream/project")):
            with mock.patch.object(packages, "https_request", return_value=(200, json.dumps(metadata).encode())) as request:
                self.assertEqual(packages.ApprovalPackages._fork_parent(self.approvals, "owner/project"), expected)
                self.assertEqual(request.call_args.args[:4], ("api.github.com", "/repos/owner/project", "GET", b""))
                self.assertNotIn("Authorization", request.call_args.args[4])
        for status, data in ((503, b"{}"), (200, b'{"fork":true}'),
                             (200, b'{"fork":true,"parent":{"full_name":"../bad"}}')):
            with mock.patch.object(packages, "https_request", return_value=(status, data)):
                with self.assertRaises(broker.ApprovalError):
                    packages.ApprovalPackages._fork_parent(self.approvals, "owner/project")

    def test_git_error_categories_do_not_echo_remote_output(self) -> None:
        cases = (
            (b"fatal: Authentication failed for https://secret@example.test", "authentication rejected"),
            (b"remote: Write access to repository not granted. secret", "repository access denied"),
            (b"fatal: Could not resolve host: secret", "network or TLS failure"),
            (b"fatal: transport 'https' not allowed secret", "transport prohibited"),
            (b"fatal: bad object secret", "missing Git objects"),
            (b"remote: protected branch secret", "remote ref rejected"),
            (b"fatal: unable to find remote helper for https secret", "Git HTTPS helper unavailable"),
            (b"fatal: detected dubious ownership in repository secret", "Git ownership check rejected repository"),
            (b"fatal: remote error: upload-pack: not our ref secret", "Git object unavailable on remote"),
            (b"fatal: write error: No space left on device secret", "Git storage limit or disk exhaustion"),
            (b"fatal: file size limit exceeded secret", "Git storage limit or disk exhaustion"),
            (b"fatal: cannot allocate memory secret", "Git memory or process limit"),
            (b"error: RPC failed; curl 92 HTTP/2 secret", "Git transport interrupted"),
            (b"fatal: cannot open secret: Permission denied", "Git local permission denied"),
            (b"fatal: fetch-pack: invalid index-pack output secret", "Git pack transfer failed"),
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
        answer = "Обновит файлы супервизора."

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
                return json.dumps({
                    "type": "item.completed",
                    "item": {"type": "agent_message", "text": answer},
                }).encode()
            if arguments[:2] == ["podman", "rm"]:
                return b""
            self.fail(f"Unexpected command: {arguments[0]}")

        with mock.patch.object(review, "command", side_effect=execute):
            result = broker.Approvals._review(self.approvals, "private-auth-test", b"Operation")
            self.assertEqual(result, answer)
            answer = "слово " * 51
            result = broker.Approvals._review(self.approvals, "oversized-review", b"Operation")
            self.assertEqual(result, "TLDR недоступен.")

    def test_gateway_deployment_pins_the_built_artifact(self) -> None:
        identifier = self.submit()
        original = host.command
        digest = "sha256:" + "1" * 64

        build_args: list[str] = []

        def execute(arguments: list[str], **options) -> bytes:
            if arguments[:2] == ["podman", "build"]:
                build_args.extend(arguments)
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
        self.assertIn(f"org.opencontainers.image.revision={self.new_sha}", build_args)
        self.assertIn("org.opencontainers.image.source=https://github.com/chelokot/Loylex", build_args)
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

    def test_git_timeout_and_launch_errors_do_not_leak_arguments(self) -> None:
        import subprocess
        for error, expected in (
            (subprocess.TimeoutExpired(["git", "secret"], 7, stderr=b"secret"), "git timed out after 7s"),
            (OSError(2, "secret"), "git could not start (errno 2)"),
        ):
            with mock.patch.object(host.subprocess, "run", side_effect=error):
                with self.assertRaises(broker.ApprovalError) as raised:
                    host.command(["git", "fetch", "secret"], timeout=7)
                self.assertEqual(str(raised.exception), expected)

    def test_fetch_errors_identify_target_or_installed_commit(self) -> None:
        for stage, sha, effects in (
            ("target", self.new_sha, [broker.ApprovalError("fixed failure")]),
            ("installed", self.old_sha, [None, broker.ApprovalError("fixed failure")]),
        ):
            identifier = "fetch-" + stage
            (self.approvals.root / identifier).mkdir()
            with mock.patch.object(self.approvals, "_installed_commit", return_value=self.old_sha), mock.patch.object(self.approvals, "_fetch", side_effect=effects):
                with self.assertRaises(broker.ApprovalError) as raised:
                    self.approvals._snapshot(identifier, {"kind": "gateway", "commit": self.new_sha})
            self.assertEqual(str(raised.exception), f"Fetching {stage} commit {sha}: fixed failure")

    def test_infrastructure_allows_installing_absent_modules_and_rejects_toctou_appearance(self) -> None:
        import tempfile
        with tempfile.TemporaryDirectory() as home_dir:
            bin_dir = Path(home_dir) / ".local/bin"
            bin_dir.mkdir(parents=True)
            (bin_dir / "loylex-supervisor").write_bytes(b"old-supervisor")
            self.assertIsNone(host.installed_file_sha256(bin_dir / "loylex_tailnet_policy.py"))
            self.assertIsNotNone(host.installed_file_sha256(bin_dir / "loylex-supervisor"))

            # Stage a minimal git archive containing two infrastructure files
            repo_dir = Path(home_dir) / "repo"
            scripts_dir = repo_dir / "deploy/scripts"
            scripts_dir.mkdir(parents=True)
            (scripts_dir / "loylex-supervisor").write_bytes(b"new-supervisor")
            (scripts_dir / "loylex_tailnet_policy.py").write_bytes(b"new-tailnet-policy")
            host.command(["git", "init"], cwd=repo_dir)
            host.command(["git", "config", "user.email", "test@example.com"], cwd=repo_dir)
            host.command(["git", "config", "user.name", "Test"], cwd=repo_dir)
            host.command(["git", "add", "."], cwd=repo_dir)
            host.command(["git", "commit", "-m", "infra"], cwd=repo_dir)
            commit = host.command(["git", "rev-parse", "HEAD"], cwd=repo_dir).decode().strip()

            operation = {
                "kind": "infrastructure",
                "commit": commit,
                "files": ["loylex-supervisor", "loylex_tailnet_policy.py"],
                "installedFiles": {
                    "loylex-supervisor": host.installed_file_sha256(bin_dir / "loylex-supervisor"),
                    "loylex_tailnet_policy.py": None,
                },
            }
            original_command = execution.command

            def exec_cmd(arguments: list[str], **options) -> bytes:
                if arguments and arguments[0] == "systemd-run":
                    return b""
                return original_command(arguments, **options)

            # TOCTOU check: if the previously absent file appears before deploy, reject
            (bin_dir / "loylex_tailnet_policy.py").write_bytes(b"unexpected")
            d1 = self.approvals.root / "infra-toctou"
            d1.mkdir()
            with (
                mock.patch.object(Path, "home", return_value=Path(home_dir)),
                mock.patch.object(self.approvals, "_git", side_effect=lambda _d, *args: host.command(["git", *args], cwd=repo_dir)),
                mock.patch.object(execution, "command", side_effect=exec_cmd),
            ):
                with self.assertRaisesRegex(broker.ApprovalError, "Installed infrastructure file changed"):
                    self.approvals._deploy(d1, operation)

            # When absent as expected, deploy succeeds and installs the new module
            (bin_dir / "loylex_tailnet_policy.py").unlink()
            d2 = self.approvals.root / "infra-install"
            d2.mkdir()
            with (
                mock.patch.object(Path, "home", return_value=Path(home_dir)),
                mock.patch.object(self.approvals, "_git", side_effect=lambda _d, *args: host.command(["git", *args], cwd=repo_dir)),
                mock.patch.object(execution, "command", side_effect=exec_cmd),
            ):
                result = self.approvals._deploy(d2, operation)
            self.assertEqual(result["commit"], commit)
            self.assertEqual((bin_dir / "loylex-supervisor").read_bytes(), b"new-supervisor")
            self.assertEqual((bin_dir / "loylex_tailnet_policy.py").read_bytes(), b"new-tailnet-policy")
