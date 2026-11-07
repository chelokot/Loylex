"""Emulate the file set selected by the supervisor installed before PR #8."""
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).parents[1] / "deploy/scripts"
PRE_T3_FILES = (
    "loylex-supervisor",
    "loylex_approval_execution.py",
    "loylex_approval_host.py",
    "loylex_approval_packages.py",
    "loylex_approval_review.py",
    "loylex_approval_validation.py",
    "loylex_approvals.py",
    "loylex_compose.py",
    "loylex_supervisor_errors.py",
    "loylex_supervisor_http.py",
)


class T3BootstrapTests(unittest.TestCase):
    def test_previous_updater_file_set_loads_the_complete_t3_bridge(self):
        with tempfile.TemporaryDirectory() as temporary:
            for name in PRE_T3_FILES:
                shutil.copyfile(SCRIPTS / name, Path(temporary) / name)
            probe = """
import sys
sys.path.insert(0, sys.argv[1])
import loylex_supervisor_http
from loylex_approvals import Approvals
from loylex_approval_packages import INFRASTRUCTURE_FILES
assert set(INFRASTRUCTURE_FILES) == set(sys.argv[2:])
Approvals._validate_operation({'kind': 't3', 'machine': 'home', 'action': 'read', 'arguments': {'threadId': 'mcp:t'}})
"""
            result = subprocess.run(
                [sys.executable, "-I", "-B", "-c", probe, temporary, *PRE_T3_FILES],
                capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
