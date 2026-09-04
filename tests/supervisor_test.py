import importlib.util
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path


SCRIPT_PATH = Path(__file__).parents[1] / "deploy/scripts/loylex-supervisor"
LOADER = SourceFileLoader("loylex_supervisor", str(SCRIPT_PATH))
SPEC = importlib.util.spec_from_loader("loylex_supervisor", LOADER)
if SPEC is None:
    raise RuntimeError("Unable to load loylex-supervisor")
SUPERVISOR = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(SUPERVISOR)


class SupervisorTest(unittest.TestCase):
    def test_replaces_only_expected_image(self) -> None:
        content = "[Container]\nImage=ghcr.io/chelokot/loylex-agent:main\nReadOnly=true\n"
        updated = SUPERVISOR.replace_image_line(
            content,
            "ghcr.io/chelokot/loylex-agent",
            "ghcr.io/chelokot/loylex-agent@sha256:123",
        )
        self.assertEqual(
            updated,
            "[Container]\nImage=ghcr.io/chelokot/loylex-agent@sha256:123\nReadOnly=true\n",
        )

    def test_rejects_missing_or_ambiguous_image(self) -> None:
        with self.assertRaises(SUPERVISOR.SupervisorError):
            SUPERVISOR.replace_image_line("[Container]\n", "example/image", "example/image@sha256:1")
        with self.assertRaises(SUPERVISOR.SupervisorError):
            SUPERVISOR.replace_image_line(
                "Image=example/image:main\nImage=example/image:old\n",
                "example/image",
                "example/image@sha256:1",
            )

    def test_selects_only_fixed_components(self) -> None:
        self.assertEqual(SUPERVISOR.selected_components("agent"), ["agent"])
        self.assertEqual(SUPERVISOR.selected_components("all"), ["gateway", "agent"])
        with self.assertRaises(SUPERVISOR.SupervisorError):
            SUPERVISOR.selected_components("host")

    def test_replaces_only_expected_compose_service_image(self) -> None:
        content = (
            "services:\n"
            "  gateway:\n"
            "    image: ghcr.io/chelokot/loylex-gateway@sha256:old\n"
            "  agent-blue:\n"
            "    image: ghcr.io/chelokot/loylex-agent:main\n"
            "  agent-green:\n"
            "    image: ghcr.io/chelokot/loylex-agent:main\n"
            "volumes:\n"
        )
        updated = SUPERVISOR.replace_compose_image_line(
            content,
            "agent-blue",
            "ghcr.io/chelokot/loylex-agent",
            "ghcr.io/chelokot/loylex-agent@sha256:new",
        )
        self.assertIn("agent-blue:\n    image: ghcr.io/chelokot/loylex-agent@sha256:new", updated)
        self.assertIn("agent-green:\n    image: ghcr.io/chelokot/loylex-agent:main", updated)

    def test_initial_compose_images_are_immutable(self) -> None:
        compose = (SCRIPT_PATH.parents[1] / "compose/compose.yaml").read_text()
        self.assertNotIn("ghcr.io/chelokot/loylex-agent:main", compose)
        self.assertNotIn("ghcr.io/chelokot/loylex-gateway:main", compose)
        self.assertEqual(compose.count("ghcr.io/chelokot/loylex-agent@sha256:"), 2)

    def test_external_secrets_use_podman_compose_mount_names(self) -> None:
        compose = (SCRIPT_PATH.parents[1] / "compose/compose.yaml").read_text()
        self.assertNotIn("target:", compose)
        self.assertIn("/run/secrets/loylex-telegram-token", compose)
        self.assertEqual(compose.count("/run/secrets/loylex-bridge-token"), 3)
        self.assertEqual(compose.count("/run/secrets/loylex-supervisor-token"), 2)

    def test_worker_root_filesystems_are_read_only(self) -> None:
        compose = (SCRIPT_PATH.parents[1] / "compose/compose.yaml").read_text()
        self.assertEqual(compose.count("    read_only: true"), 3)
        self.assertEqual(compose.count("/tmp:rw,nodev,nosuid,noexec,size=256m"), 2)

    def test_agent_runtime_and_cli_use_image_pinned_sources(self) -> None:
        root = SCRIPT_PATH.parents[1].parent
        entrypoint = (root / "containers/agent-entrypoint.sh").read_text()
        cli = (root / "containers/loylex-cli").read_text()
        self.assertIn("bun /opt/loylex/app/src/agent/main.ts", entrypoint)
        self.assertIn('rm -f "$worker_ready_path"', entrypoint)
        self.assertIn('git config --global --replace-all safe.directory "$repository_path"', entrypoint)
        self.assertNotIn("--add safe.directory", entrypoint)
        self.assertIn("exec bun /opt/loylex/app/src/agent/cli.ts", cli)

    def test_persistent_worker_volumes_relabel_and_map_ownership(self) -> None:
        compose = (SCRIPT_PATH.parents[1] / "compose/compose.yaml").read_text()
        self.assertEqual(compose.count("agent-home:/home/loylex:Z,U"), 2)
        self.assertEqual(compose.count("memory:/memory:Z,U"), 2)
        self.assertEqual(compose.count("workspace:/workspace:Z,U"), 2)

    def test_rejects_missing_or_ambiguous_compose_service_image(self) -> None:
        with self.assertRaises(SUPERVISOR.SupervisorError):
            SUPERVISOR.replace_compose_image_line(
                "services:\n  agent-blue:\n    restart: on-failure\n",
                "agent-blue",
                "example/image",
                "example/image@sha256:1",
            )
        with self.assertRaises(SUPERVISOR.SupervisorError):
            SUPERVISOR.replace_compose_image_line(
                "services:\n"
                "  agent-blue:\n"
                "    image: example/image:main\n"
                "    image: example/image:old\n",
                "agent-blue",
                "example/image",
                "example/image@sha256:1",
            )


if __name__ == "__main__":
    unittest.main()
