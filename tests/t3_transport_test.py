import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1] / "deploy/scripts"))
import loylex_t3_transport as transport
from loylex_approval_host import ApprovalError


class Response(io.BytesIO):
    def __init__(self, value=b"", status=200, content_type="application/json", session=None):
        super().__init__(value)
        self.status = status
        self.content_type = content_type
        self.session = session

    def getheader(self, name, default=None):
        return {"Content-Type": self.content_type, "Mcp-Session-Id": self.session}.get(name, default)


def rpc(identifier, value):
    return json.dumps({"jsonrpc": "2.0", "id": identifier, "result": value}).encode()


class T3TransportTests(unittest.TestCase):
    @mock.patch.object(transport.http.client, "HTTPSConnection")
    def test_initialize_notification_call_and_session_binding(self, factory):
        connections = [mock.Mock() for _ in range(4)]
        factory.side_effect = connections
        connections[0].getresponse.return_value = Response(rpc(1, {"protocolVersion": transport.PROTOCOL}), session="session")
        connections[1].getresponse.return_value = Response(status=202)
        connections[2].getresponse.return_value = Response(rpc(2, {"structuredContent": {"threadId": "mcp:t", "status": "running"}}))
        result = transport.T3Transport("https://home.example/mcp", "private-token").call("t3_thread_wait", {"threadId": "mcp:t", "timeoutMs": 1})
        self.assertEqual(result["status"], "running")
        sent = [json.loads(c.request.call_args.args[2]) for c in connections[:3]]
        self.assertEqual([message["method"] for message in sent], ["initialize", "notifications/initialized", "tools/call"])
        self.assertEqual(sent[2]["params"]["name"], "t3_thread_wait")
        self.assertEqual(connections[2].request.call_args.args[3]["Mcp-Session-Id"], "session")
        self.assertTrue(all(c.close.called for c in connections))
        self.assertEqual(connections[3].request.call_args.args[:2], ("DELETE", "/mcp"))

    @mock.patch.object(transport.http.client, "HTTPSConnection")
    def test_sse_ignores_notifications_and_returns_matching_result(self, factory):
        connection = factory.return_value
        payload = (b'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n' +
                   b"event: message\ndata: " + rpc(1, {"ok": True}) + b"\n\n")
        connection.getresponse.return_value = Response(payload, content_type="text/event-stream")
        result = transport.T3Transport("https://home.example/mcp", "secret")._rpc("initialize", {})
        self.assertEqual(result, {"ok": True})

    @mock.patch.object(transport.http.client, "HTTPSConnection")
    def test_no_redirect_retry_or_remote_error_disclosure(self, factory):
        for status in (302, 401, 403, 500):
            factory.reset_mock()
            factory.return_value.getresponse.return_value = Response(b"private-token hostile error", status=status)
            with self.assertRaises(ApprovalError) as raised:
                transport.T3Transport("https://home.example/mcp", "private-token").call("t3_thread_launch", {})
            self.assertNotIn("private-token", str(raised.exception))
            self.assertNotIn("hostile", str(raised.exception))
            self.assertEqual(factory.call_count, 1)

    @mock.patch.object(transport.http.client, "HTTPSConnection")
    def test_oversize_wrong_id_and_stream_eof_fail_closed(self, factory):
        responses = [Response(b"x" * (transport.MAX_RESPONSE + 1)),
                     Response(rpc(99, {})),
                     Response(b'data: {"method":"ping"}\n\n', content_type="text/event-stream")]
        for response in responses:
            factory.return_value.getresponse.return_value = response
            with self.assertRaises(ApprovalError):
                transport.T3Transport("https://home.example/mcp", "secret")._rpc("initialize", {})

    @mock.patch.object(transport.T3Transport, "_rpc")
    @mock.patch.object(transport.T3Transport, "_post")
    def test_tool_error_is_not_returned_as_content(self, post, rpc_call):
        rpc_call.side_effect = [{"protocolVersion": transport.PROTOCOL}, {"isError": True, "content": [{"text": "secret"}]}]
        with self.assertRaises(ApprovalError) as raised:
            transport.T3Transport("https://home.example/mcp", "secret").call("t3_thread_read", {})
        self.assertNotIn("secret", str(raised.exception))
