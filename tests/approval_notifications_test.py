from unittest import mock

from approval_fixtures import ApprovalTestCase
from loylex_supervisor_errors import BusyError


class ApprovalNotificationTests(ApprovalTestCase):
    def test_approval_notice_contains_package_and_buttons(self) -> None:
        identifier = self.submit()
        [(method, notice, document)] = self.approvals.messages
        self.assertEqual(method, "sendDocument")
        self.assertEqual(document, (self.approvals.root / identifier / "package.txt").read_bytes())
        self.assertIn("Проверка операции: push", notice["caption"])
        self.assertIn("TLDR: Изменяется тестовый файл.", notice["caption"])
        self.assertEqual(notice["reply_parameters"], {
            "message_id": 10, "allow_sending_without_reply": True,
        })
        self.assertEqual(self.approvals.status(identifier)["message_id"], 101)
        self.assertEqual(
            notice["reply_markup"]["inline_keyboard"][0][0]["callback_data"],
            f"approve:{identifier}",
        )
        self.assertEqual(self.approvals.status(identifier)["state"], "pending")

    def test_busy_failure_replies_with_retry_instructions(self) -> None:
        identifier = self.submit()

        with mock.patch.object(self.approvals, "_git", side_effect=BusyError("busy")):
            self.assertTrue(self.callback(identifier)["accepted"])
            status = self.wait_execution(identifier)
        self.assertEqual(status["result"], "BusyError")
        method, payload, _ = self.approvals.messages[-1]
        self.assertEqual(method, "sendMessage")
        self.assertEqual(payload["reply_parameters"]["message_id"], status["message_id"])
        self.assertIn("создать новую заявку и подтверди её", payload["text"])

    def test_legacy_approval_can_still_be_cancelled(self) -> None:
        identifier = self.submit()
        self.approvals._update(identifier, message_id=102)
        self.assertTrue(self.callback(identifier, action="cancel")["accepted"])
        method, payload, _ = self.approvals.messages[-1]
        self.assertEqual(method, "editMessageText")
        self.assertEqual(payload["message_id"], 102)

    def test_long_review_leaves_room_for_caption_decision(self) -> None:
        with mock.patch.object(self.approvals, "_review", return_value="🙂" * 1024):
            identifier = self.submit()
        self.assertTrue(self.callback(identifier, action="cancel")["accepted"])
        caption = self.approvals.messages[-1][1]["caption"]
        self.assertTrue(caption.endswith("❌ Не одобрено"))
        self.assertLessEqual(len(caption.encode("utf-16-le")) // 2, 1024)
