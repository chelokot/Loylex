import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1] / "deploy/scripts"))
import loylex_approval_validation as bridge
from loylex_approval_host import ApprovalError
from approval_fixtures import ApprovalTestCase

ENTRY = {"endpoint": "https://home.example/mcp", "tokenSecret": "loylex-t3-home", "projects": {"project-1": "/home/user/project"}}


def operation(action="launch", arguments=None):
    return {"kind": "t3", "machine": "home", "action": action, "arguments": arguments if arguments is not None else {
        "projectId": "project-1", "title": "Build", "message": "Run tests"}}


class T3PolicyTests(unittest.TestCase):
    def test_no_generic_tool_url_mode_or_shell_escape_hatches(self):
        bad = [operation("tools/call", {}), operation("status", {}),
               {**operation(), "endpoint": "https://other.example/mcp"},
               operation(arguments={"projectId": "p", "title": "t", "message": "m", "runtimeMode": "inherit"}),
               operation("read", {"threadId": "t", "limit": True}),
               operation("read", {"threadId": "t", "maxCharsPerItem": 50001}),
               operation("send", {"threadId": "t", "message": ""}),
               operation("read", {"threadId": "t", "environmentId": "other"})]
        for item in bad:
            with self.subTest(item=item), self.assertRaises(ApprovalError):
                bridge.validate_t3(item)

    def test_host_registry_permissions_and_endpoint_validation(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(Path, "home", return_value=Path(temporary)):
            path = Path(temporary) / ".config/loylex/t3-machines.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({"home": ENTRY}))
            path.chmod(0o644)
            with self.assertRaises(ApprovalError):
                bridge.connection("home")
            path.chmod(0o600)
            self.assertEqual(bridge.connection("home"), ENTRY)
            for endpoint in ["http://home/mcp", "https://home/mcp?token=x", "https://user:pw@home/mcp", "https://home:444/mcp"]:
                path.write_text(json.dumps({"home": {**ENTRY, "endpoint": endpoint}}))
                with self.assertRaises(ApprovalError):
                    bridge.connection("home")

    @mock.patch.object(bridge, "connection", return_value=ENTRY)
    @mock.patch.object(bridge, "call_t3")
    def test_status_never_reads_or_returns_content(self, call, _connection):
        call.return_value = {"threadId": "t", "runId": "r", "status": "running", "title": "private", "items": ["secret"], "summary": "secret", "next": "injected"}
        self.assertEqual(bridge.t3_status({"machine": "home", "threadId": "t"}),
                         {"machine": "home", "threadId": "t", "runId": "r", "status": "running"})
        call.assert_called_once_with(ENTRY, "t3_thread_wait", {"threadId": "t", "timeoutMs": 1})
        call.return_value["status"] = "private text"
        with self.assertRaises(ApprovalError):
            bridge.t3_status({"machine": "home", "threadId": "t"})
        with self.assertRaises(ApprovalError):
            bridge.t3_status({"machine": "home", "threadId": "t", "action": "read"})

    @mock.patch.object(bridge, "connection", return_value=ENTRY)
    @mock.patch.object(bridge, "call_t3")
    def test_full_access_launch_and_changed_target_fail_closed(self, call, connection):
        saved = bridge.snapshot_t3(operation())
        call.side_effect = [{"workspaceRoot": "/home/user/project"}, {"threadId": "mcp:thread", "runId": "r", "status": "running", "text": "private"}]
        self.assertEqual(bridge.execute_t3(saved), {"threadId": "mcp:thread", "runId": "r", "status": "running"})
        args = call.call_args.args[2]
        self.assertEqual(args["runtimeMode"], "full-access")
        self.assertEqual(args["interactionMode"], "default")
        connection.return_value = {**ENTRY, "endpoint": "https://other.example/mcp"}
        with self.assertRaises(ApprovalError):
            bridge.execute_t3(saved)
        self.assertEqual(call.call_count, 2)

    @mock.patch.object(bridge, "connection", return_value=ENTRY)
    @mock.patch.object(bridge, "call_t3")
    def test_approved_read_is_bounded_and_paginated(self, call, _connection):
        call.return_value = {"items": [{"text": "approved result"}], "hasMore": True, "nextPosition": 20}
        result = bridge.execute_t3(bridge.snapshot_t3(operation("read", {"threadId": "t", "afterPosition": 5})))
        self.assertTrue(result["hasMore"])
        self.assertEqual(call.call_args.args, (ENTRY, "t3_thread_read", {
            "threadId": "t", "afterPosition": 5, "view": "messages", "runLimit": 1, "limit": 20, "maxCharsPerItem": 10000}))


class T3BrokerTests(ApprovalTestCase):
    @mock.patch.object(bridge, "connection", return_value=ENTRY)
    @mock.patch.object(bridge, "call_t3")
    def test_live_button_executes_saved_t3_operation_once(self, call, connection):
        call.side_effect = [{"workspaceRoot": "/home/user/project"}, {"threadId": "t", "status": "running"}]
        identifier = self.submit(operation())
        call.assert_not_called()
        package = (self.approvals.root / identifier / "package.txt").read_text()
        self.assertIn('"executionMode": "full-access"', package)
        self.assertIn('"endpoint": "https://home.example/mcp"', package)
        self.assertFalse(self.callback(identifier, user=1)["accepted"])
        call.assert_not_called()
        self.assertTrue(self.callback(identifier)["accepted"])
        self.assertEqual(self.wait_execution(identifier)["state"], "succeeded")
        self.assertFalse(self.callback(identifier)["accepted"])
        self.assertEqual(call.call_count, 2)

    @mock.patch.object(bridge, "connection", return_value=ENTRY)
    @mock.patch.object(bridge, "call_t3", side_effect=ApprovalError("network failed; outcome unknown"))
    def test_unknown_outcome_is_not_replayed(self, call, connection):
        identifier = self.submit(operation())
        self.callback(identifier)
        self.assertEqual(self.wait_execution(identifier)["state"], "failed")
        self.assertFalse(self.callback(identifier)["accepted"])
        self.assertEqual(call.call_count, 1)

    @mock.patch.object(bridge, "connection", return_value=ENTRY)
    @mock.patch.object(bridge, "call_t3", return_value={"threadId": "mcp:t", "runId": "r", "status": "completed", "summary": "private"})
    def test_status_submission_returns_immediately_without_a_button(self, call, connection):
        result = self.approvals.submit({"chatId": -100, "replyId": 10, "threadId": None,
                                       "operation": {"kind": "t3-status", "machine": "home", "threadId": "mcp:t"}})
        self.assertEqual(result, {"machine": "home", "threadId": "mcp:t", "runId": "r", "status": "completed"})
        self.assertEqual(self.approvals.messages, [])
        self.assertEqual(self.approvals.database.execute("SELECT COUNT(*) FROM approvals").fetchone()[0], 0)
        call.assert_called_once()


class T3SendTests(unittest.TestCase):
    @mock.patch.object(bridge, "connection", return_value=ENTRY)
    @mock.patch.object(bridge, "call_t3")
    def test_send_checks_folder_and_mode_and_returns_only_receipt(self, call, connection):
        saved = bridge.snapshot_t3(operation("send", {"projectId": "project-1", "threadId": "mcp:t", "message": "Run tests"}))
        call.side_effect = [{"workspaceRoot": "/home/user/project"},
                            {"threads": [{"threadId": "mcp:t", "runtimeMode": "full-access", "interactionMode": "default"}], "nextCursor": None},
                            {"threadId": "mcp:t", "runId": "mcp:r", "status": "queued", "summary": "secret"}]
        result = bridge.execute_t3(saved)
        self.assertEqual(result, {"threadId": "mcp:t", "runId": "mcp:r", "status": "queued"})
        self.assertEqual(call.call_args.args, (ENTRY, "t3_thread_send", {
            "threadId": "mcp:t", "message": "Run tests", "mode": "queue", "clientRequestId": saved["requestKey"]}))

    @mock.patch.object(bridge, "connection", return_value=ENTRY)
    @mock.patch.object(bridge, "call_t3")
    def test_supervised_session_and_changed_folder_refuse_before_sending(self, call, connection):
        saved = bridge.snapshot_t3(operation("send", {"projectId": "project-1", "threadId": "t", "message": "Run tests"}))
        for mode in ("approval-required", "auto-accept-edits", "auto"):
            call.reset_mock()
            call.side_effect = [{"workspaceRoot": "/home/user/project"},
                                {"threads": [{"threadId": "t", "runtimeMode": mode, "interactionMode": "default"}], "nextCursor": None}]
            with self.assertRaises(ApprovalError):
                bridge.execute_t3(saved)
            self.assertEqual(call.call_count, 2)
        call.reset_mock()
        call.side_effect = [{"workspaceRoot": "/somewhere/else"}]
        with self.assertRaises(ApprovalError):
            bridge.execute_t3(saved)
        self.assertEqual(call.call_count, 1)

    @mock.patch.object(bridge, "call_t3")
    def test_status_rate_limit(self, call):
        with mock.patch.object(bridge, "STATUS_TIMES", bridge.deque([bridge.time.monotonic()] * 120)):
            with self.assertRaises(ApprovalError):
                bridge.t3_status({"machine": "home", "threadId": "t"})
            call.assert_not_called()

    def test_busy_limit_fails_before_secret_or_network_access(self):
        with mock.patch.object(bridge, "SLOTS", bridge.threading.BoundedSemaphore(1)), mock.patch.object(bridge, "secret") as secret:
            bridge.SLOTS.acquire()
            with self.assertRaises(ApprovalError):
                bridge.call_t3(ENTRY, "t3_thread_wait", {"threadId": "t"})
            secret.assert_not_called()
