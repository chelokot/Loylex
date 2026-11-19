import gzip
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
SUPERVISOR = ROOT / "containers/warp-supervisor.sh"
WRAPPER = ROOT / "containers/loylex-warp"
LOG_SUFFIX = ".local/state/loylex/warp/loylex-warp.log"


class WarpLogTest(unittest.TestCase):
    def test_scripts_parse(self) -> None:
        for script in (SUPERVISOR, WRAPPER):
            subprocess.run(["bash", "-n", str(script)], check=True)

    def test_default_log_is_in_persistent_home_not_tmpfs(self) -> None:
        for script in (SUPERVISOR, WRAPPER):
            text = script.read_text()
            self.assertIn(LOG_SUFFIX, text)
            self.assertNotIn("LOYLEX_WARP_LOG_FILE:-/tmp/", text)

    def test_rotation_archives_the_whole_log_and_empties_the_live_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "warp" / "loylex-warp.log"
            log.parent.mkdir()
            content = b"".join(b"[DEBUG] dbus retry %d\n" % index for index in range(5000))
            log.write_bytes(content)

            self.rotate(log, max_bytes=len(content) - 1)

            archives = sorted((log.parent / "archive").glob("loylex-warp-*.log.gz"))
            self.assertEqual(len(archives), 1)
            with gzip.open(archives[0], "rb") as handle:
                self.assertEqual(handle.read(), content)
            live = log.read_bytes()
            self.assertIn(b"rotated WARP log", live)
            self.assertLess(len(live), 300)

    def test_small_log_is_left_untouched(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "warp" / "loylex-warp.log"
            log.parent.mkdir()
            content = b"[INFO] steady\n" * 10
            log.write_bytes(content)

            self.rotate(log, max_bytes=len(content))

            self.assertEqual(log.read_bytes(), content)
            self.assertFalse((log.parent / "archive").exists())

    def rotate(self, log: Path, max_bytes: int) -> None:
        env = {
            **os.environ,
            "LOYLEX_WARP_LOG_FILE": str(log),
            "LOYLEX_WARP_LOG_MAX_BYTES": str(max_bytes),
        }
        subprocess.run(["bash", str(SUPERVISOR), "rotate-log"], check=True, env=env)


if __name__ == "__main__":
    unittest.main()
