import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).parents[1] / "deploy/scripts/loylex-backup"


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


if __name__ == "__main__":
    unittest.main()
