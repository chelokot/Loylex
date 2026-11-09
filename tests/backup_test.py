import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).parents[1] / "deploy/scripts/loylex-backup"
SIZED_PODMAN = """case "$3" in
  loylex-gateway-data) printf '%0100d' 0 ;;
  loylex-audit) printf '%020d' 0 ;;
  loylex-agent-home) printf '%0300d' 0 ;;
  loylex-memory) printf '%04d' 0 ;;
  loylex-workspace) printf '%0500d' 0 ;;
esac"""


class BackupTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.home = self.root / "home"
        self.bin = self.root / "bin"
        self.bin.mkdir()

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def write_executable(self, name: str, content: str) -> None:
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o755)

    def run_backup(self) -> subprocess.CompletedProcess[str]:
        environment = os.environ | {
            "HOME": str(self.home),
            "PATH": f"{self.bin}:/usr/bin:/bin",
        }
        return subprocess.run(
            ["/usr/bin/bash", str(SCRIPT_PATH)],
            env=environment,
            text=True,
            capture_output=True,
            check=False,
        )

    def prepare_commands(self, podman_body: str) -> None:
        self.write_executable(
            "date",
            "#!/usr/bin/env bash\nprintf '20260921T070000Z\\n'\n",
        )
        self.write_executable("podman", f"#!/usr/bin/env bash\n{podman_body}\n")
        self.write_executable(
            "zstd",
            "#!/usr/bin/env bash\nwhile [[ $# -gt 0 ]]; do\n  if [[ $1 == -o ]]; then\n    output=$2\n    shift 2\n  else\n    shift\n  fi\ndone\ncat > \"$output\"\n",
        )

    def test_prunes_expired_backups_before_exporting(self) -> None:
        expired = self.home / "backups/loylex/expired"
        expired.mkdir(parents=True)
        old_time = time.time() - 16 * 24 * 60 * 60
        os.utime(expired, (old_time, old_time))
        self.prepare_commands(
            'test ! -d "$HOME/backups/loylex/expired"\nprintf archive',
        )

        result = self.run_backup()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(expired.exists())
        destination = self.home / "backups/loylex/20260921T070000Z"
        self.assertEqual(len(list(destination.glob("*.tar.zst"))), 5)

    def test_removes_incomplete_backup_after_export_failure(self) -> None:
        self.prepare_commands("exit 1")

        result = self.run_backup()

        self.assertNotEqual(result.returncode, 0)
        destination = self.home / "backups/loylex/20260921T070000Z"
        self.assertFalse(destination.exists())
        self.assertFalse((self.home / "backups/loylex-manifests/20260921T070000Z.tsv").exists())

    def test_writes_size_manifest_without_archive_contents(self) -> None:
        self.prepare_commands(SIZED_PODMAN)

        result = self.run_backup()

        self.assertEqual(result.returncode, 0, result.stderr)
        manifests = self.home / "backups/loylex-manifests"
        manifest = manifests / "20260921T070000Z.tsv"
        self.assertEqual(
            manifest.read_text().splitlines(),
            [
                "volume\tbytes",
                "loylex-gateway-data\t100",
                "loylex-audit\t20",
                "loylex-agent-home\t300",
                "loylex-memory\t4",
                "loylex-workspace\t500",
                "total\t924",
            ],
        )
        self.assertEqual(manifest.stat().st_mode & 0o777, 0o644)
        self.assertEqual(manifests.stat().st_mode & 0o777, 0o755)

    def test_prunes_manifests_older_than_thirty_days(self) -> None:
        manifests = self.home / "backups/loylex-manifests"
        manifests.mkdir(parents=True)
        expired = manifests / "20260801T042000Z.tsv"
        recent = manifests / "20260915T042000Z.tsv"
        expired.write_text("volume\tbytes\n")
        recent.write_text("volume\tbytes\n")
        old_time = time.time() - 31 * 24 * 60 * 60
        os.utime(expired, (old_time, old_time))
        self.prepare_commands(SIZED_PODMAN)

        result = self.run_backup()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(expired.exists())
        self.assertTrue(recent.exists())


if __name__ == "__main__":
    unittest.main()
