import base64
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock


SCRIPTS = Path(__file__).parents[1] / "deploy/scripts"
sys.path.insert(0, str(SCRIPTS))
import loylex_approval_host as host
import loylex_approvals as broker


class LocalApprovals(broker.Approvals):
    def __init__(self, root: Path, remote: Path) -> None:
        self.remote = remote
        self.remotes = {}
        self.messages = []
        self.next_message = 100
        super().__init__(mock.Mock(), root)

    def _git(self, directory: Path, *arguments: str, privileged: bool = False) -> bytes:
        arguments = [
            str(self.remotes.get(value, self.remote)) if value.startswith("https://github.com/") else value
            for value in arguments
        ]
        return host.command(["git", "--git-dir", str(directory / "repository.git"), *arguments])

    def _review(self, identifier: str, package: bytes) -> str:
        return "Изменяется тестовый файл."

    def _telegram(self, method: str, payload: dict, document: bytes | None = None) -> dict:
        self.messages.append((method, payload, document))
        if method in {"sendMessage", "sendDocument"}:
            self.next_message += 1
        return {"message_id": payload.get("message_id", self.next_message)}


class ApprovalTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.disk = mock.patch.object(
            broker.shutil, "disk_usage", return_value=mock.Mock(free=10 * 1024**3)
        )
        self.disk.start()
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.source = self.directory / "source"
        self.source.mkdir()
        self.remote = self.directory / "remote.git"
        self.git("init", "-b", "main", str(self.source))
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.com")
        (self.source / "file.txt").write_text("before\n")
        self.git("add", "file.txt")
        self.git("commit", "-m", "Initial")
        self.old_sha = self.git("rev-parse", "HEAD")
        self.git("clone", "--bare", str(self.source), str(self.remote))
        (self.source / "file.txt").write_text("after\n")
        self.git("commit", "-am", "Change")
        self.new_sha = self.git("rev-parse", "HEAD")
        bundle = self.directory / "change.bundle"
        self.git("bundle", "create", str(bundle), "HEAD", "^" + self.old_sha)
        self.operation = {
            "kind": "push",
            "repository": "owner/repository",
            "ref": "refs/heads/main",
            "newSha": self.new_sha,
            "bundle": base64.b64encode(bundle.read_bytes()).decode(),
        }
        self.approvals = LocalApprovals(self.directory / "broker", self.remote)

    def tearDown(self) -> None:
        self.approvals.database.close()
        self.temporary.cleanup()
        self.disk.stop()

    def git(self, *arguments: str) -> str:
        return host.command(["git", *arguments], cwd=self.source).decode().strip()

    def submit(self, operation: dict | None = None) -> str:
        identifier = self.approvals.submit(
            {
                "chatId": -100,
                "replyId": 10,
                "threadId": None,
                "operation": self.operation if operation is None else operation,
            }
        )["id"]
        deadline = time.monotonic() + 5
        while (
            self.approvals.status(identifier)["state"] == "preparing"
            and time.monotonic() < deadline
        ):
            time.sleep(0.01)
        self.assertEqual(
            self.approvals.status(identifier)["state"],
            "pending",
            self.approvals.status(identifier),
        )
        return identifier

    def callback(
        self,
        identifier: str,
        user: int = broker.OPERATOR_ID,
        message: int = 102,
        action: str = "approve",
        chat: int = -100,
    ) -> dict:
        return self.approvals.callback(
            {
                "id": "live-callback",
                "from": {"id": user, "is_bot": False},
                "message": {"message_id": message, "chat": {"id": chat}},
                "data": f"{action}:{identifier}",
            }
        )

    def wait_execution(self, identifier: str) -> dict:
        deadline = time.monotonic() + 5
        while (
            self.approvals.status(identifier)["state"] == "executing"
            and time.monotonic() < deadline
        ):
            time.sleep(0.01)
        return self.approvals.status(identifier)
