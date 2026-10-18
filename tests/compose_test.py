import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).parents[1] / "deploy/scripts"
sys.path.insert(0, str(SCRIPTS))
import loylex_compose as compose
from loylex_supervisor_errors import SupervisorError

DECLARED = (SCRIPTS.parent / "compose/compose.yaml").read_text()


class ComposeTest(unittest.TestCase):
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
        updated = compose.replace_compose_image_line(
            content, "agent-blue", "ghcr.io/chelokot/loylex-agent@sha256:new"
        )
        self.assertIn("agent-blue:\n    image: ghcr.io/chelokot/loylex-agent@sha256:new", updated)
        self.assertIn("agent-green:\n    image: ghcr.io/chelokot/loylex-agent:main", updated)

    def test_rejects_missing_or_ambiguous_compose_service_image(self) -> None:
        for content in (
            "services:\n  agent-blue:\n    restart: on-failure\n",
            "services:\n"
            "  agent-blue:\n"
            "    image: ghcr.io/chelokot/loylex-agent:main\n"
            "    image: ghcr.io/chelokot/loylex-agent:old\n",
            "services:\n  agent-blue:\n    image: example/image:main\n",
        ):
            with self.subTest(content=content), self.assertRaises(SupervisorError):
                compose.compose_image(content, "agent-blue")

    def test_reinstall_keeps_deployed_images_and_declared_settings(self) -> None:
        deployed = DECLARED
        for service, repository in compose.SERVICE_REPOSITORIES.items():
            deployed = compose.replace_compose_image_line(deployed, service, f"{repository}@sha256:{service}")
        declared = DECLARED.replace("      CODEX_REASONING_EFFORT: low\n", "      CODEX_REASONING_EFFORT: high\n")
        with tempfile.TemporaryDirectory() as directory:
            deployed_path = Path(directory) / "deployed.yaml"
            declared_path = Path(directory) / "declared.yaml"
            deployed_path.write_text(deployed)
            declared_path.write_text(declared)
            result = subprocess.run(
                [sys.executable, str(SCRIPTS / "loylex_compose.py"), str(deployed_path), str(declared_path)],
                capture_output=True,
                text=True,
                check=True,
            )
        for service, repository in compose.SERVICE_REPOSITORIES.items():
            self.assertEqual(compose.compose_image(result.stdout, service), f"{repository}@sha256:{service}")
        self.assertEqual(
            [line for line in result.stdout.splitlines() if not line.startswith("    image:")],
            [line for line in declared.splitlines() if not line.startswith("    image:")],
        )
        self.assertEqual(result.stdout.count("CODEX_REASONING_EFFORT: high"), 2)
