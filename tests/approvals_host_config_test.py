from pathlib import Path
from unittest import mock

from approval_fixtures import ApprovalTestCase, broker


DEPLOYED_DIGEST = "b" * 64
DECLARED_DIGEST = "c" * 64
GATEWAY_DIGEST = "d" * 64
MANIFEST_MOUNT = "      - /home/loylex/backups/loylex-manifests:/backup-manifests:ro,z\n"


def compose_file(agent_digest: str, extra_volume: str = "") -> str:
    return (
        "services:\n"
        "  gateway:\n"
        f"    image: ghcr.io/chelokot/loylex-gateway@sha256:{GATEWAY_DIGEST}\n"
        "  agent-blue:\n"
        f"    image: ghcr.io/chelokot/loylex-agent@sha256:{agent_digest}\n"
        "    volumes:\n"
        "      - workspace:/workspace:z,U\n"
        f"{extra_volume}"
        "  agent-green:\n"
        f"    image: ghcr.io/chelokot/loylex-agent@sha256:{agent_digest}\n"
        "volumes:\n"
        "  workspace:\n"
        "    name: loylex-workspace\n"
        "    external: true\n"
    )


class HostConfigApprovalTest(ApprovalTestCase):
    def stage_host_config(self, installed_compose: str, declared_compose: str) -> tuple[Path, str]:
        home = self.directory / "home"
        (home / ".local/bin").mkdir(parents=True)
        (home / "stack").mkdir()
        (home / ".local/bin/loylex-backup").write_text("old backup\n")
        (home / "stack/compose.yaml").write_text(installed_compose)
        (self.source / "deploy/scripts").mkdir(parents=True)
        (self.source / "deploy/compose").mkdir(parents=True)
        (self.source / "deploy/scripts/loylex-backup").write_text("new backup\n")
        (self.source / "deploy/compose/compose.yaml").write_text(declared_compose)
        self.git("add", "deploy")
        self.git("commit", "-m", "Host configuration")
        commit = self.git("rev-parse", "HEAD")
        self.git("push", str(self.remote), "HEAD:main")
        return home, commit

    def test_host_config_reviews_installed_diff_and_keeps_deployed_images(self) -> None:
        home, commit = self.stage_host_config(
            compose_file(DEPLOYED_DIGEST), compose_file(DECLARED_DIGEST, MANIFEST_MOUNT)
        )
        with mock.patch.object(Path, "home", return_value=home):
            identifier = self.submit({"kind": "host-config", "commit": commit})
            document = self.approvals.messages[0][2]
            self.assertIn(b"-old backup", document)
            self.assertIn(b"+new backup", document)
            self.assertIn(MANIFEST_MOUNT.encode(), document)
            self.assertNotIn(DECLARED_DIGEST.encode(), document)
            self.assertTrue(self.callback(identifier)["accepted"])
            self.assertEqual(self.wait_execution(identifier)["state"], "succeeded")
        self.assertEqual((home / ".local/bin/loylex-backup").read_text(), "new backup\n")
        self.assertEqual(
            (home / "stack/compose.yaml").read_text(),
            compose_file(DEPLOYED_DIGEST, MANIFEST_MOUNT),
        )
        self.assertEqual((home / "backups/loylex-manifests").stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.approvals.root / "host-config-commit").read_text(), commit)

    def test_host_config_refuses_local_edits_after_review(self) -> None:
        home, commit = self.stage_host_config(
            compose_file(DEPLOYED_DIGEST), compose_file(DECLARED_DIGEST, MANIFEST_MOUNT)
        )
        with mock.patch.object(Path, "home", return_value=home):
            identifier = self.submit({"kind": "host-config", "commit": commit})
            (home / ".local/bin/loylex-backup").write_text("edited after review\n")
            self.assertTrue(self.callback(identifier)["accepted"])
            status = self.wait_execution(identifier)
        self.assertEqual(status["state"], "failed")
        self.assertIn("Installed host file changed: loylex-backup", status["result"])
        self.assertEqual((home / ".local/bin/loylex-backup").read_text(), "edited after review\n")
        self.assertFalse((self.approvals.root / "host-config-commit").exists())

    def test_host_config_keeps_image_pins_that_deploys_changed_after_review(self) -> None:
        home, commit = self.stage_host_config(
            compose_file(DEPLOYED_DIGEST), compose_file(DECLARED_DIGEST, MANIFEST_MOUNT)
        )
        redeployed = "e" * 64
        with mock.patch.object(Path, "home", return_value=home):
            identifier = self.submit({"kind": "host-config", "commit": commit})
            (home / "stack/compose.yaml").write_text(compose_file(redeployed))
            self.assertTrue(self.callback(identifier)["accepted"])
            self.assertEqual(self.wait_execution(identifier)["state"], "succeeded")
        self.assertEqual(
            (home / "stack/compose.yaml").read_text(),
            compose_file(redeployed, MANIFEST_MOUNT),
        )

    def test_host_config_refuses_compose_edits_outside_image_pins(self) -> None:
        home, commit = self.stage_host_config(
            compose_file(DEPLOYED_DIGEST), compose_file(DECLARED_DIGEST, MANIFEST_MOUNT)
        )
        with mock.patch.object(Path, "home", return_value=home):
            identifier = self.submit({"kind": "host-config", "commit": commit})
            (home / "stack/compose.yaml").write_text(
                compose_file(DEPLOYED_DIGEST, "      - /tmp/extra:/extra\n")
            )
            self.assertTrue(self.callback(identifier)["accepted"])
            status = self.wait_execution(identifier)
        self.assertEqual(status["state"], "failed")
        self.assertIn("Installed host file changed: compose.yaml", status["result"])
        self.assertEqual((home / ".local/bin/loylex-backup").read_text(), "old backup\n")

    def test_host_config_accepts_only_a_full_commit_sha(self) -> None:
        self.approvals._validate_operation({"kind": "host-config", "commit": "a" * 40})
        for operation in (
            {"kind": "host-config", "commit": "main"},
            {"kind": "host-config", "commit": "a" * 40, "files": []},
        ):
            with self.assertRaises(broker.ApprovalError):
                self.approvals._validate_operation(operation)
