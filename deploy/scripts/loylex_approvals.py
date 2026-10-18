import hashlib
import json
import re
import shutil
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from loylex_approval_execution import ApprovalExecution
from loylex_approval_host import ApprovalError, encoded, https_request, secret
from loylex_approval_packages import ApprovalPackages
from loylex_approval_review import ApprovalReview
from loylex_approval_validation import OperationValidation


OPERATOR_ID = 426043802


class Approvals(OperationValidation, ApprovalPackages, ApprovalReview, ApprovalExecution):
    def __init__(self, supervisor: Any, root: Path | None = None) -> None:
        self.supervisor = supervisor
        self.root = root or Path.home() / ".local/state/loylex-approvals"
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.review_lock = threading.Lock()
        self.execution_lock = threading.Lock()
        self.database = sqlite3.connect(self.root / "approvals.sqlite", check_same_thread=False)
        self.database.row_factory = sqlite3.Row
        self.database.execute("PRAGMA journal_mode=WAL")
        self.database.execute("PRAGMA synchronous=FULL")
        self.database.execute("""CREATE TABLE IF NOT EXISTS approvals (
            id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, reply_id INTEGER NOT NULL,
            thread_id INTEGER, created INTEGER NOT NULL, state TEXT NOT NULL,
            digest TEXT, message_id INTEGER, document_id INTEGER, review TEXT, result TEXT
        )""")
        self.database.execute(
            "UPDATE approvals SET state='interrupted' WHERE state IN ('preparing','executing')"
        )
        self.database.commit()

    def _row(self, identifier: str) -> sqlite3.Row:
        with self.lock:
            row = self.database.execute(
                "SELECT * FROM approvals WHERE id=?", (identifier,)
            ).fetchone()
        if row is None:
            raise ApprovalError("Unknown approval")
        return row

    def status(self, identifier: str) -> dict[str, Any]:
        with self.lock:
            row = self._row(identifier)
            return {
                key: row[key] for key in ("id", "state", "digest", "message_id", "review", "result")
            }

    def _update(self, identifier: str, **values: Any) -> None:
        with self.lock:
            columns = ",".join(f"{key}=?" for key in values)
            self.database.execute(
                f"UPDATE approvals SET {columns} WHERE id=?",
                (*values.values(), identifier),
            )
            self.database.commit()

    def submit(self, payload: dict[str, Any]) -> dict[str, Any]:
        if set(payload) != {"chatId", "replyId", "threadId", "operation"}:
            raise ApprovalError("Expected chatId, replyId, threadId and operation")
        if (
            type(payload["chatId"]) is not int
            or type(payload["replyId"]) is not int
            or payload["replyId"] <= 0
        ):
            raise ApprovalError("Invalid Telegram address")
        if payload["threadId"] is not None and (
            type(payload["threadId"]) is not int or payload["threadId"] <= 0
        ):
            raise ApprovalError("Invalid Telegram thread")
        operation = payload["operation"]
        self._validate_operation(operation)
        with self.lock:
            if shutil.disk_usage(self.root).free < 2 * 1024 * 1024 * 1024:
                raise ApprovalError("Less than 2 GiB of host disk space remains")
            now = int(time.time())
            self.database.execute(
                "UPDATE approvals SET state='expired' WHERE state='pending' AND created<?",
                (now - 3600,),
            )
            active = self.database.execute(
                "SELECT chat_id FROM approvals WHERE state IN ('preparing','pending','executing')"
            ).fetchall()
            recent = self.database.execute(
                "SELECT COUNT(*) FROM approvals WHERE created>?", (now - 3600,)
            ).fetchone()[0]
            if (
                len(active) >= 10
                or sum(row[0] == payload["chatId"] for row in active) >= 3
                or recent >= 30
            ):
                raise ApprovalError(
                    "Approval queue limit reached; wait or cancel existing requests"
                )
            identifier = uuid.uuid4().hex
            directory = self.root / identifier
            directory.mkdir(mode=0o700)
            (directory / "request.json").write_bytes(encoded(operation))
            self.database.execute(
                "INSERT INTO approvals (id,chat_id,reply_id,thread_id,created,state) VALUES (?,?,?,?,?,'preparing')",
                (
                    identifier,
                    payload["chatId"],
                    payload["replyId"],
                    payload["threadId"],
                    now,
                ),
            )
            self.database.commit()
        threading.Thread(
            target=self._prepare_and_notify, args=(identifier, operation), daemon=True
        ).start()
        return self.status(identifier)

    def _telegram(
        self, method: str, payload: dict[str, Any], document: bytes | None = None
    ) -> dict[str, Any]:
        if document is None:
            body = encoded(payload)
            content_type = "application/json"
        else:
            boundary = uuid.uuid4().hex
            body = b""
            for key, value in payload.items():
                text = json.dumps(value) if isinstance(value, (dict, list)) else str(value)
                body += f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{text}\r\n'.encode()
            body += f'--{boundary}\r\nContent-Disposition: form-data; name="document"; filename="operation.txt"\r\nContent-Type: text/plain\r\n\r\n'.encode()
            body += document + f"\r\n--{boundary}--\r\n".encode()
            content_type = f"multipart/form-data; boundary={boundary}"
        status, data = https_request(
            "api.telegram.org",
            f"/bot{secret('loylex-telegram-token')}/{method}",
            "POST",
            body,
            {"Content-Type": content_type},
        )
        response = json.loads(data)
        if status != 200 or not response.get("ok"):
            raise ApprovalError(f"Telegram {method} failed (HTTP {status})")
        return response["result"]

    def _prepare_and_notify(self, identifier: str, operation: dict[str, Any]) -> None:
        try:
            package = self._snapshot(identifier, operation)
            digest = hashlib.sha256(package).hexdigest()
            try:
                review = self._review(identifier, package)
            except Exception:
                review = "TLDR недоступен."
            with self.lock:
                row = self._row(identifier)
                document = self._telegram(
                    "sendDocument",
                    {
                        "chat_id": row["chat_id"],
                        "caption": "Пакет операции",
                        "reply_parameters": {
                            "message_id": row["reply_id"],
                            "allow_sending_without_reply": True,
                        },
                        **(
                            {"message_thread_id": row["thread_id"]}
                            if row["thread_id"] is not None
                            else {}
                        ),
                    },
                    package,
                )
                self._update(identifier, document_id=document["message_id"])
                text = f"@Chelokot\n\nTLDR: {review}"
                message = self._telegram(
                    "sendMessage",
                    {
                        "chat_id": row["chat_id"],
                        "text": text,
                        "reply_parameters": {"message_id": document["message_id"]},
                        "reply_markup": {
                            "inline_keyboard": [
                                [
                                    {
                                        "text": "Одобрить",
                                        "callback_data": f"approve:{identifier}",
                                    },
                                    {
                                        "text": "Отменить",
                                        "callback_data": f"cancel:{identifier}",
                                    },
                                ]
                            ]
                        },
                        **(
                            {"message_thread_id": row["thread_id"]}
                            if row["thread_id"] is not None
                            else {}
                        ),
                    },
                )
                self._update(
                    identifier,
                    digest=digest,
                    message_id=message["message_id"],
                    review=review,
                    state="pending",
                )
        except Exception as error:
            detail = str(error) if isinstance(error, ApprovalError) else type(error).__name__
            self._update(identifier, state="failed", result=f"Preparation failed: {detail}")

    def telegram_allowed(self, method: str, parameters: dict[str, Any]) -> bool:
        method = method.lower()
        if method in {
            "getupdates",
            "setwebhook",
            "deletewebhook",
            "logout",
            "close",
            "deleteforumtopic",
            "deletebusinessmessages",
        }:
            return False
        if not method.startswith(("editmessage", "deletemessage")):
            return True
        if "inline_message_id" in parameters:
            return False
        chat_id = parameters.get("chat_id")
        try:
            chat_id = int(chat_id)
            ids = parameters.get("message_ids", [parameters.get("message_id")])
            if isinstance(ids, str):
                ids = json.loads(ids)
            ids = [int(value) for value in ids]
        except (TypeError, ValueError, json.JSONDecodeError):
            return False
        with self.lock:
            rows = self.database.execute(
                "SELECT message_id,document_id FROM approvals WHERE chat_id=?",
                (chat_id,),
            ).fetchall()
            return all(value not in ids for row in rows for value in row if value is not None)

    def _mark_decision(self, row: sqlite3.Row, approved: bool) -> None:
        decision = "✅ Одобрено" if approved else "❌ Не одобрено"
        try:
            self._telegram(
                "editMessageText",
                {
                    "chat_id": row["chat_id"],
                    "message_id": row["message_id"],
                    "text": f"@Chelokot\n\nTLDR: {row['review']}\n\n{decision}",
                    "reply_markup": {"inline_keyboard": []},
                },
            )
        except Exception:
            # A Telegram edit must not undo a durable decision or prevent execution.
            pass

    def callback(self, callback: dict[str, Any]) -> dict[str, Any]:
        data = callback.get("data", "")
        match = (
            re.fullmatch(r"(approve|cancel):([a-f0-9]{32})", data)
            if isinstance(data, str)
            else None
        )
        sender = callback.get("from", {})
        message = callback.get("message", {})
        if (
            match is None
            or type(sender.get("id")) is not int
            or sender["id"] != OPERATOR_ID
            or sender.get("is_bot") is not False
        ):
            return {"accepted": False}
        identifier = match[2]
        with self.lock:
            try:
                row = self._row(identifier)
            except ApprovalError:
                return {"accepted": False}
            if (
                message.get("chat", {}).get("id") != row["chat_id"]
                or message.get("message_id") != row["message_id"]
            ):
                return {"accepted": False}
            if row["state"] != "pending":
                return {"accepted": False, "state": row["state"]}
            if row["created"] + 3600 <= time.time():
                self._update(identifier, state="expired")
                return {"accepted": False, "state": "expired"}
            if match[1] == "cancel":
                self._update(identifier, state="cancelled")
                self._mark_decision(row, approved=False)
            else:
                self._update(identifier, state="executing")
                self._mark_decision(row, approved=True)
                threading.Thread(target=self._execute, args=(identifier,), daemon=True).start()
            return {"accepted": True, "state": self._row(identifier)["state"]}
